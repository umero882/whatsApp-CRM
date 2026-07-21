import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyMobileAdmin, mobileAuthErrorResponse } from "@/lib/mobile/auth";
import { serializeEmailConversation } from "@/lib/mobile/serializers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** GET /api/mobile/email/conversations?limit&offset&search */
export async function GET(request: Request): Promise<Response> {
  let admin;
  try {
    admin = await verifyMobileAdmin(request);
  } catch (e) {
    const r = mobileAuthErrorResponse(e);
    if (r) return r;
    throw e;
  }

  const url = new URL(request.url);
  const limit = clamp(Number(url.searchParams.get("limit") ?? 50) || 50, 1, 100);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

  const sb = supabaseAdmin();
  const { data, count, error } = await sb
    .from("conversations")
    .select(
      "id,subject,last_message_text,last_message_at,unread_count,ai_paused_until,contact:contacts(external_id,name)",
      { count: "exact" },
    )
    .eq("user_id", admin.userId)
    .eq("channel", "email")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: "Failed to load conversations" }, { status: 500 });

  return NextResponse.json({
    conversations: (data ?? []).map(serializeEmailConversation),
    total: count ?? 0,
  });
}
