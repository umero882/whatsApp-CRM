import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory stand-in for the three tables the module touches. Every
// query chain the code builds resolves against these arrays.
const h = vi.hoisted(() => {
  const state = {
    contacts: [] as Array<{ id: string; user_id: string; phone: string; name: string | null; email?: string | null }>,
    conversations: [] as Array<{ id: string; user_id: string; contact_id: string; channel: string }>,
    messages: [] as Array<{ id: string; conversation_id: string; sender_type: string }>,
    templates: [] as Array<{ user_id: string; name: string; language: string; status: string; body_text?: string }>,
    tags: [] as Array<{ id: string; user_id: string; name: string }>,
    contactTags: [] as Array<{ contact_id: string; tag_id: string }>,
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
      if (table === "tags") {
        return {
          select: () => ({ eq: async (_k: string, uid: string) => ({ data: s.tags.filter((t) => t.user_id === uid) }) }),
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const created = { id: `tag-${s.tags.length + 1}`, ...row } as (typeof s.tags)[number];
                s.tags.push(created);
                s.inserted.push({ table, row });
                return { data: created };
              },
            }),
          }),
        };
      }
      if (table === "contact_tags") {
        return {
          upsert: async (row: { contact_id: string; tag_id: string }) => {
            if (!s.contactTags.some((c) => c.contact_id === row.contact_id && c.tag_id === row.tag_id)) {
              s.contactTags.push(row);
            }
            s.inserted.push({ table, row });
            return { error: null };
          },
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
  h.state.tags.length = 0;
  h.state.contactTags.length = 0;
  // Statuses as the sync route stores them: capitalised.
  h.state.templates.push({
    user_id: "owner-1", name: "ad_reply", language: "en_US", status: "Approved",
    body_text: "Hello, we saw your ad for household help in {{1}}. Reply YES, or tell us what you need.",
  });
  h.state.templates.push({ user_id: "owner-1", name: "ad_reply", language: "ar", status: "Approved" });
  h.state.templates.push({ user_id: "owner-1", name: "ad_reply_v2", language: "en_US", status: "Pending" });
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
      tags: ["UAE"],  // the market, read from the template's city
    });
    expect(h.state.inserted[0]).toEqual({
      table: "contacts",
      row: { user_id: "owner-1", phone: "+971501234567", name: "Family in Al Shamkha" },
    });
    expect(h.state.inserted.find((i) => i.table === "conversations")).toEqual({
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
        contentText: "Hello, we saw your ad for household help in Al Shamkha. Reply YES, or tell us what you need.",
        pauseAi: false,
      }),
    );
  });

  it("tags the contact with its role and the caller's labels before sending, creating the tags once", async () => {
    h.state.tags.push({ id: "tag-old", user_id: "owner-1", name: "prospect" });
    const result = await sendOutreach({
      userId: "owner-1",
      phone: "+971501234567",
      name: "Family in Al Shamkha",
      templateName: "ad_reply",
      templateParams: ["Al Shamkha"],
      intent: "sponsor",
      tags: ["Prospect", "Mourjan"],
      country: "United Arab Emirates",
    });
    expect(result.tags).toEqual(["Sponsor", "UAE", "prospect", "Mourjan"]);
    // "Prospect" matched the existing tag regardless of case; the other three were created.
    expect(h.state.tags.map((t) => t.name)).toEqual(["prospect", "Sponsor", "UAE", "Mourjan"]);
    expect(h.state.contactTags).toEqual([
      { contact_id: "ct-1", tag_id: "tag-2" },
      { contact_id: "ct-1", tag_id: "tag-3" },
      { contact_id: "ct-1", tag_id: "tag-old" },
      { contact_id: "ct-1", tag_id: "tag-4" },
    ]);
    // Tagging happened before the send so a tagging fault never leaves a half-done contact.
    const order = h.state.inserted.map((i) => i.table);
    expect(order.indexOf("contact_tags")).toBeGreaterThan(-1);
    expect(h.state.send).toHaveBeenCalledTimes(1);

    // A job seeker gets the other role tag; no intent, no role tag.
    await sendOutreach({ userId: "owner-1", phone: "+971501234568", templateName: "ad_reply", intent: "job_seeker" });
    expect(h.state.tags.map((t) => t.name)).toContain("Job seeker");
    const before = h.state.contactTags.length;
    await sendOutreach({ userId: "owner-1", phone: "+971501234569", templateName: "ad_reply" });
    expect(h.state.contactTags.length).toBe(before);
  });

  it("reads the market from the caller's country, else the ad's city, else the name — or none", async () => {
    const one = await sendOutreach({ userId: "owner-1", phone: "+966501234567", templateName: "ad_reply", templateParams: ["Al Ahsa"], country: "Riyadh" });
    expect(one.tags).toEqual(["Saudi Arabia"]);
    const two = await sendOutreach({ userId: "owner-1", phone: "+966501234568", templateName: "ad_reply", templateParams: ["Al Ahsa"] });
    expect(two.tags).toEqual(["Saudi Arabia"]);
    const three = await sendOutreach({ userId: "owner-1", phone: "+965501234567", name: "Family in Kuwait", text: "Hi", allowExisting: true });
    expect(three.tags).toEqual(["Kuwait"]);
    const none = await sendOutreach({ userId: "owner-1", phone: "+971501234569", name: "Family (classifieds)", templateName: "ad_reply", templateParams: ["your area"] });
    expect(none.tags).toEqual([]);
  });

  it("refuses an unknown intent", async () => {
    await expect(
      sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "ad_reply", intent: "agency" as never }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("intent") });
    expect(h.state.send).not.toHaveBeenCalled();
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

  it("renders the catalog body with the parameters, leaving a missing one as its placeholder", async () => {
    h.state.templates.push({
      user_id: "owner-1", name: "two_vars", language: "en_US", status: "Approved",
      body_text: "Hi {{1}}, about {{2}}.",
    });
    await sendOutreach({ userId: "owner-1", phone: "+971501234567", templateName: "two_vars", templateParams: ["Sara"] });
    expect(h.state.send).toHaveBeenLastCalledWith(expect.objectContaining({ contentText: "Hi Sara, about {{2}}." }));
    // No body synced (an old catalog row): nothing invented.
    await sendOutreach({ userId: "owner-1", phone: "+971501234568", templateName: "ad_reply", templateLanguage: "ar" });
    expect(h.state.send).toHaveBeenLastCalledWith(expect.objectContaining({ contentText: null }));
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
