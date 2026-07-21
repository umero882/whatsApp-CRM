import { describe, expect, it } from "vitest";
import {
  aiActive,
  roleForMessage,
  serializeConversation,
  serializeEmailConversation,
  serializeMessage,
} from "./serializers";

describe("roleForMessage", () => {
  it("maps customer → user", () => {
    expect(roleForMessage("customer", null)).toBe("user");
  });
  it("maps agent+human → admin", () => {
    expect(roleForMessage("agent", "human")).toBe("admin");
  });
  it("maps agent+ai → assistant", () => {
    expect(roleForMessage("agent", "ai")).toBe("assistant");
  });
  it("maps agent with no kind → admin (default human)", () => {
    expect(roleForMessage("agent", null)).toBe("admin");
  });
  it("maps bot → assistant", () => {
    expect(roleForMessage("bot", null)).toBe("assistant");
  });
});

describe("aiActive", () => {
  it("is active when no pause set", () => {
    expect(aiActive(null)).toBe(true);
  });
  it("is active when pause is in the past", () => {
    expect(aiActive("2000-01-01T00:00:00Z")).toBe(true);
  });
  it("is paused when pause is in the far future", () => {
    expect(aiActive("2999-01-01T00:00:00Z")).toBe(false);
  });
});

describe("serializeConversation", () => {
  it("flattens the contact and computes ai_active", () => {
    expect(
      serializeConversation({
        id: "c1",
        last_message_text: "hello",
        last_message_at: "2026-07-11T00:00:00Z",
        unread_count: 3,
        ai_paused_until: "2999-01-01T00:00:00Z",
        contact: { phone: "971500000000", name: "Alem" },
      }),
    ).toEqual({
      id: "c1",
      phone: "971500000000",
      name: "Alem",
      last_message_text: "hello",
      last_message_at: "2026-07-11T00:00:00Z",
      unread_count: 3,
      ai_active: false,
    });
  });

  it("tolerates a missing contact", () => {
    const out = serializeConversation({
      id: "c1",
      last_message_text: null,
      last_message_at: null,
      unread_count: null,
      ai_paused_until: null,
      contact: null,
    });
    expect(out.phone).toBe("");
    expect(out.unread_count).toBe(0);
    expect(out.ai_active).toBe(true);
  });
});

describe("serializeEmailConversation", () => {
  it("maps external_id → email and includes subject", () => {
    const dto = serializeEmailConversation({
      id: "c1", subject: "How do I register?", last_message_text: "hi",
      last_message_at: "2026-07-21T00:00:00Z", unread_count: 2, ai_paused_until: null,
      contact: { external_id: "jane@example.com", name: "Jane" },
    });
    expect(dto).toEqual({
      id: "c1", email: "jane@example.com", name: "Jane", subject: "How do I register?",
      last_message_text: "hi", last_message_at: "2026-07-21T00:00:00Z", unread_count: 2, ai_active: true,
    });
  });
});

describe("serializeMessage", () => {
  it("falls back to ai_media_summary for media-only inbound", () => {
    const out = serializeMessage({
      id: "m1",
      sender_type: "customer",
      agent_kind: null,
      content_text: null,
      content_type: "image",
      media_url: "https://x/y.jpg",
      ai_media_summary: "Passport photo for Alem",
      status: "delivered",
      created_at: "2026-07-11T00:00:00Z",
    });
    expect(out).toMatchObject({
      role: "user",
      text: "Passport photo for Alem",
      type: "image",
      ai_summary: "Passport photo for Alem",
    });
  });
});
