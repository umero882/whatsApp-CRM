/**
 * Re-ingest knowledge-base documents from docs/kb/knowledge-base-drafts.md
 * into the live Supabase RAG store.
 *
 * The drafts file is the source of truth, but the live store is separate
 * data — editing the markdown alone changes nothing in production. This
 * script closes that gap: it updates kb_documents.content and re-runs
 * ingestDocument(), which re-chunks and RE-EMBEDS. A plain content UPDATE
 * would leave the old embedding vectors pointing at the previous wording.
 *
 * Usage (from repo root):
 *   npx tsx scripts/reingest-kb-drafts.ts --dry
 *   npx tsx scripts/reingest-kb-drafts.ts --title "The Ethiopian Maids app"
 *   npx tsx scripts/reingest-kb-drafts.ts --all
 *
 * Matches documents by title against existing kb_documents rows; never
 * creates or deletes documents.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ingestDocument } from '../src/lib/ai/kb';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    } catch {
      /* file absent — fine */
    }
  }
}

/**
 * Split the drafts file into { heading -> body } by walking lines.
 *
 * Deliberately NOT a single regex: an earlier regex version silently
 * over-captured ~26 trailing chars per section, which made every document
 * look changed and would have written corrupted content to all 13 live
 * docs. A line walker is verifiable and has no lookahead subtleties.
 */
function parseSections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading !== null) out.set(heading, body.join('\n').trim());
  };
  for (const raw of md.split(/\r?\n/)) {
    const m = /^#{1,4}[ \t]+(?:DOC:[ \t]*)?(.+?)[ \t]*$/.exec(raw);
    if (m) {
      flush();
      heading = m[1].trim();
      body = [];
    } else if (heading !== null) {
      body.push(raw);
    }
  }
  flush();
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.OPENAI_API_KEY) {
    console.warn('! OPENAI_API_KEY missing — chunks would store text-only (no embeddings). Aborting.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const all = args.includes('--all');
  const ti = args.indexOf('--title');
  const wanted = ti !== -1 ? args[ti + 1] : null;
  if (!all && !wanted && !dry) {
    console.error('Specify --all, --title "<title>", or --dry');
    process.exit(1);
  }

  const md = readFileSync(resolve(process.cwd(), 'docs/kb/knowledge-base-drafts.md'), 'utf8');
  const sections = parseSections(md);
  const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

  const { data: docs, error } = await sb.from('kb_documents').select('id,user_id,title,content');
  if (error) throw new Error(`kb_documents read failed: ${error.message}`);

  let changed = 0;
  for (const doc of docs ?? []) {
    if (wanted && !doc.title.toLowerCase().includes(wanted.toLowerCase())) continue;
    const next = sections.get(doc.title) ?? null;
    if (!next) {
      console.log(`- SKIP  ${doc.title}  (no matching heading in drafts)`);
      continue;
    }
    if (next.trim() === (doc.content ?? '').trim()) {
      console.log(`= SAME  ${doc.title}`);
      continue;
    }
    changed++;
    console.log(`~ DIFF  ${doc.title}  (${(doc.content ?? '').length} -> ${next.length} chars)`);
    if (dry) continue;

    const { error: upErr } = await sb.from('kb_documents').update({ content: next }).eq('id', doc.id);
    if (upErr) throw new Error(`content update failed for ${doc.title}: ${upErr.message}`);

    const res = await ingestDocument(sb, {
      documentId: doc.id,
      userId: doc.user_id,
      title: doc.title,
      content: next,
    });
    console.log(`  -> re-ingested: ${res.chunkCount} chunk(s), embedding=${res.embeddingStatus}`);
    if (res.embeddingStatus !== 'embedded') {
      console.warn(`  ! ${doc.title} stored WITHOUT embeddings (status=${res.embeddingStatus})`);
    }
  }
  console.log(dry ? `\nDry run: ${changed} document(s) would change.` : `\nDone: ${changed} document(s) re-ingested.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
