# RAG Knowledge Base — Design

**Date:** 2026-07-12
**Status:** Approved (autonomous session)

## Problem

The AI agent can only answer from its persona prompt and live marketplace tools.
Questions about the business itself — visa process, placement timelines, refund
policy, medical checks, what's included in the fee, trial periods — get invented,
deflected, or escalated. The operator has no way to teach the agent this knowledge
without editing the system prompt (which is size-capped and unstructured).

## Solution

A per-user knowledge base with retrieval-augmented answers:

- Operator manages **documents** (title + text) in Settings → Knowledge.
- Server chunks each document (~1000 chars, paragraph-aware, 150 overlap) and
  embeds chunks with OpenAI `text-embedding-3-small` (1536 dims) — the key is
  already provisioned server-side for Whisper.
- A new **`search_knowledge_base` agent tool** (available in EVERY stage — policy
  questions arrive at any point) retrieves the top chunks via **hybrid search**:
  pgvector cosine similarity blended with Postgres full-text rank. With no OpenAI
  key, retrieval degrades gracefully to full-text only.
- The tool result instructs the model to answer STRICTLY from the returned
  passages; empty results → say we'll check with the team (or escalate), never
  invent policy.

## Approaches considered

1. **pgvector hybrid in the existing Supabase (CHOSEN)** — zero new
   infrastructure, RLS-native multi-tenancy, one migration; hybrid (vector+FTS)
   is robust to embedding-provider outages.
2. External vector DB (Pinecone/Qdrant) — new service, new secret, overkill for
   thousands of chunks. Rejected.
3. Prompt-stuffing the whole KB — token cost scales with KB size, no relevance
   ranking, hits prompt caps. Rejected.
4. Auto-inject top-k on every message (RAG-always) — simpler mentally but pays
   embedding+token cost on greetings/chit-chat; the tool-call pattern matches the
   existing architecture and Haiku 4.5 calls tools reliably. Rejected for v1.

## Components

| Unit | Purpose |
|---|---|
| `supabase/migrations/017_knowledge_base.sql` | `vector` extension, `kb_documents`, `kb_chunks` (embedding vector(1536) NULL + generated tsvector), HNSW + GIN indexes, RLS, `kb_search` SQL function (hybrid scoring) |
| `src/lib/ai/kb.ts` (+tests) | `chunkText` (pure), `embedTexts` (OpenAI, batched, null-safe), `ingestDocument` (delete-and-replace chunks), `searchKnowledgeBase` (embed query → RPC) |
| `src/app/api/ai/kb/route.ts` | GET list (docs + chunk counts), POST create+ingest (auth: session user) |
| `src/app/api/ai/kb/[id]/route.ts` | PUT update+re-ingest, DELETE |
| `src/lib/ai/tools/knowledge-base.ts` | `search_knowledge_base` ToolHandler; formats top 4 passages with doc titles |
| `src/components/settings/knowledge-base-config.tsx` | Knowledge tab: list, add (title+content), edit, delete; shows chunk/embedding status |
| agent.ts + preset | register tool, add to ALL_STAGE_TOOLS, directive + preset rule: policy/process/fee-detail questions ⇒ search first, answer only from passages |

### `kb_search` function (migration)

`kb_search(p_user_id uuid, p_query text, p_embedding vector(1536), p_limit int)`
returns chunk id, document title, content, score. Scoring:
`0.7 * (1 - cosine_distance) + 0.3 * ts_rank` when embedding present, else
ts_rank alone (websearch_to_tsquery). SECURITY DEFINER not needed — called with
service role from the tool.

### Failure modes

- No OpenAI key at ingest → chunks stored with NULL embedding (FTS still works);
  UI shows "text-search only" badge. Re-saving re-embeds.
- Embedding API error at query time → FTS-only search, logged, not fatal.
- Empty KB / no hits → tool returns `found: 0` with a note telling the model to
  admit the gap and offer human follow-up. Never invent.

## Testing

Pure: chunker (paragraph boundaries, overlap, short docs, huge paragraphs);
tool formatting (passages → LLM-facing payload, empty case); ingest/search with
mocked supabase + fetch. Route handlers stay thin.

## Rollout

1. Migration 017 on prod `supabase-db` (psql script, same as 016).
2. Deploy via Coolify + prompt re-sync (preset gains KB rule).
3. Verify: create a doc via UI, ask the business number a policy question,
   watch `search_knowledge_base` in the agent logs.
