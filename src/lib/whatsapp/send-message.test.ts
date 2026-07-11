import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock state so the module mocks (evaluated before imports) can
// share a chainable Supabase stub and capture writes.
const h = vi.hoisted(() => {
  const sendText = vi.fn(async () => ({ messageId: "wa-1" }));
  const sendTemplate = vi.fn(async () => ({ messageId: "wa-tpl" }));

  const CONVERSATION = {
    id: "conv-1",
    user_id: "owner-1",
    contact: { id: "contact-1", phone: "+971500000000" },
  };
  const CONFIG = {
    id: "cfg-1",
    user_id: "owner-1",
    phone_number_id: "PNID",
    access_token: "enc-token",
  };

  const state = {
    agentEnabled: false,
    conversationMissing: false,
    conversationUpdatePayload: null as Record<string, unknown> | null,
    messageInsertPayload: null as Record<string, unknown> | null,
  };

  function resolveSingle(table: string, op: string) {
    if (table === "conversations") {
      return state.conversationMissing
        ? { data: null, error: { message: "not found" } }
        : { data: CONVERSATION, error: null };
    }
    if (table === "whatsapp_config") return { data: CONFIG, error: null };
    if (table === "messages" && op === "insert") {
      return { data: { id: "crm-1" }, error: null };
    }
    if (table === "messages") return { data: null, error: null }; // reply lookup
    if (table === "ai_agent_config") {
      return {
        data: { is_enabled: state.agentEnabled, human_pause_minutes: 30 },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const s = { op: "select" };
    const b: Record<string, unknown> = {
      select: vi.fn(() => b),
      insert: vi.fn((payload: Record<string, unknown>) => {
        s.op = "insert";
        if (table === "messages") state.messageInsertPayload = payload;
        return b;
      }),
      update: vi.fn((payload: Record<string, unknown>) => {
        s.op = "update";
        if (table === "conversations") state.conversationUpdatePayload = payload;
        return b;
      }),
      eq: vi.fn(() => b),
      single: vi.fn(() => Promise.resolve(resolveSingle(table, s.op))),
      maybeSingle: vi.fn(() => Promise.resolve(resolveSingle(table, s.op))),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(onF, onR),
    };
    return b;
  }

  return { sendText, sendTemplate, state, builder };
});

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: (t: string) => h.builder(t) }),
}));
vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: h.sendText,
  sendTemplateMessage: h.sendTemplate,
}));
vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
  isLegacyFormat: () => false,
}));

import { sendConversationMessage, SendError } from "./send-message";

beforeEach(() => {
  h.sendText.mockClear();
  h.sendTemplate.mockClear();
  h.state.agentEnabled = false;
  h.state.conversationMissing = false;
  h.state.conversationUpdatePayload = null;
  h.state.messageInsertPayload = null;
});

describe("sendConversationMessage", () => {
  it("sends a text message and returns both ids", async () => {
    const res = await sendConversationMessage({
      userId: "owner-1",
      conversationId: "conv-1",
      messageType: "text",
      contentText: "hi there",
    });
    expect(res).toEqual({ crmMessageId: "crm-1", waMessageId: "wa-1" });
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "PNID", to: "971500000000", text: "hi there" }),
    );
    // Human send → outbound agent message.
    expect(h.state.messageInsertPayload).toMatchObject({
      sender_type: "agent",
      content_type: "text",
      content_text: "hi there",
      message_id: "wa-1",
    });
  });

  it("does not pause the AI when the agent is disabled", async () => {
    h.state.agentEnabled = false;
    await sendConversationMessage({
      userId: "owner-1",
      conversationId: "conv-1",
      messageType: "text",
      contentText: "hi",
    });
    expect(h.state.conversationUpdatePayload).not.toHaveProperty("ai_paused_until");
  });

  it("pauses the AI when the agent is enabled", async () => {
    h.state.agentEnabled = true;
    await sendConversationMessage({
      userId: "owner-1",
      conversationId: "conv-1",
      messageType: "text",
      contentText: "hi",
    });
    expect(typeof h.state.conversationUpdatePayload?.ai_paused_until).toBe("string");
  });

  it("rejects a text send with no content", async () => {
    await expect(
      sendConversationMessage({
        userId: "owner-1",
        conversationId: "conv-1",
        messageType: "text",
      }),
    ).rejects.toBeInstanceOf(SendError);
  });

  it("throws 404 when the conversation is not found for the owner", async () => {
    h.state.conversationMissing = true;
    const err = await sendConversationMessage({
      userId: "owner-1",
      conversationId: "conv-1",
      messageType: "text",
      contentText: "hi",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.status).toBe(404);
  });
});
