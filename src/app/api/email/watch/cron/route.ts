import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getRefreshToken } from '@/lib/email/oauth';
import { makeGmailClient } from '@/lib/email/gmail-client';

/**
 * Renews the Gmail `users.watch` push subscription (Gmail watches expire
 * after ~7 days) and refreshes the `email_sync_state.last_history_id`
 * cursor the pubsub webhook (`/api/email/pubsub`) needs to diff history.
 * Hit by an external pinger on a daily-ish schedule. Auth via the same
 * `AUTOMATION_CRON_SECRET` env var the other cron routes already use.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
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

  // Read env vars lazily (not at module scope) so tests that set them
  // per-case, and ops that rotate them without a redeploy, both work.
  const MAILBOX = process.env.EMAIL_MAILBOX ?? '';
  const TOPIC = process.env.EMAIL_PUBSUB_TOPIC ?? '';
  if (!TOPIC) {
    return NextResponse.json({ error: 'EMAIL_PUBSUB_TOPIC unset' }, { status: 503 });
  }

  const sb = supabaseAdmin();
  const client = makeGmailClient(await getRefreshToken(sb, MAILBOX));
  const { historyId, expiration } = await client.watch(TOPIC);

  await sb.from('email_sync_state').upsert(
    {
      mailbox: MAILBOX,
      last_history_id: historyId,
      watch_expiration: expiration ? new Date(Number(expiration)).toISOString() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'mailbox' },
  );

  return NextResponse.json({ ok: true, historyId, expiration });
}
