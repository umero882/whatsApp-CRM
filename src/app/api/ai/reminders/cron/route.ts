import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

/**
 * Drain due `ai_scheduled_reminders` rows. Hit by an external pinger
 * (Vercel Cron / GitHub Actions / a monitoring VPS) on a 1-minute
 * schedule. Auth via the same `AUTOMATION_CRON_SECRET` env var the
 * other cron routes already use — operators provision one secret.
 *
 * Sends each due reminder as a WhatsApp text from the owner-user's
 * configured Meta number, then persists the message into the same
 * conversation so it appears in the inbox alongside human/AI traffic.
 *
 * Failures bump retry_count; after 3 failures the row is marked
 * 'failed' so we don't loop forever. (Surfacing failed reminders to
 * the inbox is a V3 concern.)
 */

const MAX_RETRIES = 3;
const BATCH_SIZE = 50;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const now = new Date().toISOString();

  // Pull due rows. Service role bypasses RLS.
  const { data: due, error: dueErr } = await admin
    .from('ai_scheduled_reminders')
    .select('id, user_id, conversation_id, recipient_phone, message_text, retry_count')
    .eq('status', 'pending')
    .lte('due_at', now)
    .order('due_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (dueErr) {
    console.error('[ai-reminders-cron] scan failed:', dueErr.message);
    return NextResponse.json({ error: dueErr.message }, { status: 500 });
  }
  if (!due?.length) return NextResponse.json({ sent: 0 });

  // Group by user_id so we fetch each user's WhatsApp config once.
  const byUser = new Map<string, typeof due>();
  for (const r of due) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }

  let sent = 0;
  let failed = 0;

  for (const [userId, items] of byUser) {
    const { data: cfg } = await admin
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('user_id', userId)
      .maybeSingle();
    if (!cfg) {
      console.warn('[ai-reminders-cron] no WhatsApp config for user', userId);
      // Mark all of this user's reminders as failed.
      for (const item of items) {
        await markFailed(admin, item.id, item.retry_count, 'no_whatsapp_config');
        failed += 1;
      }
      continue;
    }
    let accessToken: string;
    try {
      accessToken = decrypt(cfg.access_token);
    } catch (e) {
      console.warn('[ai-reminders-cron] decrypt failed for user', userId, e);
      for (const item of items) {
        await markFailed(admin, item.id, item.retry_count, 'access_token_decrypt_failed');
        failed += 1;
      }
      continue;
    }

    for (const item of items) {
      try {
        const toPhone = sanitizePhoneForMeta(item.recipient_phone);
        const r = await sendTextMessage({
          phoneNumberId: cfg.phone_number_id,
          accessToken,
          to: toPhone,
          text: item.message_text,
        });
        // Persist the reminder message into the conversation if linked.
        if (item.conversation_id) {
          await admin.from('messages').insert({
            conversation_id: item.conversation_id,
            sender_type: 'agent',
            agent_kind: 'ai',
            content_type: 'text',
            content_text: item.message_text,
            message_id: r.messageId,
            status: 'sent',
          });
          await admin
            .from('conversations')
            .update({
              last_message_text: item.message_text,
              last_message_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', item.conversation_id);
        }
        await admin
          .from('ai_scheduled_reminders')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', item.id)
          .eq('status', 'pending'); // guard against double-sends
        sent += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[ai-reminders-cron] send failed for', item.id, msg);
        await markFailed(admin, item.id, item.retry_count, msg);
        failed += 1;
      }
    }
  }

  return NextResponse.json({ sent, failed, processed: due.length });
}

async function markFailed(
  admin: ReturnType<typeof supabaseAdmin>,
  id: string,
  prevRetries: number,
  reason: string,
): Promise<void> {
  const next = prevRetries + 1;
  const giveUp = next >= MAX_RETRIES;
  await admin
    .from('ai_scheduled_reminders')
    .update({
      retry_count: next,
      failed_reason: reason.slice(0, 500),
      status: giveUp ? 'failed' : 'pending',
    })
    .eq('id', id);
}
