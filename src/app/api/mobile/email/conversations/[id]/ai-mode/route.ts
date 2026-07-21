import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyMobileAdmin, mobileAuthErrorResponse } from '@/lib/mobile/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const AI_MANUAL_SENTINEL = '2999-01-01T00:00:00Z';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let admin;
  try { admin = await verifyMobileAdmin(request); }
  catch (e) { const r = mobileAuthErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== 'ai' && mode !== 'manual') return NextResponse.json({ error: "mode must be 'ai' or 'manual'" }, { status: 400 });

  const sb = supabaseAdmin();
  const { data: conv } = await sb.from('conversations').select('id')
    .eq('id', id).eq('user_id', admin.userId).eq('channel', 'email').maybeSingle();
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  await sb.from('conversations').update({
    ai_paused_until: mode === 'manual' ? AI_MANUAL_SENTINEL : null, updated_at: new Date().toISOString(),
  }).eq('id', id).eq('user_id', admin.userId);
  return NextResponse.json({ success: true, ai_active: mode === 'ai' });
}
