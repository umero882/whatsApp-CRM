-- ============================================================
-- Email contacts have no phone number. `contacts.phone` was NOT NULL
-- (a WhatsApp-era assumption — every WhatsApp contact has a phone).
-- Email ingestion keys contacts on `external_id` (the email address,
-- migration 022) and inserts no phone, so the NOT NULL constraint
-- rejected every inbound email contact. Relax it.
--
-- Safe: WhatsApp code always supplies phone, so existing rows and the
-- WhatsApp path are unaffected. Idempotent.
-- ============================================================

ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
