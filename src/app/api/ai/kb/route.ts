import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ingestDocument } from '@/lib/ai/kb';

/**
 * Knowledge base documents — list + create.
 * Auth: session user; RLS scopes every row to the owner.
 */

const MAX_TITLE = 200;
const MAX_CONTENT = 100_000;

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { data, error } = await supabase
    .from('kb_documents')
    .select('id, title, content, embedding_status, chunk_count, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ documents: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { title?: unknown; content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const title = String(body.title ?? '').trim().slice(0, MAX_TITLE);
  const content = String(body.content ?? '').trim();
  if (!title || !content) {
    return NextResponse.json({ error: 'title and content are required' }, { status: 400 });
  }
  if (content.length > MAX_CONTENT) {
    return NextResponse.json({ error: `content exceeds ${MAX_CONTENT} characters` }, { status: 400 });
  }

  const { data: doc, error: insErr } = await supabase
    .from('kb_documents')
    .insert({ user_id: user.id, title, content })
    .select('id')
    .single();
  if (insErr || !doc) {
    return NextResponse.json({ error: insErr?.message ?? 'insert failed' }, { status: 500 });
  }

  try {
    const result = await ingestDocument(supabase, {
      documentId: doc.id,
      userId: user.id,
      content,
    });
    return NextResponse.json({ id: doc.id, ...result });
  } catch (e) {
    // Chunk storage failed — remove the orphaned document row.
    await supabase.from('kb_documents').delete().eq('id', doc.id);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'ingest failed' },
      { status: 500 },
    );
  }
}
