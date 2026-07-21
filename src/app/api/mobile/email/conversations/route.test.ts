import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobile/auth", () => ({
  verifyMobileAdmin: async () => ({ userId: "owner-1", firebaseUid: "fb-1" }),
  mobileAuthErrorResponse: () => null,
}));

const range = vi.fn(async () => ({
  data: [
    {
      id: "c1",
      subject: "s",
      last_message_text: "hi",
      last_message_at: null,
      unread_count: 0,
      ai_paused_until: null,
      contact: { external_id: "jane@example.com", name: "Jane" },
    },
  ],
  count: 1,
  error: null,
}));
const order = vi.fn(() => ({ range }));
const eqChannel = vi.fn(() => ({ order }));
const eqUser = vi.fn(() => ({ eq: eqChannel }));
const select = vi.fn(() => ({ eq: eqUser }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: () => ({ select }) }),
}));

import { GET } from "./route";

describe("GET /api/mobile/email/conversations", () => {
  it("lists only email conversations, serialized", async () => {
    const res = await GET(new Request("http://x/api/mobile/email/conversations?limit=10"));
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.conversations[0]).toMatchObject({ id: "c1", email: "jane@example.com", subject: "s" });
    expect(eqChannel).toHaveBeenCalledWith("channel", "email");
  });
});
