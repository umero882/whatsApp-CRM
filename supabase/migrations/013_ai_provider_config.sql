-- ============================================================
-- AI Provider Config — BYO-LLM reply copilot.
--
-- One row per user. Stores which LLM provider to use, model name,
-- and (encrypted) API key. The key is encrypted at the application
-- layer with the same AES-256-GCM scheme used for the WhatsApp
-- access token (see src/lib/whatsapp/encryption.ts), so this
-- column always contains an opaque blob — never plaintext.
--
-- Provider options:
--   openai      — uses OpenAI Chat Completions API
--   anthropic   — uses Anthropic Messages API
--   openrouter  — uses OpenRouter (OpenAI-compatible API)
--   ollama      — uses local Ollama, no API key required
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_provider_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'ollama')),
  model TEXT NOT NULL,
  base_url TEXT,
  encrypted_api_key TEXT,
  system_prompt TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_config_user_id ON ai_provider_config(user_id);

ALTER TABLE ai_provider_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own AI provider config" ON ai_provider_config;
CREATE POLICY "Users can manage own AI provider config" ON ai_provider_config
  FOR ALL USING (auth.uid() = user_id);

-- Reuse the existing updated_at trigger function (created in 001_initial_schema).
DROP TRIGGER IF EXISTS set_updated_at ON ai_provider_config;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ai_provider_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
