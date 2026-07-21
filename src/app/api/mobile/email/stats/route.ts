import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyMobileAdmin, mobileAuthErrorResponse } from '@/lib/mobile/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TZ = 4 * 60 * 60 * 1000;

export async function GET(request: Request): Promise<Response> {
  let admin;
  try { admin = await verifyMobileAdmin(request); }
  catch (e) { const r = mobileAuthErrorResponse(e); if (r) return r; throw e; }
  const sb = supabaseAdmin();
  const now = Date.now();
  const startToday = new Date(Math.floor((now + TZ) / 86_400_000) * 86_400_000 - TZ).toISOString();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const base = () => sb.from('messages').select('id, conversations!inner(user_id,channel)', { count: 'exact', head: true })
    .eq('conversations.user_id', admin.userId).eq('conversations.channel', 'email');
  try {
    const [today, week, total, inbound, outbound] = await Promise.all([
      base().gte('created_at', startToday),
      base().gte('created_at', weekAgo),
      base(),
      base().gte('created_at', startToday).eq('sender_type', 'customer'),
      base().gte('created_at', startToday).in('sender_type', ['agent', 'bot']),
    ]);
    return NextResponse.json({
      today: today.count ?? 0, week: week.count ?? 0, total: total.count ?? 0,
      inbound_today: inbound.count ?? 0, outbound_today: outbound.count ?? 0,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 });
  }
}
