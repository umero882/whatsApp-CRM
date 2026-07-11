import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { verifyMobileAdmin, isMobileAuthError } from "@/lib/mobile/auth";

/** GET /api/mobile/whatsapp/stats — KPI counts for the tenant. */
export async function GET(request: Request) {
  let admin;
  try {
    admin = await verifyMobileAdmin(request);
  } catch (e) {
    if (isMobileAuthError(e)) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }

  const db = supabaseAdmin();
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Count messages belonging to the tenant's conversations (inner join).
  const base = () =>
    db
      .from("messages")
      .select("id, conversations!inner(user_id)", { count: "exact", head: true })
      .eq("conversations.user_id", admin.userId);

  type CountQuery = ReturnType<typeof base>;

  const runCount = async (build: (q: CountQuery) => CountQuery): Promise<number> => {
    const { count, error } = await build(base());
    if (error) {
      console.error("[mobile/stats] count failed:", error.message);
      return 0;
    }
    return count ?? 0;
  };

  const todayIso = startOfToday.toISOString();
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
}
