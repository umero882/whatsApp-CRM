import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/**
 * App-card coverage stats — read-only observability for the fix shipped
 * 2026-08-22 (see supabase/migrations/024_ai_agent_failures.sql).
 *
 * Background: an audit of 58 production conversations found the app
 * download card was sent on the FIRST agent reply exactly zero times —
 * the model always asked "registered or new?" first, and ~30% of
 * customers never answered, so they never saw the card at all. The card
 * is now sent server-side by shouldForceAppCard(). This route answers
 * "is that actually landing?" without anyone needing DB credentials.
 *
 * Auth: the same AUTOMATION_CRON_SECRET / x-cron-secret header used by
 * the other cron routes, compared in constant time. Deliberately NOT
 * public — the counts leak message volume.
 *
 * Read-only: this route never writes. Safe to poll.
 */

/** Rows scanned. Comfortably above current volume; caps a runaway query. */
const SCAN_LIMIT = 5000;

const CARD_MARKER = '%app download card%';

interface MessageRow {
  conversation_id: string;
  sender_type: string;
  agent_kind: string | null;
  content_text: string | null;
  created_at: string;
}

const isCard = (t: string | null) => !!t && /app download card/i.test(t);

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
  const sinceDays = Math.min(
    Math.max(Number(new URL(request.url).searchParams.get('days')) || 14, 1),
    90,
  );
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  // ─── Cards per day ──────────────────────────────────────────────────
  const { data: cardRows, error: cardErr } = await admin
    .from('messages')
    .select('created_at')
    .ilike('content_text', CARD_MARKER)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SCAN_LIMIT);
  if (cardErr) {
    return NextResponse.json({ error: `cards query: ${cardErr.message}` }, { status: 500 });
  }
  const perDay = new Map<string, number>();
  for (const r of cardRows ?? []) {
    const day = String(r.created_at).slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const cards_per_day = [...perDay.entries()]
    .map(([day, cards]) => ({ day, cards }))
    .sort((x, y) => (x.day < y.day ? 1 : -1));

  // ─── Turn-1 rate ────────────────────────────────────────────────────
  // The headline number: of conversations started in the window, how
  // many got the card on the agent's FIRST reply? This was 0/58 before
  // the fix. Anything near zero means the fix regressed.
  const { data: msgRows, error: msgErr } = await admin
    .from('messages')
    .select('conversation_id, sender_type, agent_kind, content_text, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(SCAN_LIMIT);
  if (msgErr) {
    return NextResponse.json({ error: `messages query: ${msgErr.message}` }, { status: 500 });
  }
  const byConv = new Map<string, MessageRow[]>();
  for (const m of (msgRows ?? []) as MessageRow[]) {
    const list = byConv.get(m.conversation_id);
    if (list) list.push(m);
    else byConv.set(m.conversation_id, [m]);
  }
  let convos = 0;
  let carded_on_first_reply = 0;
  let carded_at_all = 0;
  let triage_dead_ends = 0;
  for (const ms of byConv.values()) {
    const firstAgent = ms.find((m) => m.sender_type === 'agent' && m.agent_kind === 'ai');
    if (!firstAgent) continue;
    convos += 1;
    if (isCard(firstAgent.content_text)) carded_on_first_reply += 1;
    const cardIdx = ms.findIndex((m) => isCard(m.content_text));
    if (cardIdx >= 0) carded_at_all += 1;
    else {
      // Asked the triage question, customer never replied, no card —
      // the exact dead end the fix exists to eliminate.
      const tIdx = ms.findIndex(
        (m) => m.sender_type === 'agent' && /registered with us|Existing customer/i.test(m.content_text ?? ''),
      );
      if (tIdx >= 0 && !ms.slice(tIdx + 1).some((m) => m.sender_type === 'customer')) {
        triage_dead_ends += 1;
      }
    }
  }

  // ─── Agent failures by reason ───────────────────────────────────────
  // Tolerates the table being absent (migration 024 not yet applied).
  let failures: Array<{ reason: string; n: number }> = [];
  let failures_error: string | null = null;
  const { data: failRows, error: failErr } = await admin
    .from('ai_agent_failures')
    .select('reason, stage')
    .gte('created_at', since)
    .limit(SCAN_LIMIT);
  if (failErr) {
    failures_error = failErr.message;
  } else {
    const byReason = new Map<string, number>();
    for (const f of failRows ?? []) {
      // Collapse provider errors so "provider: OpenAI 429" x40 is one
      // row, not forty — the status code is the signal, not the text.
      const raw = String(f.reason ?? 'unknown');
      const key = raw.startsWith('provider:') ? raw.split('(')[0].trim().slice(0, 60) : raw;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    failures = [...byReason.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((x, y) => y.n - x.n);
  }

  return NextResponse.json({
    window_days: sinceDays,
    since,
    cards_per_day,
    turn1_rate: { convos, carded_on_first_reply, carded_at_all, triage_dead_ends },
    failures,
    failures_error,
    truncated: (msgRows?.length ?? 0) >= SCAN_LIMIT,
  });
}
