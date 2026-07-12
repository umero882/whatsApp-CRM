-- ============================================================
-- Two-sided matching + re-engage
--
--   1. `ai_match_alerts` — saved searches the agent registers when a
--      customer's search came up empty (sponsor waiting for a matching
--      maid, or a maid waiting for a matching job). A cron sweep
--      (/api/ai/engagement/cron) re-runs each active alert against the
--      Ethiopian Maids Hasura DB and messages the customer on WhatsApp
--      when NEW matches appear. Watermark = last_notified_at (falling
--      back to created_at) so the same match never notifies twice.
--
--   2. `conversations.last_reengage_at` — stamp for the dormant-funnel
--      nudge. The same cron sends at most ONE gentle check-in per
--      silence lull (agent spoke last, customer silent 6-23h — still
--      inside Meta's 24h customer-service window). A nudge is only
--      allowed when last_reengage_at predates the customer's newest
--      message, i.e. one nudge per lull, ever.
--
-- Mirrors the ai_scheduled_reminders (migration 015) queue + cron
-- pattern. Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_match_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  recipient_phone TEXT NOT NULL,
  -- Which side of the marketplace is waiting:
  --   sponsor — customer wants a maid; sweep searches maid_profiles_public
  --   maid    — customer wants a job;  sweep searches jobs
  side TEXT NOT NULL CHECK (side IN ('sponsor', 'maid')),
  -- Normalized search criteria (see src/lib/ai/matching.ts for shape).
  criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Language the notification should be composed in.
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'ar', 'am')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'notified_max', 'cancelled', 'expired', 'failed')),
  last_checked_at TIMESTAMPTZ,
  last_notified_at TIMESTAMPTZ,
  notify_count INT NOT NULL DEFAULT 0,
  max_notifications INT NOT NULL DEFAULT 3,
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sweep index — only active rows are ever scanned.
CREATE INDEX IF NOT EXISTS idx_ai_match_alerts_sweep
  ON ai_match_alerts(last_checked_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ai_match_alerts_user
  ON ai_match_alerts(user_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_match_alerts_conversation
  ON ai_match_alerts(conversation_id);

ALTER TABLE ai_match_alerts ENABLE ROW LEVEL SECURITY;

-- Owner visibility for future UI. The cron uses service role (bypasses RLS).
DROP POLICY IF EXISTS "Users can view own match alerts" ON ai_match_alerts;
CREATE POLICY "Users can view own match alerts" ON ai_match_alerts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can cancel own match alerts" ON ai_match_alerts;
CREATE POLICY "Users can cancel own match alerts" ON ai_match_alerts
  FOR UPDATE USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_match_alerts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ai_match_alerts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- conversations.last_reengage_at — one dormant-funnel nudge per lull.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_reengage_at TIMESTAMPTZ;
