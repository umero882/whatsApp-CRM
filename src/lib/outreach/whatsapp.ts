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
 * What the agent needs to answer the reply well (added after the first live
 * test, where a "Yes, send profiles" tap got the Amharic maid-registration
 * reply): the template's rendered body is persisted as the message text, so
 * the history shows what we said rather than "[template]"; and the caller
 * states who the person is (`intent`) — stored as a role tag on the contact
 * ("Sponsor" / "Job seeker"), which the agent reads as its starting intent
 * when the customer's own words carry no hire/work keyword. Extra `tags`
 * ("Prospect") are for the inbox's own filtering.
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
  /** Meta language code; when omitted, the catalog's approved entry decides. */
  templateLanguage?: string | null;
  templateParams?: string[];
  /** Free text — only valid inside an open customer-service window. */
  text?: string | null;
  /** Let a second message reach a phone that already has a conversation. */
  allowExisting?: boolean;
  /** Who this is — a household hiring, or a worker looking for a job. */
  intent?: OutreachIntent | null;
  /** Labels for the inbox, created when new; matched to existing ones by name, case-insensitively. */
  tags?: string[];
}

export type OutreachIntent = "sponsor" | "job_seeker";

/** The contact tag each intent becomes — the same names the agent reads back. */
export const ROLE_TAGS: Record<OutreachIntent, string> = {
  sponsor: "Sponsor",
  job_seeker: "Job seeker",
};

export interface OutreachResult {
  contactId: string;
  conversationId: string;
  crmMessageId: string;
  waMessageId: string;
  contactCreated: boolean;
  conversationCreated: boolean;
  /** The tags now on the contact, as stored (the role tag first). */
  tags: string[];
}

/** Meta's {{n}} placeholders filled from the parameters; a missing one stays visible. */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const value = params[Number(raw) - 1];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

interface ContactRow {
  id: string;
  phone: string;
  name: string | null;
  email?: string | null;
}

export async function sendOutreach(params: OutreachParams): Promise<OutreachResult> {
  const { userId, name, email, templateName, templateLanguage, templateParams, text, allowExisting, intent } = params;
  const phone = sanitizePhoneForMeta(params.phone || "");
  if (!phone || !isValidE164("+" + phone)) {
    throw new OutreachError("phone must be a valid international number", 400);
  }
  if (!templateName && !(text && text.trim())) {
    throw new OutreachError("template_name or text is required", 400);
  }
  if (intent && !(intent in ROLE_TAGS)) {
    throw new OutreachError(`intent must be one of ${Object.keys(ROLE_TAGS).join(", ")}`, 400);
  }
  const db = supabaseAdmin();

  // A template must exist and be approved in the synced catalog; its
  // language is taken from there when the caller did not say — a name sent
  // with the wrong code is a Meta error nobody can read on the other side.
  let language = templateLanguage || null;
  let body: string | null = null;
  if (templateName) {
    const { data: rows, error: tplError } = await db
      .from("message_templates")
      .select("language, status, body_text")
      .eq("user_id", userId)
      .eq("name", templateName);
    if (tplError) {
      throw new OutreachError(`template lookup failed: ${tplError.message}`, 500);
    }
    const catalog = (rows ?? []) as Array<{ language: string; status: string; body_text?: string | null }>;
    // The synced catalog stores Meta's status capitalised ("Approved").
    const approved = catalog.filter((t) => (t.status || "").toLowerCase() === "approved");
    if (!approved.length) {
      throw new OutreachError(
        catalog.length
          ? `template "${templateName}" is not approved yet`
          : `template "${templateName}" is not in the catalog — sync templates from Meta`,
        422,
      );
    }
    if (!language) {
      language = approved.find((t) => t.language.toLowerCase().startsWith("en"))?.language ?? approved[0].language;
    } else if (!approved.some((t) => t.language === language)) {
      throw new OutreachError(`template "${templateName}" has no approved ${language} version`, 422);
    }
    // The text the inbox shows and the agent reads back — the same rendering
    // the inbox's own template send persists. An older catalog row without
    // a body stores nothing rather than a guess.
    const chosen = approved.find((t) => t.language === language);
    body = chosen?.body_text ? renderTemplateBody(chosen.body_text, templateParams || []) : null;
  }

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

  // The role and labels go on before anything is sent: a tagging fault stops
  // here, with nothing half-done on the other side.
  const tagNames = [...(intent ? [ROLE_TAGS[intent]] : []), ...(params.tags || [])];
  const tags = await tagContact(db, userId, contact.id, tagNames);

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
      contentText: templateName ? body : (text || "").trim(),
      templateName: templateName || null,
      templateLanguage: language,
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
      tags,
    };
  } catch (err) {
    if (err instanceof SendError) {
      throw new OutreachError(err.message, err.status);
    }
    throw err;
  }
}

type AdminDb = ReturnType<typeof supabaseAdmin>;

/**
 * Put the named tags on the contact, creating the ones the account does not
 * have yet. Names match existing tags case-insensitively so "prospect" and
 * "Prospect" stay one tag. Returns the names as stored, in the order given.
 */
async function tagContact(db: AdminDb, userId: string, contactId: string, names: string[]): Promise<string[]> {
  const wanted = names.map((n) => n.trim()).filter(Boolean);
  if (!wanted.length) return [];
  const { data: rows, error } = await db.from("tags").select("id, name").eq("user_id", userId);
  if (error) {
    throw new OutreachError(`tags lookup failed: ${error.message}`, 500);
  }
  const existing = (rows ?? []) as Array<{ id: string; name: string }>;
  const applied: string[] = [];
  for (const name of wanted) {
    let tag = existing.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
    if (!tag) {
      const { data: created, error: createError } = await db
        .from("tags")
        .insert({ user_id: userId, name })
        .select("id, name")
        .single();
      if (createError || !created) {
        throw new OutreachError(`tag "${name}" could not be created: ${createError?.message ?? "unknown"}`, 500);
      }
      tag = created as { id: string; name: string };
      existing.push(tag);
    }
    const { error: linkError } = await db
      .from("contact_tags")
      .upsert({ contact_id: contactId, tag_id: tag.id }, { onConflict: "contact_id,tag_id" });
    if (linkError) {
      throw new OutreachError(`contact could not be tagged "${name}": ${linkError.message}`, 500);
    }
    if (!applied.includes(tag.name)) applied.push(tag.name);
  }
  return applied;
}
