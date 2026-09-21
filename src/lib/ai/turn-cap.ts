/**
 * Per-conversation spend cap for the AI agent.
 *
 * Every inbound customer message can trigger a full LLM turn with tools
 * (model call + Hasura queries + KB search). Nothing else bounds how often
 * one WhatsApp number can do that, so a single sender looping messages —
 * by hand or by script — bills an unbounded number of agent runs to the
 * operator's provider key. This caps agent replies per conversation per
 * rolling hour; the customer still gets a human via the inbox.
 *
 * Counts `agent_kind = 'ai'` rows, i.e. only what the agent itself wrote:
 * human replies from the inbox and template sends never eat into the cap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_AGENT_TURNS_PER_HOUR = 30;
const WINDOW_MS = 60 * 60 * 1000;

/** `AGENT_TURNS_PER_HOUR` env override; falls back to the default when unset or not a positive integer. */
export function agentTurnsPerHour(
  raw: string | undefined = process.env.AGENT_TURNS_PER_HOUR,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_AGENT_TURNS_PER_HOUR;
}

/**
 * The slice of the client this touches. Kept as a documented shape for the
 * test stub; the real parameter is `SupabaseClient` because TypeScript cannot
 * structurally compare the deeply generic query builder against a narrow
 * interface without hitting TS2589.
 */
export interface TurnCountClient {
  from(table: "messages"): {
    select(
      columns: string,
      opts: { count: "exact"; head: true },
    ): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          gte(column: string, value: string): PromiseLike<{ count: number | null; error: { message: string } | null }>;
        };
      };
    };
  };
}

/**
 * True when the conversation has already had `cap` agent replies in the
 * last hour. A counting error is treated as "not over the cap" — a
 * database hiccup must not silence the agent for everyone.
 */
export async function isOverTurnCap(
  sb: SupabaseClient,
  conversationId: string,
  cap: number = agentTurnsPerHour(),
  now: number = Date.now(),
): Promise<boolean> {
  const since = new Date(now - WINDOW_MS).toISOString();
  const { count, error } = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("agent_kind", "ai")
    .gte("created_at", since);
  if (error) {
    console.error("[ai-agent] turn-cap count failed:", error.message);
    return false;
  }
  return (count ?? 0) >= cap;
}
