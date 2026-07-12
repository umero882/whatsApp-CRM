-- ============================================================
-- kb_search v2 — OR-fallback for full-text-only retrieval.
--
-- Production finding (2026-07-12): websearch_to_tsquery ANDs every
-- term, so natural queries like "visa process requirements Ethiopia"
-- return nothing unless one chunk contains ALL terms. When the strict
-- query yields no rows (and no embedding is available to carry the
-- search), retry with OR-of-terms and rank by ts_rank — partial
-- matches beat empty hands.
--
-- Vector-mode behavior is unchanged: with an embedding present the
-- primary query always has candidates (every embedded chunk scores).
-- Idempotent — safe to re-run.
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
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  strict_q tsquery;
  or_q_text TEXT;
BEGIN
  strict_q := websearch_to_tsquery('english', p_query);

  RETURN QUERY
  SELECT
    c.id,
    c.document_id,
    d.title,
    c.content,
    CASE
      WHEN p_embedding IS NOT NULL AND c.embedding IS NOT NULL THEN
        0.7 * (1 - (c.embedding <=> p_embedding))
        + 0.3 * ts_rank(c.content_tsv, strict_q)
      ELSE
        ts_rank(c.content_tsv, strict_q)::double precision
    END
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  WHERE c.user_id = p_user_id
    AND (
      (p_embedding IS NOT NULL AND c.embedding IS NOT NULL)
      OR c.content_tsv @@ strict_q
    )
  ORDER BY 5 DESC
  LIMIT GREATEST(p_limit, 1);

  IF FOUND THEN
    RETURN;
  END IF;

  -- Strict AND matched nothing — retry with OR-of-terms. Build the OR
  -- query by rewriting plainto_tsquery's '&' operators to '|'.
  or_q_text := regexp_replace(plainto_tsquery('english', p_query)::text, '\s*&\s*', ' | ', 'g');
  IF or_q_text IS NULL OR btrim(or_q_text) = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.document_id,
    d.title,
    c.content,
    ts_rank(c.content_tsv, to_tsquery('english', or_q_text))::double precision
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  WHERE c.user_id = p_user_id
    AND c.content_tsv @@ to_tsquery('english', or_q_text)
  ORDER BY 5 DESC
  LIMIT GREATEST(p_limit, 1);
END;
$$;
