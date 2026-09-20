import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { MobileOwnerError, resolveOwnerUserId } from "@/lib/mobile/auth";
import { OutreachError, sendOutreach } from "@/lib/outreach/whatsapp";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * POST /api/integrations/outreach/whatsapp
 *
 * Server-to-server: a first WhatsApp message to a prospect, through the
 * business's connected number, so the conversation lives in this inbox and
 * the AI agent answers the reply. PyRunner's Prospects screen is the caller.
 *
 * Auth: `Authorization: Bearer <OUTREACH_API_KEY>` — one shared secret set in
 * the CRM's environment; the route is off (401) while it is unset.
 *
 * Body: {
 *   phone: "+971501234567",            required
 *   name?: "Family in Al Shamkha",     shown in the inbox
 *   email?: "…",
 *   template_name?: "ad_reply",        required for a business-initiated message
 *   template_language?: "en_US",
 *   template_params?: ["Al Shamkha"],
 *   text?: "…",                        only inside an open 24-hour window
 *   allow_existing?: false             let a second message reach a known number
 * }
 * 200 { success, contact_id, conversation_id, message_id, whatsapp_message_id,
 *       contact_created, conversation_created }
 * 409 when the number is already a customer, or was already written to.
 */
export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let userId: string;
  try {
    userId = await resolveOwnerUserId();
  } catch (e) {
    if (e instanceof MobileOwnerError) {
      return NextResponse.json({ error: "WhatsApp backend temporarily unavailable" }, { status: 503 });
    }
    throw e;
  }

  // Same budget as every other path into the Meta send core.
  const limit = checkRateLimit(`outreach:${userId}`, RATE_LIMITS.send);
  if (!limit.success) return rateLimitResponse(limit);

  const body = await request.json().catch(() => ({}));
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!phone) {
    return NextResponse.json({ error: "phone is required" }, { status: 400 });
  }
  const templateParams = Array.isArray(body.template_params)
    ? body.template_params.map((p: unknown) => String(p ?? ""))
    : [];

  try {
    const result = await sendOutreach({
      userId,
      phone,
      name: typeof body.name === "string" ? body.name : null,
      email: typeof body.email === "string" ? body.email : null,
      templateName: typeof body.template_name === "string" ? body.template_name : null,
      templateLanguage: typeof body.template_language === "string" ? body.template_language : null,
      templateParams,
      text: typeof body.text === "string" ? body.text : null,
      allowExisting: body.allow_existing === true,
    });
    return NextResponse.json({
      success: true,
      contact_id: result.contactId,
      conversation_id: result.conversationId,
      message_id: result.crmMessageId,
      whatsapp_message_id: result.waMessageId,
      contact_created: result.contactCreated,
      conversation_created: result.conversationCreated,
    });
  } catch (err) {
    if (err instanceof OutreachError) {
      const message = err.status >= 500 ? "Failed to send" : err.message;
      if (err.status >= 500) console.error("[outreach/whatsapp] fault:", err.message);
      return NextResponse.json({ error: message }, { status: err.status });
    }
    console.error("[outreach/whatsapp] failed:", err);
    return NextResponse.json({ error: "Failed to send" }, { status: 500 });
  }
}

function authorised(request: Request): boolean {
  const expected = (process.env.OUTREACH_API_KEY || "").trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const supplied = header.slice(7).trim();
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
