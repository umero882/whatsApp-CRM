import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/lib/whatsapp/send-message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/send-message")>();
  return { ...actual, sendConversationMessage: h.send };
});
vi.mock("@/lib/mobile/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile/auth")>();
  return { ...actual, verifyMobileAdmin: vi.fn() };
});

import { POST } from "./route";
import { verifyMobileAdmin } from "@/lib/mobile/auth";
import { SendError } from "@/lib/whatsapp/send-message";

const params = Promise.resolve({ id: "c1" });
const req = (body: unknown) =>
  new Request("https://crm.example/api/mobile/whatsapp/conversations/c1/reply", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  h.send.mockReset();
  vi.mocked(verifyMobileAdmin).mockReset();
  vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
});

describe("POST /api/mobile/whatsapp/conversations/:id/reply", () => {
  it("sends and returns the message ids", async () => {
    h.send.mockResolvedValue({ crmMessageId: "crm-1", waMessageId: "wa-1" });
    const res = await POST(req({ text: "hello" }), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, message_id: "crm-1", whatsapp_message_id: "wa-1" });
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", conversationId: "c1", contentText: "hello" }),
    );
  });

  it("400s on empty text", async () => {
    const res = await POST(req({ text: "   " }), { params });
    expect(res.status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("passes through a SendError status (e.g. Meta 502)", async () => {
    h.send.mockRejectedValue(new SendError("Meta API error: nope", 502));
    const res = await POST(req({ text: "hi" }), { params });
    expect(res.status).toBe(502);
  });

  it("404s when the conversation isn't the owner's", async () => {
    h.send.mockRejectedValue(new SendError("Conversation not found", 404));
    const res = await POST(req({ text: "hi" }), { params });
    expect(res.status).toBe(404);
  });
});
