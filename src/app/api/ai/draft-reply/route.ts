import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { draftReply, DraftReplyError } from '@/lib/ai/draft-reply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HTTP_FOR_CODE: Record<DraftReplyError['code'], number> = {
  no_provider: 412,
  provider_disabled: 412,
  no_conversation: 404,
  no_messages: 422,
  provider_failed: 502,
  bad_response: 502,
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const conversationId = (body as { conversation_id?: string }).conversation_id;
  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
  }

  try {
    const result = await draftReply(supabase, conversationId);
    return NextResponse.json({
      suggestions: result.suggestions,
      provider: result.provider,
      model: result.model,
    });
  } catch (e) {
    if (e instanceof DraftReplyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: HTTP_FOR_CODE[e.code] },
      );
    }
    console.error('[ai/draft-reply] unexpected', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal error' },
      { status: 500 },
    );
  }
}
