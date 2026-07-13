-- ============================================================
-- Outbound calling — voice_calls grows direction/status/objective
-- so the Calls page can show who called whom and why, and queued
-- outbound calls (placed via /api/calls/outbound) have a row to
-- merge into when the Vapi end-of-call report arrives.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE voice_calls
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS objective TEXT;

DO $$ BEGIN
  ALTER TABLE voice_calls
    ADD CONSTRAINT voice_calls_direction_check
    CHECK (direction IN ('inbound', 'outbound', 'web'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE voice_calls
    ADD CONSTRAINT voice_calls_status_check
    CHECK (status IN ('queued', 'ringing', 'in-progress', 'completed', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
