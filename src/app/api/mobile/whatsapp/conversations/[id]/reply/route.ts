import { NextResponse } from "next/server";
import { verifyMobileAdmin, mobileAuthErrorResponse } from "@/lib/mobile/auth";
import { sendConversationMessage, SendError } from "@/lib/whatsapp/send-message";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

/** POST /api/mobile/whatsapp/conversations/:id/reply  { text } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin;
  try {
    admin = await verifyMobileAdmin(request);
  } catch (e) {
    const res = mobileAuthErrorResponse(e);
    if (res) return res;
    throw e;
  }

  // Same budget as the web send path — this reaches the identical Meta send
  // core, so it must be throttled too (cost/quota + spam protection).
  const limit = checkRateLimit(`mobile-reply:${admin.userId}`, RATE_LIMITS.send);
  if (!limit.success) return rateLimitResponse(limit);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  try {
    // sendConversationMessage scopes to admin.userId and 404s if the
    // conversation isn't the owner's — no separate ownership check needed.
    const result = await sendConversationMessage({
      userId: admin.userId,
      conversationId: id,
      messageType: "text",
      contentText: text,
    });
    return NextResponse.json({
      success: true,
      message_id: result.crmMessageId,
      whatsapp_message_id: result.waMessageId,
    });
  } catch (err) {
    if (err instanceof SendError) {
      // Don't leak internal detail (e.g. DB error text) on server faults.
      const message = err.status >= 500 ? "Failed to send reply" : err.message;
      if (err.status >= 500) console.error("[mobile/reply] send fault:", err.message);
      return NextResponse.json({ error: message }, { status: err.status });
    }
    console.error("[mobile/reply] send failed:", err);
    return NextResponse.json({ error: "Failed to send reply" }, { status: 500 });
  }
}
