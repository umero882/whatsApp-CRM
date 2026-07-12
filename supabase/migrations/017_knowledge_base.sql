-- ============================================================
-- RAG Knowledge Base — operator-managed business knowledge the AI
-- agent retrieves at answer time (search_knowledge_base tool).
--
--   kb_documents — one row per document (title + full text) the
--                  operator manages in Settings → Knowledge.
--   kb_chunks    — retrieval units: ~1000-char chunks of a document
--                  with an OpenAI text-embedding-3-small vector
--                  (NULL when no OpenAI key was available at ingest —
--                  full-text search still works) and a generated
--                  tsvector for hybrid / fallback ranking.
--   kb_search()  — hybrid scorer: 0.7 * cosine similarity + 0.3 *
--                  ts_rank when an embedding is supplied, ts_rank
--                  alone otherwise.
--
-- Requires the pgvector extension (ships with Supabase images).
-- Idempotent — safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS kb_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  -- 'embedded' | 'text_only' (no OpenAI key at ingest) | 'error'
  embedding_status TEXT NOT NULL DEFAULT 'text_only'
    CHECK (embedding_status IN ('embedded', 'text_only', 'error')),
  chunk_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_user ON kb_documents(user_id);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_user ON kb_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_tsv ON kb_chunks USING GIN (content_tsv);
-- HNSW needs pgvector >= 0.5; fall back to ivfflat manually if the
-- prod instance is older (CREATE INDEX ... USING ivfflat).
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks
             USING hnsw (embedding vector_cosine_ops)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'hnsw unavailable (%), trying ivfflat', SQLERRM;
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks
               USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'ivfflat also unavailable (%) — sequential scan is fine at KB scale', SQLERRM;
    END;
  END;
END$$;

ALTER TABLE kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own kb documents" ON kb_documents;
CREATE POLICY "Users can manage own kb documents" ON kb_documents
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own kb chunks" ON kb_chunks;
CREATE POLICY "Users can manage own kb chunks" ON kb_chunks
  FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON kb_documents;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON kb_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Hybrid retrieval. Called with service role from the agent tool.
-- ============================================================
CREATE OR REPLACE FUNCTION kb_search(
  p_user_id UUID,
  p_query TEXT,
  p_embedding vector(1536) DEFAULT NULL,
  p_limit INT DEFAULT 4
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  document_title TEXT,
  content TEXT,
  score DOUBLE PRECISION
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id AS chunk_id,
    c.document_id,
    d.title AS document_title,
    c.content,
    CASE
      WHEN p_embedding IS NOT NULL AND c.embedding IS NOT NULL THEN
        0.7 * (1 - (c.embedding <=> p_embedding))
        + 0.3 * ts_rank(c.content_tsv, websearch_to_tsquery('english', p_query))
      ELSE
        ts_rank(c.content_tsv, websearch_to_tsquery('english', p_query))::double precision
    END AS score
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  WHERE c.user_id = p_user_id
    AND (
      (p_embedding IS NOT NULL AND c.embedding IS NOT NULL)
      OR c.content_tsv @@ websearch_to_tsquery('english', p_query)
    )
  ORDER BY score DESC
  LIMIT GREATEST(p_limit, 1);
$$;
