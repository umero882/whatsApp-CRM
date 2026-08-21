import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { makeHasuraClient } from '@/lib/ai/tools/hasura';
import { CARD_LANG, detectLanguage } from '@/lib/ai/agent';
import {
  ALERT_JOBS_GQL,
  ALERT_MAIDS_GQL,
  buildJobAlertWhere,
  buildMaidAlertWhere,
  buildMatchNotification,
  isMetaWindowClosedError,
  summarizeJobMatch,
  summarizeMaidMatch,
  type AlertJobRow,
  type AlertLanguage,
  type AlertMaidRow,
  type MatchCriteria,
  type MatchSide,
} from '@/lib/ai/matching';
import {
  buildReengageNudge,
  evaluateDormantConversation,
  REENGAGE_MAX_SILENCE_MS,
  REENGAGE_MIN_SILENCE_MS,
} from '@/lib/ai/reengage';
import { sendAppDownloadCard } from '@/lib/ai/tools/ethiopian-maids';

/**
 * Engagement cron — the proactive half of the AI agent. Hit by the
 * same external pinger as /api/ai/reminders/cron (recommended cadence:
 * every 15 minutes), auth via AUTOMATION_CRON_SECRET.
 *
 * Two sweeps per hit:
 *
 *   1. MATCH ALERTS (two-sided matching) — re-run each active
 *      ai_match_alerts saved search against Hasura; when NEW maids
 *      (sponsor side) or jobs (maid side) appeared since the alert's
 *      watermark, message the customer on WhatsApp. Outside Meta's
 *      24h window the free-form send fails with 131047 — we then fall
 *      back to the pre-approved REENGAGE_TEMPLATE_NAME template (no
 *      body params) when configured, else retry on a later sweep
 *      (3 strikes → status 'failed').
 *
 *   2. DORMANT NUDGES (re-engage) — conversations where the AI spoke
 *      last and the customer has been silent 6–23h get ONE gentle
 *      check-in per lull, deliberately inside the 24h window so the
 *      free-form send is legal. Guarded by conversations.last_reengage_at.
 *
 * Every send is persisted into messages/conversations so it shows up
 * in the inbox exactly like the rest of the AI traffic.
 */

const ALERT_BATCH = 25;
const ALERT_RECHECK_MINUTES = 30;
const ALERT_MAX_RETRIES = 3;
const ALERT_RESULT_LIMIT = 5;
const DORMANT_BATCH = 50;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Admin = ReturnType<typeof supabaseAdmin>;

interface UserSendConfig {
  phoneNumberId: string;
  accessToken: string;
  hasuraUrl: string | null;
  hasuraAdminSecret: string | null;
  businessName: string | null;
  agentEnabled: boolean;
}

/**
 * Per-user config loader with memo — one fetch per user per sweep.
 * Returns null when the user has no usable WhatsApp send credentials.
 */
