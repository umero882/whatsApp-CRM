/**
 * Outreach: a first WhatsApp message to someone who is not a customer yet.
 *
 * The one caller today is PyRunner's Prospects screen (Email marketing
 * plugin): a family posted a classifieds ad asking for household help and
 * published a WhatsApp number on it; the reply — an approved template — goes
 * out through the CRM so the conversation exists in the inbox and the AI
 * agent answers whatever comes back. Nothing here pauses the agent.
 *
 * Guard rails, because the number this sends from is the business's support
 * line and Meta scores it on complaints:
 *   - one contact per phone (matched the way the webhook matches);
 *   - a phone that already has a conversation with an inbound message is a
 *     customer, not a prospect — refused with 409 unless `allowExisting`;
 *   - a phone that was already sent an outreach message is refused with 409
 *     (never twice), unless `allowExisting`;
 *   - the message is whatever the caller states: a template (required for a
 *     business-initiated conversation) or text (only inside a 24-hour
 *     customer-service window, which a prospect never has).
 *
 * Auth is the route's job; this module takes the resolved owner user id.
 */

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { sendConversationMessage, SendError } from "@/lib/whatsapp/send-message";
import { isValidE164, phonesMatch, sanitizePhoneForMeta } from "@/lib/whatsapp/phone-utils";

export class OutreachError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OutreachError";
    this.status = status;
  }
}

export interface OutreachParams {
  userId: string;
  /** E.164 or digits; "+971501234567" and "971501234567" are the same number. */
  phone: string;
  /** Shown in the inbox until the person tells us their name. */
  name?: string | null;
  email?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  /** Free text — only valid inside an open customer-service window. */
  text?: string | null;
  /** Let a second message reach a phone that already has a conversation. */
  allowExisting?: boolean;
}

export interface OutreachResult {
  contactId: string;
  conversationId: string;
  crmMessageId: string;
  waMessageId: string;
  contactCreated: boolean;
  conversationCreated: boolean;
}

interface ContactRow {
  id: string;
  phone: string;
  name: string | null;
  email?: string | null;
}

export async function sendOutreach(params: OutreachParams): Promise<OutreachResult> {
  const { userId, name, email, templateName, templateLanguage, templateParams, text, allowExisting } = params;
  const phone = sanitizePhoneForMeta(params.phone || "");
  if (!phone || !isValidE164("+" + phone)) {
    throw new OutreachError("phone must be a valid international number", 400);
  }
  if (!templateName && !(text && text.trim())) {
    throw new OutreachError("template_name or text is required", 400);
  }
  const db = supabaseAdmin();

  // The contact, matched the way the webhook matches (trunk-prefix tolerant).
  const { data: contacts, error: contactsError } = await db
    .from("contacts")
    .select("id, phone, name, email")
    .eq("user_id", userId);
  if (contactsError) {
    throw new OutreachError(`contacts lookup failed: ${contactsError.message}`, 500);
  }
  let contact = (contacts as ContactRow[] | null)?.find((c) => phonesMatch(c.phone, phone)) ?? null;
  let contactCreated = false;
  if (!contact) {
    const { data: created, error: createError } = await db
      .from("contacts")
      .insert({
        user_id: userId,
        phone: "+" + phone,
        name: (name || "").trim() || "+" + phone,
        ...(email ? { email } : {}),
      })
      .select("id, phone, name, email")
      .single();
    if (createError || !created) {
      throw new OutreachError(`contact could not be created: ${createError?.message ?? "unknown"}`, 500);
    }
    contact = created as ContactRow;
    contactCreated = true;
  }

  // The conversation — and whether this phone is already someone we talk to.
  const { data: existing, error: convError } = await db
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("contact_id", contact.id)
    .maybeSingle();
  if (convError) {
    throw new OutreachError(`conversation lookup failed: ${convError.message}`, 500);
  }
  let conversationId = existing?.id as string | undefined;
  let conversationCreated = false;
  if (conversationId && !allowExisting) {
    const { data: prior, error: priorError } = await db
      .from("messages")
      .select("id, sender_type")
      .eq("conversation_id", conversationId)
      .limit(1);
    if (priorError) {
      throw new OutreachError(`message lookup failed: ${priorError.message}`, 500);
    }
    if (prior && prior.length) {
      const inbound = prior.some((m: { sender_type: string }) => m.sender_type === "customer");
      throw new OutreachError(
        inbound
          ? "this number already talks to you — a customer, not a prospect"
          : "this number was already written to once",
        409,
      );
    }
  }
  if (!conversationId) {
    const { data: created, error: createError } = await db
      .from("conversations")
      .insert({ user_id: userId, contact_id: contact.id, channel: "whatsapp" })
      .select("id")
      .single();
    if (createError || !created) {
      throw new OutreachError(`conversation could not be created: ${createError?.message ?? "unknown"}`, 500);
    }
    conversationId = created.id as string;
    conversationCreated = true;
  }

  try {
    const result = await sendConversationMessage({
      userId,
      conversationId,
      messageType: templateName ? "template" : "text",
      contentText: templateName ? null : (text || "").trim(),
      templateName: templateName || null,
      templateLanguage: templateLanguage || null,
      templateParams: templateParams || [],
      pauseAi: false,
    });
    return {
      contactId: contact.id,
      conversationId,
      crmMessageId: result.crmMessageId,
      waMessageId: result.waMessageId,
      contactCreated,
      conversationCreated,
    };
  } catch (err) {
    if (err instanceof SendError) {
      throw new OutreachError(err.message, err.status);
    }
    throw err;
  }
}
