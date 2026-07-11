import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    conversationOwned: true,
    messages: { data: [] as unknown[], error: null as unknown },
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: vi.fn(() => b),
      eq: vi.fn(() => b),
      order: vi.fn(() => b),
      limit: vi.fn(() => b),
      maybeSingle: vi.fn(() =>
        Promise.resolve({
          data: table === "conversations" && state.conversationOwned ? { id: "c1" } : null,
          error: null,
        }),
      ),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(state.messages).then(onF, onR),
    };
    return b;
  }
  return { state, builder };
});

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: (t: string) => h.builder(t) }),
}));
vi.mock("@/lib/mobile/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile/auth")>();
  return { ...actual, verifyMobileAdmin: vi.fn() };
});

import { GET } from "./route";
import { verifyMobileAdmin } from "@/lib/mobile/auth";

const params = Promise.resolve({ id: "c1" });
const req = () =>
  new Request("https://crm.example/api/mobile/whatsapp/conversations/c1/messages", {
    headers: { authorization: "Bearer x" },
  });

beforeEach(() => {
  vi.mocked(verifyMobileAdmin).mockReset();
  vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
  h.state.conversationOwned = true;
  h.state.messages = { data: [], error: null };
});

describe("GET /api/mobile/whatsapp/conversations/:id/messages", () => {
  it("404s when the conversation is not owned by the tenant", async () => {
    h.state.conversationOwned = false;
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });

  it("returns thread messages in ascending display order (newest fetched first, reversed)", async () => {
    // The route queries newest-first (descending) then reverses. Mirror that:
    // the mock returns descending, the response must be ascending.
    h.state.messages = {
      error: null,
      data: [
        {
          id: "m2",
          sender_type: "agent",
          agent_kind: "ai",
          content_text: "hello!",
          content_type: "text",
          media_url: null,
          ai_media_summary: null,
          status: "sent",
          created_at: "2026-07-11T00:01:00Z",
        },
        {
          id: "m1",
          sender_type: "customer",
          agent_kind: null,
          content_text: "hi",
          content_type: "text",
          media_url: null,
          ai_media_summary: null,
          status: "read",
          created_at: "2026-07-11T00:00:00Z",
        },
      ],
    };
    const res = await GET(req(), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });
});