async function loadUserConfig(
  admin: Admin,
  cache: Map<string, UserSendConfig | null>,
  userId: string,
): Promise<UserSendConfig | null> {
  if (cache.has(userId)) return cache.get(userId) ?? null;
  let cfg: UserSendConfig | null = null;
  try {
    const [{ data: wa }, { data: agent }] = await Promise.all([
      admin
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('user_id', userId)
        .maybeSingle(),
      admin
        .from('ai_agent_config')
        .select('is_enabled, business_name, hasura_url, encrypted_hasura_admin_secret')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);
    if (wa) {
      cfg = {
        phoneNumberId: wa.phone_number_id,
        accessToken: decrypt(wa.access_token),
        hasuraUrl: agent?.hasura_url ?? null,
        hasuraAdminSecret: agent?.encrypted_hasura_admin_secret
          ? decrypt(agent.encrypted_hasura_admin_secret)
          : null,
        businessName: agent?.business_name ?? null,
        agentEnabled: Boolean(agent?.is_enabled),
      };
    }
  } catch (e) {
    console.warn('[ai-engagement-cron] config load failed for user', userId,
      e instanceof Error ? e.message : e);
  }
  cache.set(userId, cfg);
  return cfg;
}

async function persistOutbound(
  admin: Admin,
  conversationId: string,
  text: string,
  messageId: string,
  templateName: string | null,
): Promise<void> {
  await admin.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'agent',
    agent_kind: 'ai',
    content_type: templateName ? 'template' : 'text',
    ...(templateName ? { template_name: templateName } : {}),
    content_text: text,
    message_id: messageId,
    status: 'sent',
  });
  await admin
    .from('conversations')
    .update({
      last_message_text: text.slice(0, 200),
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}

// ════════════════════════════════════════════════════════════════════
// Sweep 1 — match alerts
// ════════════════════════════════════════════════════════════════════

interface AlertRow {
  id: string;
  user_id: string;
  conversation_id: string;
  recipient_phone: string;
  side: MatchSide;
  criteria: MatchCriteria;
  language: AlertLanguage;
  last_notified_at: string | null;
  notify_count: number;
  max_notifications: number;
  retry_count: number;
  created_at: string;
  conversation:
    | { contact: { name: string | null }[] | { name: string | null } | null }[]
    | { contact: { name: string | null }[] | { name: string | null } | null }
    | null;
}

function alertContactName(row: AlertRow): string | null {
  const conv = Array.isArray(row.conversation) ? row.conversation[0] : row.conversation;
  const contact = Array.isArray(conv?.contact) ? conv?.contact[0] : conv?.contact;
  return contact?.name ?? null;
}

async function markAlertFailure(
  admin: Admin,
  alert: AlertRow,
  reason: string,
): Promise<void> {
  const next = alert.retry_count + 1;
  await admin
    .from('ai_match_alerts')
    .update({
      retry_count: next,
      last_error: reason.slice(0, 500),
      last_checked_at: new Date().toISOString(),
      ...(next >= ALERT_MAX_RETRIES ? { status: 'failed' } : {}),
    })
    .eq('id', alert.id);
}

async function sweepMatchAlerts(admin: Admin) {
  const nowIso = new Date().toISOString();

  // Expire first so stale alerts never send.
  await admin
    .from('ai_match_alerts')
    .update({ status: 'expired' })
    .eq('status', 'active')
    .lt('expires_at', nowIso);

  const recheckCutoff = new Date(Date.now() - ALERT_RECHECK_MINUTES * 60_000).toISOString();
  const { data: dueRaw, error: dueErr } = await admin
    .from('ai_match_alerts')
    .select('id, user_id, conversation_id, recipient_phone, side, criteria, language, last_notified_at, notify_count, max_notifications, retry_count, created_at, conversation:conversations(contact:contacts(name))')
    .eq('status', 'active')
    .or(`last_checked_at.is.null,last_checked_at.lt.${recheckCutoff}`)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(ALERT_BATCH);
  if (dueErr) {
    console.error('[ai-engagement-cron] alert scan failed:', dueErr.message);
    return { alerts_checked: 0, alerts_notified: 0, alerts_failed: 0, error: dueErr.message };
  }
  const due = (dueRaw ?? []) as unknown as AlertRow[];
  if (due.length === 0) return { alerts_checked: 0, alerts_notified: 0, alerts_failed: 0 };

  const configs = new Map<string, UserSendConfig | null>();
  let notified = 0;
  let failed = 0;

  for (const alert of due) {
    const cfg = await loadUserConfig(admin, configs, alert.user_id);
    if (!cfg || !cfg.hasuraUrl) {
      await markAlertFailure(admin, alert, cfg ? 'no_hasura_config' : 'no_whatsapp_config');
      failed += 1;
      continue;
    }
    // Operator switched the agent off → proactive messaging stops too.
    // Not a failure: stamp the check and leave the alert active.
    if (!cfg.agentEnabled) {
      await admin
        .from('ai_match_alerts')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('id', alert.id);
      continue;
    }

    try {
      const hasura = makeHasuraClient(cfg.hasuraUrl, cfg.hasuraAdminSecret);
      const watermark = alert.last_notified_at ?? alert.created_at;
      const criteria = (alert.criteria ?? {}) as MatchCriteria;

      let lines: string[] = [];
      if (alert.side === 'sponsor') {
        const data = await hasura.query<{ maid_profiles_public: AlertMaidRow[] }>(
          ALERT_MAIDS_GQL,
          { where: buildMaidAlertWhere(criteria, watermark), limit: ALERT_RESULT_LIMIT },
        );
        lines = (data.maid_profiles_public ?? []).map(summarizeMaidMatch);
      } else {
        const data = await hasura.query<{ jobs: AlertJobRow[] }>(
          ALERT_JOBS_GQL,
          { where: buildJobAlertWhere(criteria, watermark), limit: ALERT_RESULT_LIMIT },
        );
        lines = (data.jobs ?? []).map(summarizeJobMatch);
      }

      if (lines.length === 0) {
        await admin
          .from('ai_match_alerts')
          .update({ last_checked_at: new Date().toISOString() })
          .eq('id', alert.id);
        continue;
      }

      const message = buildMatchNotification({
        side: alert.side,
        language: alert.language,
        contactName: alertContactName(alert),
        lines,
      });
      const to = sanitizePhoneForMeta(alert.recipient_phone);

      let messageId = '';
      let usedTemplate: string | null = null;
      try {
        const r = await sendTextMessage({
          phoneNumberId: cfg.phoneNumberId,
          accessToken: cfg.accessToken,
          to,
          text: message,
        });
        messageId = r.messageId;
      } catch (sendErr) {
        const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        const templateName = process.env.REENGAGE_TEMPLATE_NAME;
        if (!isMetaWindowClosedError(msg) || !templateName) throw sendErr;
        // 24h window closed — fall back to the pre-approved (param-less)
        // re-engagement template.
        const r = await sendTemplateMessage({
          phoneNumberId: cfg.phoneNumberId,
          accessToken: cfg.accessToken,
          to,
          templateName,
          language: process.env.REENGAGE_TEMPLATE_LANG || 'en_US',
        });
        messageId = r.messageId;
        usedTemplate = templateName;
      }

      await persistOutbound(admin, alert.conversation_id, message, messageId, usedTemplate);

      const newCount = alert.notify_count + 1;
      await admin
        .from('ai_match_alerts')
        .update({
          notify_count: newCount,
          last_notified_at: new Date().toISOString(),
          last_checked_at: new Date().toISOString(),
          retry_count: 0,
          last_error: null,
          ...(newCount >= alert.max_notifications ? { status: 'notified_max' } : {}),
        })
        .eq('id', alert.id);
      notified += 1;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn('[ai-engagement-cron] alert failed', alert.id, reason);
      await markAlertFailure(admin, alert, reason);
      failed += 1;
    }
  }

  return { alerts_checked: due.length, alerts_notified: notified, alerts_failed: failed };
}

// ════════════════════════════════════════════════════════════════════
// Sweep 2 — dormant-funnel nudges
// ════════════════════════════════════════════════════════════════════

interface DormantConvRow {
  id: string;
  user_id: string;
  ai_paused_until: string | null;
  last_reengage_at: string | null;
  contact:
    | { name: string | null; phone: string | null }[]
    | { name: string | null; phone: string | null }
    | null;
}

/**
 * Has this conversation ever received the app download card? Matches
 * both the current summary row ("[Official app download card]") and the
 * older long-form rows, so pre-existing threads are not re-carded.
 */
async function conversationHasAppCard(admin: Admin, conversationId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .ilike('content_text', '%app download card%')
    .limit(1);
  // On a query error, assume it WAS sent — a missing card is a lesser
  // failure than spamming a customer who already has one.
  if (error) {
    console.warn('[ai-engagement-cron] card lookup failed for', conversationId, error.message);
    return true;
  }
  return (data ?? []).length > 0;
}

async function sweepDormantConversations(admin: Admin) {
  const now = Date.now();
  // Pre-filter on last_message_at: when the agent replied instantly (the
  // normal case) it approximates customer-silence; exact eligibility is
  // decided per-conversation from real message rows below.
  const { data: convRaw, error: convErr } = await admin
    .from('conversations')
    .select('id, user_id, ai_paused_until, last_reengage_at, contact:contacts(name, phone)')
    .eq('status', 'open')
    .gte('last_message_at', new Date(now - REENGAGE_MAX_SILENCE_MS).toISOString())
    .lte('last_message_at', new Date(now - REENGAGE_MIN_SILENCE_MS).toISOString())
    .limit(DORMANT_BATCH);
  if (convErr) {
    console.error('[ai-engagement-cron] dormant scan failed:', convErr.message);
    return { dormant_scanned: 0, nudges_sent: 0, error: convErr.message };
  }
  const convs = (convRaw ?? []) as unknown as DormantConvRow[];
  if (convs.length === 0) return { dormant_scanned: 0, nudges_sent: 0 };

  const configs = new Map<string, UserSendConfig | null>();
  let sent = 0;

  for (const conv of convs) {
    try {
      const cfg = await loadUserConfig(admin, configs, conv.user_id);
      if (!cfg || !cfg.agentEnabled) continue;
      const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
      if (!contact?.phone) continue;

      const { data: msgs } = await admin
        .from('messages')
        .select('sender_type, agent_kind, content_text, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(6);
      const history = msgs ?? [];
      const lastMsg = history[0];
      if (!lastMsg) continue;
      const lastCustomer = history.find((m) => m.sender_type === 'customer');

      const verdict = evaluateDormantConversation({
        now,
        lastMessageSender: lastMsg.sender_type === 'customer' ? 'customer' : 'agent',
        lastMessageAgentKind: lastMsg.sender_type === 'customer'
          ? null
          : ((lastMsg.agent_kind as 'human' | 'ai' | null) ?? 'human'),
        lastCustomerAt: lastCustomer ? new Date(lastCustomer.created_at).getTime() : null,
        aiPausedUntil: conv.ai_paused_until ? new Date(conv.ai_paused_until).getTime() : null,
        lastReengageAt: conv.last_reengage_at ? new Date(conv.last_reengage_at).getTime() : null,
      });
      if (!verdict.eligible) continue;

      const lang = CARD_LANG[detectLanguage(lastCustomer?.content_text ?? '')];

      // Dead-end recovery: the commonest way a conversation goes dormant
      // is that we asked "registered or new?" and the customer never
      // answered — so they left without ever seeing the app card. A bare
      // "just checking in" does nothing for them. Send the card WITH the
      // nudge so the dormant thread carries the actual next step.
      let cardSentWithNudge = false;
      if (!(await conversationHasAppCard(admin, conv.id))) {
        try {
          const res = (await sendAppDownloadCard.handler({ language: lang }, {
            supabase: admin,
            userId: conv.user_id,
            conversationId: conv.id,
            channel: 'whatsapp',
            contactPhone: contact.phone,
            contactName: contact.name ?? null,
            escalationPhone: null,
            hasuraUrl: null,
            hasuraAdminSecret: null,
            whatsapp: { phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken },
          })) as { ok?: boolean };
          cardSentWithNudge = res?.ok === true;
        } catch (e) {
          console.warn('[ai-engagement-cron] nudge card failed for', conv.id,
            e instanceof Error ? e.message : e);
        }
      }

      const nudge = buildReengageNudge(lang, contact.name ?? null, cfg.businessName, cardSentWithNudge);
      const r = await sendTextMessage({
        phoneNumberId: cfg.phoneNumberId,
        accessToken: cfg.accessToken,
        to: sanitizePhoneForMeta(contact.phone),
        text: nudge,
      });
      await persistOutbound(admin, conv.id, nudge, r.messageId, null);
      await admin
        .from('conversations')
        .update({ last_reengage_at: new Date().toISOString() })
        .eq('id', conv.id);
      sent += 1;
    } catch (e) {
      console.warn('[ai-engagement-cron] nudge failed for conversation', conv.id,
        e instanceof Error ? e.message : e);
    }
  }

  return { dormant_scanned: convs.length, nudges_sent: sent };
}

// ════════════════════════════════════════════════════════════════════
// Route
// ════════════════════════════════════════════════════════════════════

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const matches = await sweepMatchAlerts(admin);
  const dormant = await sweepDormantConversations(admin);
  return NextResponse.json({ ...matches, ...dormant });
}
