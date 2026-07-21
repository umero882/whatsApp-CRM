import { NextResponse } from 'next/server';
import { verifyMobileAdmin, mobileAuthErrorResponse } from '@/lib/mobile/auth';
import { sendEmailConversationMessage } from '@/lib/email/conversation-send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let admin;
  try { admin = await verifyMobileAdmin(request); }
  catch (e) { const r = mobileAuthErrorResponse(e); if (r) return r; throw e; }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });

  try {
    const r = await sendEmailConversationMessage({ userId: admin.userId, conversationId: id, text });
    return NextResponse.json({ success: true, message_id: r.crmMessageId, email_message_id: r.emailMessageId });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: status >= 500 ? 'Failed to send reply' : (e as Error).message }, { status });
  }
}
