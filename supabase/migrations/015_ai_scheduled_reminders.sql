-- ============================================================
-- AI Scheduled Reminders — queue of future WhatsApp messages the
-- agent has committed to sending.
--
-- Use case: when book_interview schedules an interview for
-- "tomorrow 2pm", we want to ping the sponsor again at 1:45pm and
-- 1:55pm so they don't miss it. Each reminder is a row here with
-- due_at + message_text + recipient_phone + user_id (whose Meta
-- credentials send it).
--
-- A cron route (/api/ai/reminders/cron) drains rows where status='pending'
-- AND due_at <= now(), sends them via Meta API, then marks 'sent' (or
-- 'failed' with retry_count). Mirrors the pattern of
-- automation_pending_executions and flow_runs sweep.
--
-- We also track related_kind/related_id so the inbox/audit can show
-- which booking a reminder belonged to. No FK on related_id (the
-- related row may live in an external Hasura DB).
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_scheduled_reminders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  recipient_phone TEXT NOT NULL,
  message_text TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  failed_reason TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  related_kind TEXT,
  related_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cron drain index — cheapest possible: only pending rows whose
-- due_at is in the past need scanning.
CREATE INDEX IF NOT EXISTS idx_ai_reminders_due
  ON ai_scheduled_reminders(due_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ai_reminders_user
  ON ai_scheduled_reminders(user_id, status);

ALTER TABLE ai_scheduled_reminders ENABLE ROW LEVEL SECURITY;

-- Owner-only access for UI / future visibility. The cron route uses
-- service role and bypasses RLS.
DROP POLICY IF EXISTS "Users can view own reminders" ON ai_scheduled_reminders;
CREATE POLICY "Users can view own reminders" ON ai_scheduled_reminders
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can cancel own reminders" ON ai_scheduled_reminders;
CREATE POLICY "Users can cancel own reminders" ON ai_scheduled_reminders
  FOR UPDATE USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_scheduled_reminders;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ai_scheduled_reminders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
