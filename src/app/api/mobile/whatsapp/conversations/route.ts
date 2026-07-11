import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyMobileAdmin, isMobileAuthError } from "@/lib/mobile/auth";
import { serializeConversation, type ConversationRow } from "@/lib/mobile/serializers";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** GET /api/mobile/whatsapp/conversations?limit&offset&search */
export async function GET(request: Request) {
  let admin;
  try {
    admin = await verifyMobileAdmin(request);
  } catch (e) {
    if (isMobileAuthError(e)) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const limit = clamp(Number(searchParams.get("limit")), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);
  // Strip characters that would break a PostgREST `.or` filter string.
  const search = (searchParams.get("search") ?? "").replace(/[,()*%\\]/g, "").trim();

  const db = supabaseAdmin();

  // Optional search: prefilter matching contacts, then constrain by id.
  let contactIdFilter: string[] | null = null;
  if (search) {
    const { data: contacts } = await db
      .from("contacts")
      .select("id")
      .eq("user_id", admin.userId)
      .or(`phone.ilike.%${search}%,name.ilike.%${search}%`);
    contactIdFilter = (contacts ?? []).map((c) => c.id as string);
    if (contactIdFilter.length === 0) {
      return NextResponse.json({ conversations: [], total: 0 });
    }
  }

  let query = db
    .from("conversations")
    .select(
      "id,last_message_text,last_message_at,unread_count,ai_paused_until,contact:contacts(phone,name)",
      { count: "exact" },
    )
    .eq("user_id", admin.userId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (contactIdFilter) query = query.in("contact_id", contactIdFilter);

  const { data, count, error } = await query;
  if (error) {
    console.error("[mobile/conversations] query failed:", error.message);
    return NextResponse.json({ error: "Failed to load conversations" }, { status: 500 });
  }

  return NextResponse.json({
    conversations: (data ?? []).map((r) =>
      serializeConversation(r as unknown as ConversationRow),
    ),
    total: count ?? 0,
  });
}

function clamp(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}
