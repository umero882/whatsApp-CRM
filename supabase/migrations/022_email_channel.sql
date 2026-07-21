-- ============================================================
-- Email as an omnichannel channel (builds on 019_omnichannel).
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. Allow channel='email' (rebuild the CHECK from 019 to add it).
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'messenger', 'telegram', 'email'));

-- 2. Email thread subject (null for non-email channels).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subject TEXT;

-- 3. Email threading metadata on messages (null for non-email rows).
--    messages.message_id already holds the provider id → we store the
--    RFC-822 Message-ID there for email, same as WhatsApp's wamid.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS email_thread_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS email_references TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS email_headers JSONB;

-- 4. Per-mailbox Gmail history cursor + watch expiry.
CREATE TABLE IF NOT EXISTS email_sync_state (
  mailbox          TEXT PRIMARY KEY,
  last_history_id  TEXT,
  watch_expiration TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Per-mailbox encrypted OAuth refresh token (AES-256-GCM, same scheme
--    as whatsapp_config.access_token).
CREATE TABLE IF NOT EXISTS email_oauth (
  mailbox                 TEXT PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup guard: one inbound row per (channel, provider Message-ID).
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_email_message_id
  ON messages(message_id)
  WHERE message_id IS NOT NULL AND email_thread_id IS NOT NULL;

-- 6. Race guards for the ingestion pipeline. Two overlapping Gmail pushes can
--    read the same startHistoryId concurrently; without a unique key both can
--    create a duplicate contact + an empty duplicate conversation for a
--    first-time sender before the message-level dedup above kicks in. These
--    make findOrCreate idempotent at the DB layer (the app also re-selects on
--    23505 — see persist.ts).
--
--    Contact key: (user_id, external_id). Only the email pipeline populates
--    contacts.external_id (WhatsApp never sets it), so the partial predicate
--    leaves every legacy WhatsApp contact (external_id NULL) untouched — the
--    unique index cannot fail on existing data. Replaces 019's non-unique
--    idx_contacts_external_id, which covered the identical predicate.
DROP INDEX IF EXISTS idx_contacts_external_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_user_external_id
  ON contacts(user_id, external_id)
  WHERE external_id IS NOT NULL;

--    Conversation key: one email thread per (user_id, contact_id). Scoped to
--    channel='email' so existing WhatsApp conversations (of which there may be
--    legitimate historical duplicates) are never constrained — no email rows
--    exist yet, so this cannot fail on apply.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_email_contact
  ON conversations(user_id, contact_id)
  WHERE channel = 'email';
