import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyMobileAdmin, mobileAuthErrorResponse } from "@/lib/mobile/auth";
import { serializeMessage, type MessageRow } from "@/lib/mobile/serializers";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** GET /api/mobile/whatsapp/conversations/:id/messages?limit */
export async function GET(
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

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const rawLimit = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const db = supabaseAdmin();

  // The conversation must belong to this tenant — otherwise 404 (never leak
  // that it exists for someone else).
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", admin.userId)
    .maybeSingle();

  if (convErr) {
    console.error("[mobile/messages] conversation lookup failed:", convErr.message);
    return NextResponse.json({ error: "Failed to load messages" }, { status: 500 });
  }
  if (!conv) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Fetch the NEWEST `limit` messages (descending), then reverse to
  // ascending for display. Ordering ascending + limit would return the
  // oldest N and never show the customer's latest message on a long thread.
  const { data, error } = await db
    .from("messages")
    .select(
      "id,sender_type,agent_kind,content_text,content_type,media_url,ai_media_summary,status,created_at",
    )
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[mobile/messages] query failed:", error.message);
    return NextResponse.json({ error: "Failed to load messages" }, { status: 500 });
  }

  const ascending = (data ?? []).slice().reverse();
  return NextResponse.json({
    messages: ascending.map((r) => serializeMessage(r as unknown as MessageRow)),
  });
}
