-- ============================================================
-- 025: RLS hardening (security audit 2026-09-22)
-- ============================================================
--
-- Two findings from the audit, both verified against the live catalog
-- (pg_policies / information_schema.role_table_grants) before writing this.
--
-- 1. messages: the 001 policy "Service role can insert messages" was
--    FOR INSERT WITH CHECK (true) with no TO clause, i.e. bound to PUBLIC.
--    The service role bypasses RLS anyway, so the policy granted nothing to
--    it — what it granted was INSERT to `anon` and `authenticated`: anyone
--    holding the public anon key could write a row into ANY conversation.
--    Every application write to messages goes through the service-role
--    client (webhook, agent, email pipeline, mobile, flows, automations),
--    and a user-session write into the user's own conversation is still
--    allowed by the remaining FOR ALL policy (its USING doubles as WITH
--    CHECK). Nothing legitimate needs this policy. Drop it.
--
-- 2. email_oauth / email_sync_state (022) were created without RLS. With
--    Supabase's default grants that leaves anon/authenticated with full DML:
--    the (encrypted) Gmail refresh token row could be deleted or truncated,
--    and the Gmail history cursor rewritten, by anyone with the anon key.
--    Both tables are only ever touched by the service-role client
--    (src/lib/email/oauth.ts, email/pubsub, email/watch/cron). Enable RLS
--    with no policies (= deny for every non-bypass role) and revoke the
--    default grants so the tables never show up through PostgREST for
--    anon/authenticated at all.
--
-- Idempotent: safe to re-run.

DROP POLICY IF EXISTS "Service role can insert messages" ON messages;

ALTER TABLE email_oauth      ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sync_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE email_oauth      FROM anon, authenticated;
REVOKE ALL ON TABLE email_sync_state FROM anon, authenticated;

-- automation_pending_executions (006) already has RLS on and no policies —
-- service-role only by construction. Revoke the default grants there too so
-- it matches the two tables above and cannot regress if RLS is ever toggled.
REVOKE ALL ON TABLE automation_pending_executions FROM anon, authenticated;

-- ── Verification (run after applying) ──────────────────────────────────
-- select tablename, policyname, roles, with_check from pg_policies
--   where tablename = 'messages';
--   -- expect exactly one row: "Users can view own messages"
-- select table_name, grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_name in ('email_oauth','email_sync_state','automation_pending_executions')
--     and grantee in ('anon','authenticated');
--   -- expect zero rows
