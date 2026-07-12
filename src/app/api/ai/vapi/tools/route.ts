import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { makeHasuraClient } from '@/lib/ai/tools/hasura';
import { searchKb } from '@/lib/ai/kb';
import { notifyAdminOfEscalation } from '@/lib/ai/escalation-notify';
import {
  ALERT_MAIDS_GQL,
  buildMaidAlertWhere,
  normalizeAlertCriteria,
  summarizeMaidMatch,
  type AlertMaidRow,
} from '@/lib/ai/matching';
import {
  formatCallLogMessage,
  parseVapiEndOfCall,
  parseVapiToolCalls,
  speakableKbAnswer,
  vapiResult,
} from '@/lib/ai/vapi-tools';

/**
 * Vapi server-tools endpoint — voice-Lucy's bridge into the CRM.
 * Auth: x-vapi-secret header must equal VAPI_TOOLS_SECRET (set the
 * same value as the assistant's server.secret in Vapi).
 *
 * Tools served:
 *   search_knowledge_base(query)          — same RAG store as chat
 *   search_maids(criteria…)               — live candidate search
 *   request_human_callback(reason, name?) — notify the admin app
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Persist a finished voice call into the caller's conversation so calls
 * and chats share one timeline. Caller matching is by phone-digit
 * suffix (WhatsApp calls arrive from the same number the customer
 * chats from); unknown callers get a fresh contact + conversation.
 * Idempotent per Vapi call id (message_id = "vapi:<callId>").
 */
