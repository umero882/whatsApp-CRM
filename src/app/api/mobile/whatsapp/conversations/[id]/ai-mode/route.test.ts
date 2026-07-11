import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_MANUAL_SENTINEL } from "@/lib/mobile/serializers";

const h = vi.hoisted(() => {
  const state = {
    conversationOwned: true,
    updatePayload: null as Record<string, unknown> | null,
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: vi.fn(() => b),
      eq: vi.fn(() => b),
      update: vi.fn((payload: Record<string, unknown>) => {
        state.updatePayload = payload;
        return b;
      }),
      maybeSingle: vi.fn(() =>
        Promise.resolve({
          data: table === "conversations" && state.conversationOwned ? { id: "c1" } : null,
          error: null,
        }),
      ),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(onF, onR),
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

import { POST } from "./route";
import { verifyMobileAdmin } from "@/lib/mobile/auth";

const params = Promise.resolve({ id: "c1" });
const req = (body: unknown) =>
  new Request("https://crm.example/api/mobile/whatsapp/conversations/c1/ai-mode", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.mocked(verifyMobileAdmin).mockReset();
  vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
  h.state.conversationOwned = true;
  h.state.updatePayload = null;
});

describe("POST /api/mobile/whatsapp/conversations/:id/ai-mode", () => {
  it("manual → pauses with the far-future sentinel", async () => {
    const res = await POST(req({ mode: "manual" }), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, ai_active: false });
    expect(h.state.updatePayload?.ai_paused_until).toBe(AI_MANUAL_SENTINEL);
  });

  it("ai → clears the pause", async () => {
    const res = await POST(req({ mode: "ai" }), { params });
    const body = await res.json();
    expect(body).toEqual({ success: true, ai_active: true });
    expect(h.state.updatePayload?.ai_paused_until).toBeNull();
  });

  it("400s on an invalid mode", async () => {
    const res = await POST(req({ mode: "banana" }), { params });
    expect(res.status).toBe(400);
    expect(h.state.updatePayload).toBeNull();
  });

  it("404s when the conversation isn't the owner's", async () => {
    h.state.conversationOwned = false;
    const res = await POST(req({ mode: "manual" }), { params });
    expect(res.status).toBe(404);
  });
});
