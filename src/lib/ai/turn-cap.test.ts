import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  agentTurnsPerHour,
  DEFAULT_AGENT_TURNS_PER_HOUR,
  isOverTurnCap,
  type TurnCountClient,
} from "./turn-cap";

function stub(result: { count: number | null; error: { message: string } | null }) {
  const calls: Record<string, unknown>[] = [];
  const shape: TurnCountClient = {
    from: (table) => ({
      select: (columns, opts) => ({
        eq: (c1, v1) => ({
          eq: (c2, v2) => ({
            gte: async (c3, v3) => {
              calls.push({ table, columns, opts, [c1]: v1, [c2]: v2, [c3]: v3 });
              return result;
            },
          }),
        }),
      }),
    }),
  };
  // The stub implements the documented slice; the function takes the full client type.
  return { sb: shape as unknown as SupabaseClient, calls };
}

describe("agentTurnsPerHour", () => {
  it("defaults when the env var is unset or junk", () => {
    expect(agentTurnsPerHour(undefined)).toBe(DEFAULT_AGENT_TURNS_PER_HOUR);
    expect(agentTurnsPerHour("")).toBe(DEFAULT_AGENT_TURNS_PER_HOUR);
    expect(agentTurnsPerHour("lots")).toBe(DEFAULT_AGENT_TURNS_PER_HOUR);
    expect(agentTurnsPerHour("0")).toBe(DEFAULT_AGENT_TURNS_PER_HOUR);
    expect(agentTurnsPerHour("-5")).toBe(DEFAULT_AGENT_TURNS_PER_HOUR);
  });

  it("honours a positive integer override", () => {
    expect(agentTurnsPerHour("12")).toBe(12);
  });
});

describe("isOverTurnCap", () => {
  const now = Date.parse("2026-09-22T10:00:00Z");

  it("counts only the agent's own replies in the last hour for that conversation", async () => {
    const { sb, calls } = stub({ count: 3, error: null });
    await isOverTurnCap(sb, "conv-1", 30, now);
    expect(calls).toEqual([
      {
        table: "messages",
        columns: "id",
        opts: { count: "exact", head: true },
        conversation_id: "conv-1",
        agent_kind: "ai",
        created_at: "2026-09-22T09:00:00.000Z",
      },
    ]);
  });

  it("is under the cap below the limit and over it at the limit", async () => {
    expect(await isOverTurnCap(stub({ count: 29, error: null }).sb, "c", 30, now)).toBe(false);
    expect(await isOverTurnCap(stub({ count: 30, error: null }).sb, "c", 30, now)).toBe(true);
    expect(await isOverTurnCap(stub({ count: 31, error: null }).sb, "c", 30, now)).toBe(true);
  });

  it("treats a null count as zero", async () => {
    expect(await isOverTurnCap(stub({ count: null, error: null }).sb, "c", 1, now)).toBe(false);
  });

  it("fails open on a counting error so a DB blip cannot mute the agent", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await isOverTurnCap(stub({ count: null, error: { message: "timeout" } }).sb, "c", 1, now),
    ).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