async function logCallToInbox(report: import('@/lib/ai/vapi-tools').VapiCallReport): Promise<void> {
  const sb = supabaseAdmin();
  const messageId = `vapi:${report.callId}`;

  // Dedupe — Vapi retries webhooks.
  const { data: dupe } = await sb
    .from('messages')
    .select('id')
    .eq('message_id', messageId)
    .maybeSingle();
  if (dupe) return;

  const { data: owner } = await sb
    .from('whatsapp_config')
    .select('user_id')
    .limit(1)
    .maybeSingle();
  if (!owner) return;

  // Match the caller to an existing contact by last-8-digit suffix.
  let contactId: string | null = null;
  let conversationId: string | null = null;
  if (report.callerDigits) {
    const suffix = report.callerDigits.slice(-8);
    const { data: contact } = await sb
      .from('contacts')
      .select('id')
      .eq('user_id', owner.user_id)
      .like('phone', `%${suffix}`)
      .limit(1)
      .maybeSingle();
    contactId = contact?.id ?? null;
  }
  if (!contactId) {
    const phone = report.callerDigits ? `+${report.callerDigits}` : `voice:${report.callId.slice(0, 8)}`;
    const { data: created } = await sb
      .from('contacts')
      .insert({
        user_id: owner.user_id,
        phone,
        name: report.callerDigits ? `Voice caller ${phone}` : 'Voice caller',
      })
      .select('id')
      .single();
    contactId = created?.id ?? null;
  }
  if (!contactId) return;

  const { data: conv } = await sb
    .from('conversations')
    .select('id')
    .eq('user_id', owner.user_id)
    .eq('contact_id', contactId)
    .maybeSingle();
  conversationId = conv?.id ?? null;
  if (!conversationId) {
    const { data: newConv } = await sb
      .from('conversations')
      .insert({ user_id: owner.user_id, contact_id: contactId, channel: 'whatsapp' })
      .select('id')
      .single();
    conversationId = newConv?.id ?? null;
  }
  if (!conversationId) return;

  const text = formatCallLogMessage(report);
  await sb.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'customer',
    content_type: 'text',
    content_text: text,
    message_id: messageId,
    status: 'delivered',
  });
  await sb
    .from('conversations')
    .update({
      last_message_text: '📞 Voice call',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
}

export async function POST(request: Request) {
  const expected = process.env.VAPI_TOOLS_SECRET;
  if (!expected) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  const supplied = request.headers.get('x-vapi-secret') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const calls = parseVapiToolCalls(body);
  if (calls.length === 0) {
    // Not a tool call — maybe an end-of-call report worth logging into
    // the inbox. Everything else (status updates, live transcripts) is
    // acknowledged without action.
    const report = parseVapiEndOfCall(body);
    if (report) {
      try {
        await logCallToInbox(report);
      } catch (e) {
        console.warn('[vapi-tools] call log failed:', e instanceof Error ? e.message : e);
      }
    }
    return NextResponse.json({ ok: true });
  }

  const sb = supabaseAdmin();
  // Single-operator deployment: the owner is the (only) agent-config row.
  const { data: agent } = await sb
    .from('ai_agent_config')
    .select('user_id, hasura_url, encrypted_hasura_admin_secret')
    .limit(1)
    .maybeSingle();

  const results = [];
  for (const call of calls) {
    try {
      switch (call.name) {
        case 'search_knowledge_base': {
          const query = String(call.args.query ?? '').trim();
          if (!query || !agent) {
            results.push(vapiResult(call.id, 'Knowledge base unavailable — offer a human follow-up.'));
            break;
          }
          const hits = await searchKb(sb, agent.user_id, query, 3);
          results.push(vapiResult(call.id, speakableKbAnswer(hits)));
          break;
        }
        case 'search_maids': {
          if (!agent?.hasura_url) {
            results.push(vapiResult(call.id, 'Candidate search unavailable — offer a human follow-up.'));
            break;
          }
          const hasura = makeHasuraClient(
            agent.hasura_url,
            agent.encrypted_hasura_admin_secret ? decrypt(agent.encrypted_hasura_admin_secret) : null,
          );
          const criteria = normalizeAlertCriteria('sponsor', call.args);
          const data = await hasura.query<{ maid_profiles_public: AlertMaidRow[] }>(
            ALERT_MAIDS_GQL,
            { where: buildMaidAlertWhere(criteria, EPOCH), limit: 3 },
          );
          const rows = data.maid_profiles_public ?? [];
          results.push(vapiResult(
            call.id,
            rows.length === 0
              ? 'No matching candidates right now. Offer to note their requirements and have the team follow up on WhatsApp.'
              : `Describe these candidates briefly and conversationally (first names only):\n${rows.map(summarizeMaidMatch).join('\n')}\nOffer to send full profiles with photos on WhatsApp after the call.`,
          ));
          break;
        }
        case 'request_human_callback': {
          const reason = String(call.args.reason ?? 'caller requested human follow-up').slice(0, 200);
          const callerName = typeof call.args.caller_name === 'string' ? call.args.caller_name : null;
          const callerPhone = typeof call.args.caller_phone === 'string' ? call.args.caller_phone : 'unknown (voice call)';
          let notified = false;
          if (agent?.hasura_url) {
            try {
              const hasura = makeHasuraClient(
                agent.hasura_url,
                agent.encrypted_hasura_admin_secret ? decrypt(agent.encrypted_hasura_admin_secret) : null,
              );
              const r = await notifyAdminOfEscalation(hasura, {
                escalationPhone: process.env.ESCALATION_WHATSAPP_NUMBER || '971588767821',
                conversationId: 'voice-call',
                customerName: callerName,
                customerPhone: callerPhone,
                reason: `[VOICE CALL] ${reason}`,
                issueSummary: null,
                urgent: false,
                adminUidOverride: process.env.ESCALATION_ADMIN_UID ?? null,
              });
              notified = r.notified;
            } catch (e) {
              console.warn('[vapi-tools] callback notify failed:', e instanceof Error ? e.message : e);
            }
          }
          results.push(vapiResult(call.id, notified
            ? 'Callback request recorded and the team was notified. Tell the caller someone will contact them shortly.'
            : 'Callback request recorded. Tell the caller the team will follow up.'));
          break;
        }
        default:
          results.push(vapiResult(call.id, `Unknown tool "${call.name}".`));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[vapi-tools]', call.name, 'failed:', msg);
      results.push(vapiResult(call.id, 'Tool failed — apologize briefly and offer a human follow-up.'));
    }
  }

  return NextResponse.json({ results });
}
