/**
 * Dormant-funnel re-engagement — pure logic for the engagement cron
 * (/api/ai/engagement/cron).
 *
 * A conversation is "dormant" when the agent spoke last and the
 * customer has been silent for 6–23 hours. We send ONE gentle nudge
 * per lull, deliberately INSIDE Meta's 24h customer-service window so
 * a free-form send is still legal (no template needed).
 *
 * `conversations.last_reengage_at` (migration 016) is the one-per-lull
 * guard: a nudge is only allowed when it predates the customer's
 * newest message.
 */

import type { AlertLanguage } from './matching';

/** Customer must have been silent at least this long before a nudge. */
export const REENGAGE_MIN_SILENCE_MS = 6 * 60 * 60 * 1000;
/**
 * ...and no longer than this — past 23h we treat Meta's 24h window as
 * closed (1h safety margin for cron cadence + clock skew).
 */
export const REENGAGE_MAX_SILENCE_MS = 23 * 60 * 60 * 1000;

export interface DormancyInput {
  /** Reference time (ms epoch) — pass Date.now() in production. */
  now: number;
  /** Sender of the newest message in the conversation. */
  lastMessageSender: 'customer' | 'agent';
  /** agent_kind of that newest message when it is agent-side. */
  lastMessageAgentKind: 'human' | 'ai' | null;
  /** Time (ms epoch) of the newest CUSTOMER message, if any. */
  lastCustomerAt: number | null;
  /** conversations.ai_paused_until as ms epoch, if set. */
  aiPausedUntil: number | null;
  /** conversations.last_reengage_at as ms epoch, if set. */
  lastReengageAt: number | null;
}

export type DormancyVerdict =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | 'customer_turn_pending'
        | 'human_owns_thread'
        | 'never_heard_from_customer'
        | 'too_recent'
        | 'window_closed'
        | 'ai_paused'
        | 'already_nudged';
    };

/**
 * Decide whether a conversation gets a dormant nudge. Deterministic —
 * the cron feeds it real rows; tests feed it a matrix.
 */
export function evaluateDormantConversation(input: DormancyInput): DormancyVerdict {
  // Customer spoke last — the AGENT owes a reply, not a nudge. (The
  // normal webhook-triggered agent run handles that path.)
  if (input.lastMessageSender === 'customer') {
    return { eligible: false, reason: 'customer_turn_pending' };
  }
  // A human wrote the last message — they own the thread; an AI nudge
  // on top would step on the human conversation.
  if (input.lastMessageAgentKind === 'human') {
    return { eligible: false, reason: 'human_owns_thread' };
  }
  if (input.lastCustomerAt === null) {
    return { eligible: false, reason: 'never_heard_from_customer' };
  }
  const silence = input.now - input.lastCustomerAt;
  if (silence < REENGAGE_MIN_SILENCE_MS) {
    return { eligible: false, reason: 'too_recent' };
  }
  if (silence > REENGAGE_MAX_SILENCE_MS) {
    return { eligible: false, reason: 'window_closed' };
  }
  if (input.aiPausedUntil !== null && input.aiPausedUntil > input.now) {
    return { eligible: false, reason: 'ai_paused' };
  }
  if (input.lastReengageAt !== null && input.lastReengageAt >= input.lastCustomerAt) {
    return { eligible: false, reason: 'already_nudged' };
  }
  return { eligible: true };
}

/**
 * The nudge itself. Side-agnostic (works for sponsors AND job seekers),
 * warm, one message, no pressure — the goal is simply a reply, which
 * reopens the 24h window and hands the thread back to the normal agent.
 */
export function buildReengageNudge(
  language: AlertLanguage,
  contactName: string | null,
  businessName: string | null,
): string {
  const name = contactName?.trim();
  const biz = businessName?.trim() || 'Ethiopian Maids';
  if (language === 'ar') {
    const greet = name ? `مرحباً ${name}! 👋` : 'مرحباً! 👋';
    return `${greet} أنا من ${biz} — ما زلت هنا إذا أحببت نكمل من حيث توقفنا. أي سؤال، فقط رد هنا 🌸`;
  }
  if (language === 'am') {
    const greet = name ? `ሰላም ${name}! 👋` : 'ሰላም! 👋';
    return `${greet} ከ${biz} ነኝ — ካቆምንበት መቀጠል ከፈለጉ አሁንም እዚህ ነኝ። ማንኛውም ጥያቄ ካለዎት እዚህ ይመልሱ 🌸`;
  }
  const greet = name ? `Hi ${name}! 👋` : 'Hi! 👋';
  return `${greet} Just checking in from ${biz} — I'm still here if you'd like to pick up where we left off. Any questions, just reply here 🌸`;
}
