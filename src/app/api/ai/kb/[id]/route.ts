import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ingestDocument } from '@/lib/ai/kb';

/** Knowledge base document — update (re-ingests) + delete. */

const MAX_TITLE = 200;
const MAX_CONTENT = 100_000;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  const { data: doc, error: updErr } = await supabase
    .from('kb_documents')
    .update({ title, content })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

  try {
    const result = await ingestDocument(supabase, { documentId: id, userId: user.id, content });
    return NextResponse.json({ id, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'ingest failed' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Chunks cascade via FK.
  const { error } = await supabase.from('kb_documents').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
