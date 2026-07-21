import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyMobileAdmin, mobileAuthErrorResponse } from '@/lib/mobile/auth';
import { serializeMessage } from '@/lib/mobile/serializers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let admin;
  try { admin = await verifyMobileAdmin(request); }
  catch (e) { const r = mobileAuthErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const limit = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 100) || 100));

  const sb = supabaseAdmin();
  const { data: conv } = await sb.from('conversations').select('id')
    .eq('id', id).eq('user_id', admin.userId).eq('channel', 'email').maybeSingle();
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  const { data } = await sb.from('messages')
    .select('id,sender_type,agent_kind,content_text,content_type,media_url,ai_media_summary,status,created_at')
    .eq('conversation_id', id).order('created_at', { ascending: false }).limit(limit);
  return NextResponse.json({ messages: (data ?? []).slice().reverse().map(serializeMessage) });
}
