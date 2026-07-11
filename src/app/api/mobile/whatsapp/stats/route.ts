import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyMobileAdmin, mobileAuthErrorResponse } from "@/lib/mobile/auth";

// The business operates in the Gulf (admin is UAE, +971). Roll "today" over
// at Gulf midnight (UTC+4), not the server's UTC midnight, so KPIs line up
// with the local business day.
const BUSINESS_TZ_OFFSET_MS = 4 * 60 * 60 * 1000;

/** GET /api/mobile/whatsapp/stats — KPI counts for the tenant. */
export async function GET(request: Request) {
  let admin;
  try {
    admin = await verifyMobileAdmin(request);
  } catch (e) {
    const res = mobileAuthErrorResponse(e);
    if (res) return res;
    throw e;
  }

  const db = supabaseAdmin();
  const now = Date.now();
  // UTC instant of the most recent Gulf-local midnight.
  const shifted = new Date(now + BUSINESS_TZ_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  const startOfToday = new Date(shifted.getTime() - BUSINESS_TZ_OFFSET_MS);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // Count messages belonging to the tenant's conversations (inner join).
  const base = () =>
    db
      .from("messages")
      .select("id, conversations!inner(user_id)", { count: "exact", head: true })
      .eq("conversations.user_id", admin.userId);

  type CountQuery = ReturnType<typeof base>;

  const runCount = async (build: (q: CountQuery) => CountQuery): Promise<number> => {
    const { count, error } = await build(base());
    if (error) throw new Error(`stats count failed: ${error.message}`);
    return count ?? 0;
  };

  const todayIso = startOfToday.toISOString();
  try {
    const [today, week, total, inboundToday, outboundToday] = await Promise.all([
      runCount((q) => q.gte("created_at", todayIso)),
      runCount((q) => q.gte("created_at", weekAgo.toISOString())),
      runCount((q) => q),
      runCount((q) => q.gte("created_at", todayIso).eq("sender_type", "customer")),
      runCount((q) => q.gte("created_at", todayIso).in("sender_type", ["agent", "bot"])),
    ]);

    return NextResponse.json({
      today,
      week,
      total,
      inbound_today: inboundToday,
      outbound_today: outboundToday,
    });
  } catch (err) {
    console.error("[mobile/stats]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 });
  }
}
