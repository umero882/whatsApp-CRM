/**
 * RAG knowledge base — chunking, embedding, ingestion, retrieval.
 *
 * Documents live in `kb_documents`; retrieval units in `kb_chunks`
 * (migration 017). Embeddings use OpenAI text-embedding-3-small
 * (1536 dims) via the same OPENAI_API_KEY already provisioned for
 * Whisper transcription. Everything degrades gracefully to Postgres
 * full-text search when the key is missing or the embedding call
 * fails — retrieval never hard-fails on the embedding provider.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_BATCH_SIZE = 96;

export interface ChunkOptions {
  /** Target max characters per chunk. */
  maxChars?: number;
  /** Characters of tail-overlap carried into the next chunk. */
  overlapChars?: number;
}

/**
 * Paragraph-aware chunker. Whole paragraphs are packed into chunks up
 * to `maxChars`; a paragraph longer than `maxChars` is hard-split with
 * `overlapChars` of tail overlap so no fact is stranded on a boundary.
 * Pure — exported for tests.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = Math.max(opts.maxChars ?? 1000, 200);
  const overlap = Math.min(Math.max(opts.overlapChars ?? 150, 0), Math.floor(maxChars / 2));
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // Oversized paragraph: flush what we have, then hard-split it.
      flush();
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + maxChars, para.length);
        chunks.push(para.slice(start, end).trim());
        if (end >= para.length) break;
        start = end - overlap;
      }
      continue;
    }
    if (current && current.length + 2 + para.length > maxChars) flush();
    current = current ? `${current}\n\n${para}` : para;
  }
  flush();
  return chunks.filter(Boolean);
}

/**
 * Embed texts with OpenAI. Returns null (not throw) when no API key is
 * available; throws on API errors so callers decide the fallback.
 */
export async function embedTexts(
  texts: string[],
  apiKey: string | undefined = process.env.OPENAI_API_KEY,
): Promise<number[][] | null> {
  if (!apiKey) return null;
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) {
      let message = `OpenAI embeddings error: ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error?.message) message = body.error.message;
      } catch { /* keep fallback */ }
      throw new Error(message);
    }
    const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    // API returns items with per-request indexes; order within batch.
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    for (const item of sorted) out.push(item.embedding);
  }
  return out;
}

export interface IngestResult {
  chunkCount: number;
  embeddingStatus: 'embedded' | 'text_only' | 'error';
}

/**
 * Retrieval units carry their document title as a header line so every
 * chunk is self-contained: "UAE rest hours" must match the UAE doc even
 * when the rest-hours sentence lands in a chunk that never repeats the
 * word "UAE". Improves both tsvector matching and embedding quality.
 * Pure — exported for tests.
 */
export function chunkRowContent(title: string, chunk: string): string {
  const t = title.trim();
  return t ? `[${t}]\n${chunk}` : chunk;
}

/**
 * (Re-)ingest a document: replace its chunks with freshly chunked +
 * embedded content and stamp the document's status. An embedding
 * failure still stores the chunks (FTS keeps working) with
 * status='error' so the UI can surface it.
 */
export async function ingestDocument(
  sb: SupabaseClient,
  input: { documentId: string; userId: string; title: string; content: string },
): Promise<IngestResult> {
  const chunks = chunkText(input.content).map((c) => chunkRowContent(input.title, c));

  let embeddings: number[][] | null = null;
  let embeddingStatus: IngestResult['embeddingStatus'] = 'text_only';
  try {
    embeddings = await embedTexts(chunks);
    if (embeddings) embeddingStatus = 'embedded';
  } catch (e) {
    console.warn('[kb] embedding failed, storing text-only:', e instanceof Error ? e.message : e);
    embeddingStatus = 'error';
  }

  const { error: delErr } = await sb.from('kb_chunks').delete().eq('document_id', input.documentId);
  if (delErr) throw new Error(`kb chunk cleanup failed: ${delErr.message}`);

  if (chunks.length > 0) {
    const rows = chunks.map((content, i) => ({
      document_id: input.documentId,
      user_id: input.userId,
      chunk_index: i,
      content,
      embedding: embeddings ? embeddings[i] : null,
    }));
    const { error: insErr } = await sb.from('kb_chunks').insert(rows);
    if (insErr) throw new Error(`kb chunk insert failed: ${insErr.message}`);
  }

  await sb
    .from('kb_documents')
    .update({ chunk_count: chunks.length, embedding_status: embeddingStatus })
    .eq('id', input.documentId);

  return { chunkCount: chunks.length, embeddingStatus };
}

export interface KbHit {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  score: number;
}

/**
 * Hybrid retrieval via the kb_search SQL function. Query embedding is
 * best-effort: on missing key or embedding error we search full-text
 * only rather than failing the tool call.
 */
export async function searchKb(
  sb: SupabaseClient,
  userId: string,
  query: string,
  limit = 4,
): Promise<KbHit[]> {
  let queryEmbedding: number[] | null = null;
  try {
    const embedded = await embedTexts([query]);
    queryEmbedding = embedded?.[0] ?? null;
  } catch (e) {
    console.warn('[kb] query embedding failed, using full-text only:', e instanceof Error ? e.message : e);
  }
  const { data, error } = await sb.rpc('kb_search', {
    p_user_id: userId,
    p_query: query,
    p_embedding: queryEmbedding,
    p_limit: limit,
  });
  if (error) throw new Error(`kb_search failed: ${error.message}`);
  return (data ?? []) as KbHit[];
}
