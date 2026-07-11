/**
 * Shared "send a WhatsApp message on a conversation" core.
 *
 * Extracted from `POST /api/whatsapp/send` so the browser inbox and the
 * admin-mobile reply endpoint drive the exact same path: Meta send with
 * phone-variant retry, DB persistence, AI-pause on human takeover, and
 * Flow-run pause. Callers supply the resolved `userId` (session user or the
 * mobile owner) — this module never touches auth.
 *
 * Uses the service-role client but ALWAYS filters by `userId`, so it is
 * safe regardless of how the caller authenticated.
 */

import { sendTextMessage, sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { decrypt, encrypt, isLegacyFormat } from "@/lib/whatsapp/encryption";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from "@/lib/whatsapp/phone-utils";

export class SendError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SendError";
    this.status = status;
  }
}

export interface SendParams {
  userId: string;
  conversationId: string;
  messageType: "text" | "template";
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  templateParams?: string[];
  replyToMessageId?: string | null;
}

export interface SendResult {
  crmMessageId: string;
  waMessageId: string;
}

export async function sendConversationMessage(params: SendParams): Promise<SendResult> {
  const {
    userId,
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    templateName,
    templateParams,
    replyToMessageId,
  } = params;

  if (messageType === "text" && !contentText) {
    throw new SendError("content_text is required for text messages", 400);
  }
  if (messageType === "template" && !templateName) {
    throw new SendError("template_name is required for template messages", 400);
  }

  const db = supabaseAdmin();

  // Conversation + contact, scoped to the owner.
  const { data: conversation, error: convError } = await db
    .from("conversations")
    .select("*, contact:contacts(*)")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();

  if (convError || !conversation) {
    throw new SendError("Conversation not found", 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendError("Contact phone number not found", 400);
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendError("Invalid phone number format", 400);
  }

  // WhatsApp config for the owner.
  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (configError || !config) {
    throw new SendError(
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
      400,
    );
  }

  const accessToken = decrypt(config.access_token);

  // Self-heal legacy CBC tokens (fire-and-forget, idempotent).
  if (isLegacyFormat(config.access_token)) {
    void db
      .from("whatsapp_config")
      .update({ access_token: encrypt(accessToken) })
      .eq("id", config.id)
      .then(({ error }) => {
        if (error) {
          console.warn("[whatsapp/send] access_token GCM upgrade failed:", error.message);
        }
      });
  }

  // Resolve reply target → Meta message_id; the parent must live in this
  // same conversation, so a caller can't quote messages they can't see.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from("messages")
      .select("message_id, conversation_id")
      .eq("id", replyToMessageId)
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendError("reply_to_message_id not found in this conversation", 400);
    }
    if (parent.message_id) {
      contextMessageId = parent.message_id;
    } else {
      console.warn(
        "[whatsapp/send] reply target has no Meta message_id; sending without context",
      );
    }
  }

  // Send via Meta, retrying phone-number variants on "recipient not allowed".
  let waMessageId = "";
  let workingPhone = sanitizedPhone;

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === "template") {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  try {
    const variants = phoneVariants(sanitizedPhone);
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(`[whatsapp/send] variant "${variant}" rejected by Meta, trying next…`);
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Meta API error";
    console.error("Meta API send failed for all variants:", message);
    throw new SendError(`Meta API error: ${message}`, 502);
  }

  // Persist a corrected phone for next time.
  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[whatsapp/send] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`,
    );
    await db.from("contacts").update({ phone: workingPhone }).eq("id", contact.id);
  }

  // Insert the outbound message. agent_kind defaults to 'human'.
  const { data: messageRecord, error: msgError } = await db
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_type: "agent",
      content_type: messageType,
      content_text: contentText || null,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      message_id: waMessageId,
      status: "sent",
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError || !messageRecord) {
    console.error("Error inserting sent message:", msgError);
    throw new SendError(
      `Message sent to Meta but failed to save to DB: ${msgError?.message ?? "unknown"}`,
      500,
    );
  }

  // Pause the AI for this conversation — a human is now driving.
  let aiPauseClause: { ai_paused_until: string } | Record<string, never> = {};
  try {
    const { data: agentCfg } = await db
      .from("ai_agent_config")
      .select("human_pause_minutes, is_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (agentCfg?.is_enabled) {
      const minutes = Math.max(0, Number(agentCfg.human_pause_minutes) || 60);
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      aiPauseClause = { ai_paused_until: until };
    }
  } catch (err) {
    console.warn(
      "[ai-agent] pause-on-human-send lookup failed:",
      err instanceof Error ? err.message : err,
    );
  }

  await db
    .from("conversations")
    .update({
      last_message_text: contentText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...aiPauseClause,
    })
    .eq("id", conversationId)
    .eq("user_id", userId);

  // Pause any active Flow run for this contact — human stepped in.
  try {
    const { error: pauseErr } = await db
      .from("flow_runs")
      .update({
        status: "paused_by_agent",
        ended_at: new Date().toISOString(),
        end_reason: "agent_replied",
      })
      .eq("user_id", userId)
      .eq("contact_id", contact.id)
      .eq("status", "active");
    if (pauseErr) {
      console.error("[flows] pause-on-agent-send failed:", pauseErr.message);
    }
  } catch (err) {
    console.error(
      "[flows] pause-on-agent-send threw:",
      err instanceof Error ? err.message : err,
    );
  }

  return { crmMessageId: messageRecord.id, waMessageId };
}
