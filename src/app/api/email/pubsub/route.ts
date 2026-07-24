import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveOwnerUserId } from '@/lib/mobile/auth';
import { verifyPubSubPush } from '@/lib/email/oidc';
import { makeGmailClient } from '@/lib/email/gmail-client';
import { getRefreshToken } from '@/lib/email/oauth';
import { parseEmail, customerAddress } from '@/lib/email/parse';
import { shouldDropEmail, alreadyIngested } from '@/lib/email/filters';
import { isCustomerEmail } from '@/lib/email/relevance';
import { findOrCreateEmailContact, findOrCreateEmailConversation, insertInboundEmailMessage } from '@/lib/email/persist';
import { runAgent } from '@/lib/ai/agent';
import { makeProvider } from '@/lib/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAILBOX = process.env.EMAIL_MAILBOX ?? '';
const INGESTED_LABEL = 'AI-Ingested';

export async function POST(request: Request): Promise<Response> {
  if (!(await verifyPubSubPush(request)))
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const sb = supabaseAdmin();
  const ownerUserId = await resolveOwnerUserId();
  const client = makeGmailClient(await getRefreshToken(sb, MAILBOX));

  const { data: sync } = await sb.from('email_sync_state').select('last_history_id').eq('mailbox', MAILBOX).maybeSingle();
  const startHistoryId = sync?.last_history_id;
  if (!startHistoryId) return NextResponse.json({ error: 'no history cursor — run watch cron first' }, { status: 409 });

  const ids = await client.historyList(startHistoryId);
  let created = 0, dropped = 0, skipped = 0, errored = 0;

  // A cheap provider for the relevance gate (reuse ai_provider_config).
  const { data: prov } = await sb.from('ai_provider_config').select('provider, model, base_url, encrypted_api_key').eq('user_id', ownerUserId).maybeSingle();
  const { data: agentCfg } = await sb.from('ai_agent_config').select('hasura_url, encrypted_hasura_admin_secret').eq('user_id', ownerUserId).maybeSingle();

  for (const id of ids) {
    try {
      const { raw, threadId } = await client.getRaw(id);
      const parsed = await parseEmail(raw);
      const drop = shouldDropEmail(parsed);
      if (drop.drop) { dropped++; continue; }
      if (await alreadyIngested(sb, parsed.messageId)) { skipped++; continue; }

      // Relevance gate — needs a provider; if unavailable we cannot classify
      // relevance, so persist and let the agent answer/escalate.
      let isCustomer = true;
      if (prov) {
        const { decrypt } = await import('@/lib/whatsapp/encryption');
        const provider = makeProvider(prov.provider, { model: prov.model, apiKey: decrypt(prov.encrypted_api_key), baseUrl: prov.base_url ?? undefined });
        const gate = await isCustomerEmail({
          parsed, provider,
          hasuraUrl: agentCfg?.hasura_url ?? '',
          hasuraSecret: agentCfg?.encrypted_hasura_admin_secret ? (await import('@/lib/whatsapp/encryption')).decrypt(agentCfg.encrypted_hasura_admin_secret) : '',
        });
        isCustomer = gate.isCustomer;
      }
      if (!isCustomer) { await client.addLabel(id, 'Not-Customer'); skipped++; continue; }

      const contact = await findOrCreateEmailContact(sb, ownerUserId, customerAddress(parsed), parsed.fromName);
      const conv = await findOrCreateEmailConversation(sb, ownerUserId, contact.id, parsed.subject);
      const inserted = await insertInboundEmailMessage(sb, {
        conversationId: conv.id, text: parsed.text, messageId: parsed.messageId,
        threadId, references: parsed.references,
        headers: { from: parsed.fromEmail, to: parsed.toAddresses, subject: parsed.subject },
      });
      // A concurrent push already ingested this exact Message-ID (and dispatched
      // the agent). Skip — do NOT re-run the agent (double reply) or count it as
      // errored (which would hold the cursor).
      if (inserted.duplicate) { skipped++; continue; }
      await client.addLabel(id, INGESTED_LABEL);
      created++;
      // Fire-and-forget agent, exactly like the WhatsApp webhook.
      runAgent(conv.id).catch((e) => console.error('[email] runAgent failed', e));
    } catch (e) {
      // A Gmail 404 ("Requested entity was not found") is PERMANENT — the
      // message was deleted/moved and can never be fetched. Counting it as
      // `errored` would wedge the cursor forever (errored>0 blocks the advance
      // below), so every push would re-fetch the whole history and never make
      // progress. Treat it as a skip. Transient failures (429/5xx/network) still
      // fall through to `errored` and correctly hold the cursor for retry (I2).
      const status = (e as { code?: unknown; status?: unknown; response?: { status?: unknown } })?.code
        ?? (e as { status?: unknown })?.status
        ?? (e as { response?: { status?: unknown } })?.response?.status;
      const gone = status === 404 || /requested entity was not found/i.test((e as { message?: string })?.message ?? '');
      if (gone) {
        console.warn('[email] message gone (404), skipping', id);
        skipped++;
      } else {
        console.error('[email] message pipeline failed', id, e);
        errored++;
      }
    }
  }

  // Advance the cursor to the notification's historyId — but ONLY when every
  // message in this batch was handled cleanly. A hard failure (errored > 0)
  // means we must NOT move the cursor past the failed message, or it is
  // permanently dropped. Leaving the cursor in place makes the next Pub/Sub
  // push re-fetch from the same startHistoryId; already-succeeded messages
  // are safely re-skipped via the messages.message_id unique index /
  // alreadyIngested() dedup check, so retrying the whole batch is idempotent.
  if (errored === 0) {
    try {
      const body = await request.clone().json();
      const decoded = JSON.parse(Buffer.from(body?.message?.data ?? '', 'base64').toString('utf8'));
      if (decoded?.historyId)
        await sb.from('email_sync_state').update({ last_history_id: String(decoded.historyId), updated_at: new Date().toISOString() }).eq('mailbox', MAILBOX);
    } catch { /* non-fatal */ }
  }

  return NextResponse.json({ processed: ids.length, created, dropped, skipped, errored });
}
