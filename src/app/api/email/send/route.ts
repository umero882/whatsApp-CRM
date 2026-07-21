import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmailConversationMessage } from '@/lib/email/conversation-send';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Web CRM inbox → human reply on an EMAIL conversation. The WhatsApp composer
 * posts to /api/whatsapp/send; email conversations must post here instead so
 * the reply goes out as a threaded email (sendEmailReply) rather than through
 * the WhatsApp Graph API. Auth + rate-limit mirror /api/whatsapp/send; the
 * actual send + persist + AI-pause is the same helper the mobile reply route
 * uses, so both surfaces behave identically.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => ({}));
    const conversationId = body?.conversation_id;
    const text = typeof body?.content_text === 'string' ? body.content_text.trim() : '';
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
    }
    if (!text) {
      return NextResponse.json({ error: 'content_text is required' }, { status: 400 });
    }

    const result = await sendEmailConversationMessage({ userId: user.id, conversationId, text });
    return NextResponse.json({
      success: true,
      message_id: result.crmMessageId,
      email_message_id: result.emailMessageId,
    });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    if (status < 500) {
      return NextResponse.json({ error: (error as Error).message }, { status });
    }
    console.error('Error in email send POST:', error);
    return NextResponse.json({ error: 'Failed to send email reply' }, { status: 500 });
  }
}
