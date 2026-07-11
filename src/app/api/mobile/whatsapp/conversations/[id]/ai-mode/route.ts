import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyMobileAdmin, isMobileAuthError } from "@/lib/mobile/auth";
import { AI_MANUAL_SENTINEL } from "@/lib/mobile/serializers";

/** POST /api/mobile/whatsapp/conversations/:id/ai-mode  { mode: 'ai' | 'manual' } */
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
  const mode = body.mode;
  if (mode !== "ai" && mode !== "manual") {
    return NextResponse.json({ error: "mode must be 'ai' or 'manual'" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", admin.userId)
    .maybeSingle();

  if (convErr) {
    console.error("[mobile/ai-mode] lookup failed:", convErr.message);
    return NextResponse.json({ error: "Failed to update mode" }, { status: 500 });
  }
  if (!conv) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  // manual → pause indefinitely (far-future sentinel); ai → clear the pause.
  const aiPausedUntil = mode === "manual" ? AI_MANUAL_SENTINEL : null;

  const { error: updateErr } = await db
    .from("conversations")
    .update({ ai_paused_until: aiPausedUntil, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", admin.userId);

  if (updateErr) {
    console.error("[mobile/ai-mode] update failed:", updateErr.message);
    return NextResponse.json({ error: "Failed to update mode" }, { status: 500 });
  }

  return NextResponse.json({ success: true, ai_active: mode === "ai" });
}
