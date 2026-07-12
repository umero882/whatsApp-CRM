-- ============================================================
-- Voice calls — dedicated log for the Lucy Voice phone line
-- (Vapi end-of-call reports). Powers the Calls page in the CRM.
-- Calls are ALSO mirrored into the matching conversation as a
-- message (existing behavior); this table is the structured view.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vapi_call_id TEXT NOT NULL UNIQUE,
  caller_phone TEXT,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  duration_seconds INT,
  ended_reason TEXT,
  summary TEXT,
  transcript TEXT,
  recording_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_calls_user_created
  ON voice_calls(user_id, created_at DESC);

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own voice calls" ON voice_calls;
CREATE POLICY "Users can view own voice calls" ON voice_calls
  FOR SELECT USING (auth.uid() = user_id);
