import { NextResponse } from "next/server";
import { verifyMobileAdmin, isMobileAuthError } from "@/lib/mobile/auth";
import { sendConversationMessage, SendError } from "@/lib/whatsapp/send-message";

/** POST /api/mobile/whatsapp/conversations/:id/reply  { text } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin;
  try {
    admin = await verifyMobileAdmin(request);
  } catch (e) {
    if (isMobileAuthError(e)) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }

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
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[mobile/reply] send failed:", err);
    return NextResponse.json({ error: "Failed to send reply" }, { status: 500 });
  }
}
