import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory stand-in for the three tables the module touches. Every
// query chain the code builds resolves against these arrays.
const h = vi.hoisted(() => {
  const state = {
    contacts: [] as Array<{ id: string; user_id: string; phone: string; name: string | null; email?: string | null }>,
    conversations: [] as Array<{ id: string; user_id: string; contact_id: string; channel: string }>,
    messages: [] as Array<{ id: string; conversation_id: string; sender_type: string }>,
    templates: [] as Array<{ user_id: string; name: string; language: string; status: string }>,
    inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
    send: vi.fn(),
  };
  return { state };
});

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const s = h.state;
      if (table === "contacts") {
        return {
          select: () => ({ eq: async (_k: string, uid: string) => ({ data: s.contacts.filter((c) => c.user_id === uid) }) }),
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const created = { id: `ct-${s.contacts.length + 1}`, ...row } as (typeof s.contacts)[number];
                s.contacts.push(created);
                s.inserted.push({ table, row });
                return { data: created };
              },
            }),
          }),
        };
      }
      if (table === "conversations") {
        return {
          select: () => ({
            eq: (_k: string, uid: string) => ({
              eq: (_k2: string, contactId: string) => ({
                maybeSingle: async () => ({ data: s.conversations.find((c) => c.user_id === uid && c.contact_id === contactId) ?? null }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const created = { id: `cv-${s.conversations.length + 1}`, ...row } as (typeof s.conversations)[number];
                s.conversations.push(created);
                s.inserted.push({ table, row });
                return { data: created };
              },
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          select: () => ({
            eq: (_k: string, conversationId: string) => ({
              limit: async () => ({ data: s.messages.filter((m) => m.conversation_id === conversationId).slice(0, 1) }),
            }),
          }),
        };
      }
      if (table === "message_templates") {
        return {
          select: () => ({
            eq: (_k: string, uid: string) => ({
              eq: async (_k2: string, name: string) => ({ data: s.templates.filter((t) => t.user_id === uid && t.name === name) }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/whatsapp/send-message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/send-message")>();
  return { ...actual, sendConversationMessage: h.state.send };
});

import { OutreachError, sendOutreach } from "./whatsapp";
import { SendError } from "@/lib/whatsapp/send-message";

beforeEach(() => {
  h.state.contacts.length = 0;
  h.state.conversations.length = 0;
  h.state.messages.length = 0;
  h.state.inserted.length = 0;
  h.state.templates.length = 0;
  h.state.templates.push({ user_id: "owner-1", name: "ad_reply", language: "en_US", status: "approved" });
  h.state.templates.push({ user_id: "owner-1", name: "ad_reply", language: "ar", status: "approved" });
  h.state.templates.push({ user_id: "owner-1", name: "ad_reply_v2", language: "en_US", status: "pending" });
  h.state.send.mockReset();
  h.state.send.mockResolvedValue({ crmMessageId: "m-1", waMessageId: "wa-1" });
});

describe("sendOutreach", () => {
  it("creates the contact and the conversation, sends the template, and never pauses the agent", async () => {
    const result = await sendOutreach({
      userId: "owner-1",
      phone: "+971 50 123 4567",
      name: "Family in Al Shamkha",
      templateName: "ad_reply",
      templateLanguage: "en_US",
      templateParams: ["Al Shamkha"],
    });
    expect(result).toEqual({
      contactId: "ct-1",
      conversationId: "cv-1",
      crmMessageId: "m-1",
      waMessageId: "wa-1",
      contactCreated: true,
      conversationCreated: true,
    });
    expect(h.state.inserted[0]).toEqual({
      table: "contacts",
      row: { user_id: "owner-1", phone: "+971501234567", name: "Family in Al Shamkha" },
    });
    expect(h.state.inserted[1]).toEqual({
      table: "conversations",
      row: { user_id: "owner-1", contact_id: "ct-1", channel: "whatsapp" },
    });
    expect(h.state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        conversationId: "cv-1",
        messageType: "template",
        templateName: "ad_reply",
        templateLanguage: "en_US",
        templateParams: ["Al Shamkha"],
        pauseAi: false,
      }),
    );
  });

  it("reuses a contact whose number matches with or without the trunk zero", async () => {
    h.state.contacts.push({ id: "ct-9", user_id: "owner-1", phone: "9710501234567", name: "Known" });
    const result = await sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "ad_reply" });
    expect(result.contactId).toBe("ct-9");
    expect(result.contactCreated).toBe(false);
    expect(result.conversationCreated).toBe(true);
  });

  it("refuses a number that already talks to the business", async () => {
    h.state.contacts.push({ id: "ct-9", user_id: "owner-1", phone: "+971501234567", name: "Customer" });
    h.state.conversations.push({ id: "cv-9", user_id: "owner-1", contact_id: "ct-9", channel: "whatsapp" });
    h.state.messages.push({ id: "m-9", conversation_id: "cv-9", sender_type: "customer" });
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "ad_reply" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("a customer, not a prospect"),
    });
    expect(h.state.send).not.toHaveBeenCalled();
  });

  it("refuses a second outreach to the same number unless told otherwise", async () => {
    h.state.contacts.push({ id: "ct-9", user_id: "owner-1", phone: "+971501234567", name: "Prospect" });
    h.state.conversations.push({ id: "cv-9", user_id: "owner-1", contact_id: "ct-9", channel: "whatsapp" });
    h.state.messages.push({ id: "m-9", conversation_id: "cv-9", sender_type: "agent" });
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "ad_reply" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already written to once"),
    });
    const again = await sendOutreach({ userId: "owner-1", phone: "+971501234567", text: "Following up", allowExisting: true });
    expect(again.conversationId).toBe("cv-9");
    expect(h.state.send).toHaveBeenCalledWith(expect.objectContaining({ messageType: "text", contentText: "Following up" }));
  });

  it("takes the template's language from the catalog and refuses one that is not approved", async () => {
    await sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "ad_reply" });
    expect(h.state.send).toHaveBeenLastCalledWith(expect.objectContaining({ templateLanguage: "en_US" }));
    await sendOutreach({ userId: "owner-1", phone: "+971501234568", templateName: "ad_reply", templateLanguage: "ar" });
    expect(h.state.send).toHaveBeenLastCalledWith(expect.objectContaining({ templateLanguage: "ar" }));
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234569", templateName: "ad_reply", templateLanguage: "fr" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("no approved fr version"),
    });
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234569", templateName: "ad_reply_v2" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not approved yet"),
    });
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234569", templateName: "nope" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("not in the catalog"),
    });
  });

  it("validates the phone and demands a template or text", async () => {
    await expect(sendOutreach({ userId: "owner-1", phone: "12", templateName: "x" })).rejects.toBeInstanceOf(OutreachError);
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234567" })).rejects.toMatchObject({ status: 400 });
    expect(h.state.send).not.toHaveBeenCalled();
  });

  it("carries a Meta refusal through as an OutreachError with its status", async () => {
    h.state.send.mockRejectedValue(new SendError("Meta API error: template not found", 502));
    await expect(sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "ad_reply" })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("template not found"),
    });
  });
});
