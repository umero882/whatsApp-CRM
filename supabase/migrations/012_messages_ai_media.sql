-- ============================================================
-- 012_messages_ai_media.sql
--
-- Multimodal intake: cache the AI understanding of inbound media on the
-- message row so the agent and inbox both read it, and processing is
-- idempotent (ai_media_processed guards against re-running vision/whisper).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_media_processed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_media_summary   text,
  ADD COLUMN IF NOT EXISTS ai_media_data      jsonb;

COMMENT ON COLUMN messages.ai_media_summary IS
  'Human-readable AI understanding of inbound media (passport summary / voice transcript). Shown in inbox + fed to the agent.';
