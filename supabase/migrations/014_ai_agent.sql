-- ============================================================
-- AI Reply Agent — autonomous customer-service that reads inbound
-- WhatsApp messages, decides what to do (via LLM tool calling),
-- and sends the reply itself.
--
-- What this migration adds:
--
--   1. `ai_agent_config` — one row per user. Holds the agent's
--      role/voice prompt, business identity, tool credentials
--      (Hasura URL + admin secret, encrypted), and runtime knobs
--      (max_turns, human_pause_minutes).
--
--   2. `messages.agent_kind` — distinguishes 'human' from 'ai'
--      authorship on outbound messages so the inbox can label
--      AI replies clearly. Customers never see this field — on
--      WhatsApp it's a normal message from the business.
--      Customers still get sender_type='customer'; 'agent_kind' is
--      only meaningful when sender_type='agent'.
--
--   3. `conversations.ai_paused_until` — when a human-sent message
--      lands, this gets set to now() + ai_agent_config.human_pause_minutes.
--      The agent runner respects this and stays silent until elapsed.
--
-- LLM provider/model is REUSED from ai_provider_config (migration 013);
-- there's no point asking the user for two model configs. The agent
-- inherits whatever the user picked there.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_agent_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  business_name TEXT,
  -- The agent's PERSONA prompt (role, voice, hard rules). Server
  -- always appends a separate format/tool directive so this can be
  -- freely edited by the user without breaking the wire contract.
  system_prompt TEXT,
  -- Anti-runaway cap: max number of LLM turns per inbound message.
  -- One turn = one LLM call. Tool calls count as a turn each.
  max_turns INT NOT NULL DEFAULT 4 CHECK (max_turns BETWEEN 1 AND 12),
  -- When a human replies, how long the agent stays silent.
  human_pause_minutes INT NOT NULL DEFAULT 60 CHECK (human_pause_minutes >= 0),
  -- Tool integration: Hasura endpoint for the Ethiopian Maids data.
  -- Admin secret stored encrypted with the same AES-256-GCM scheme
  -- as the WhatsApp access token (see src/lib/whatsapp/encryption.ts).
  hasura_url TEXT,
  encrypted_hasura_admin_secret TEXT,
  -- List of tool names the agent is allowed to call (whitelist).
  -- Empty/null = all registered tools enabled.
  enabled_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_config_user_id ON ai_agent_config(user_id);

ALTER TABLE ai_agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own AI agent config" ON ai_agent_config;
CREATE POLICY "Users can manage own AI agent config" ON ai_agent_config
  FOR ALL USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_agent_config;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ai_agent_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- messages.agent_kind — label outbound AI vs human messages.
-- Defaults to 'human' so all existing rows + future human sends
-- need no special handling. AI runner sets this to 'ai'.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS agent_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (agent_kind IN ('human', 'ai'));

CREATE INDEX IF NOT EXISTS idx_messages_agent_kind ON messages(agent_kind)
  WHERE agent_kind = 'ai';

-- ============================================================
-- conversations.ai_paused_until — human takeover pause window.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_ai_paused
  ON conversations(ai_paused_until)
  WHERE ai_paused_until IS NOT NULL;
