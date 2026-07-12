-- ============================================================
-- Omnichannel foundation — one inbox + one AI agent across
-- WhatsApp, Instagram DM, Facebook Messenger, and Telegram.
--
--   conversations.channel — which platform this thread lives on.
--     Everything existing is WhatsApp, hence the default; new
--     channels are wired in follow-up phases (Meta social, Telegram).
--
--   contacts.external_id — the platform-scoped user id for
--     non-phone channels (IG-scoped ID, Messenger PSID, Telegram
--     chat id). WhatsApp contacts keep using `phone`.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('whatsapp', 'instagram', 'messenger', 'telegram'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations(user_id, channel);

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS external_id TEXT;

-- Fast lookup of a contact by platform id on inbound webhooks.
CREATE INDEX IF NOT EXISTS idx_contacts_external_id
  ON contacts(user_id, external_id)
  WHERE external_id IS NOT NULL;
