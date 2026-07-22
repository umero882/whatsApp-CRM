# Email channel — deploy & go-live runbook

> **Status: HELD.** Nothing here has been run. Every step below is a production
> action. Execute only on explicit go-ahead. The code is complete on
> `feat/email-channel` (CRM) and `feat/admin-mobile-crm-whatsapp` (admin-mobile),
> unpushed. Full CRM suite green (404/404), tsc clean.

## Why there is no "Email" entry on crm.ethiopianmaids.com yet
1. **Not deployed** — the live CRM runs `main` (Coolify auto-deploy). All email
   code is on `feat/email-channel`, unpushed.
2. **No data until ingestion runs** — even deployed, the inbox lists an email
   conversation only after OAuth is seeded, the Gmail watch is registered, and a
   real customer email lands (creating a `channel='email'` conversation).

Both gates below must be lifted to see it live.

---

## A. Google Cloud (one-time, external)
1. **OAuth client** (Web or Desktop) in the GCP project. Run a one-time consent
   for **`nextechlabs.dev@gmail.com`** with scopes `gmail.modify` + `gmail.send`;
   capture the **refresh token**. Record client id/secret.
2. **Pub/Sub topic** (e.g. `gmail-inbound`): grant
   `gmail-api-push@system.gserviceaccount.com` the **Publisher** role on the topic
   (this is Gmail's push identity — it is *not* the OIDC SA below).
3. **Push subscription** → `https://crm.ethiopianmaids.com/api/email/pubsub`, with
   **OIDC auth**: pick/create a service account and set an **audience** string.
   - audience → `EMAIL_PUBSUB_AUDIENCE`
   - subscription's OIDC service-account email → `EMAIL_PUBSUB_SA_EMAIL`
   (Our route hard-requires the audience and verifies the SA email — I1 fix.)

## B. CRM env (Coolify) — set, then restart/redeploy so they load
| Var | Value |
|---|---|
| `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` | from A.1 |
| `EMAIL_MAILBOX` | `nextechlabs.dev@gmail.com` |
| `EMAIL_FROM` | `"Ethiopian Maids Support" <nextechlabs.dev@gmail.com>` (optional; this is the default) |
| `EMAIL_PUBSUB_TOPIC` | e.g. `projects/<proj>/topics/gmail-inbound` |
| `EMAIL_PUBSUB_AUDIENCE` | from A.3 |
| `EMAIL_PUBSUB_SA_EMAIL` | from A.3 |
| `AUTOMATION_CRON_SECRET` | already set (shared with other crons) — reuse |
| `ENCRYPTION_KEY` | already set — the seed script in D **must** use this same key |

## C. Apply the migration
Run `supabase/migrations/022_email_channel.sql` against the prod Supabase
(SQL editor or CLI). Idempotent. Adds `channel='email'`, threading columns,
`email_sync_state`, `email_oauth`, and the race-guard unique indexes (M1).

## D. Seed the encrypted refresh token
Locally, with `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the
**prod** `ENCRYPTION_KEY` exported:
```bash
npx tsx scripts/seed-email-oauth.ts nextechlabs.dev@gmail.com "<REFRESH_TOKEN>"
```
Writes the AES-256-GCM-encrypted token into `email_oauth`. Must use the prod
`ENCRYPTION_KEY` or the server can't decrypt it.

## E. Deploy the CRM code
Merge/push `feat/email-channel` → `main`. Coolify builds; verify the container
image tag == the new SHA and `/app/.next` contains the change (per the CRM
deploy convention).

## F. Register the initial Gmail watch (+ schedule renewal)
```bash
curl -s -H "x-cron-secret: <AUTOMATION_CRON_SECRET>" \
  https://crm.ethiopianmaids.com/api/email/watch/cron
# -> { ok: true, historyId: ..., expiration: ... }
```
Gmail watches expire ~7 days — add a **daily** external pinger hitting the same
URL/header so `email_sync_state` stays fresh.

## G. Activate the email persona (LIVE DB — authoritative)
The runtime agent reads `ai_agent_config.system_prompt`; the code copy is inert.
**Append** the email block (from `docs/email-agent-persona.md`) to the existing
Habiba prompt — do **not** replace it, or the WhatsApp persona is lost:
```sql
-- Verify the target row first:
SELECT user_id, left(system_prompt, 80) FROM ai_agent_config
WHERE user_id = (SELECT user_id FROM whatsapp_config ORDER BY created_at LIMIT 1);

-- Then append (paste the email block from docs/email-agent-persona.md):
UPDATE ai_agent_config
SET system_prompt = system_prompt || E'\n\n' || $$<EMAIL BLOCK HERE>$$,
    updated_at = now()
WHERE user_id = (SELECT user_id FROM whatsapp_config ORDER BY created_at LIMIT 1);
```

## H. admin-mobile OTA
Only after A–G verify: EAS-OTA the Email tab (preview channel → prod, per the
admin-mobile OTA note).

## I. Smoke test
From a controlled address, email `nextechlabs.dev@gmail.com`. Expect: a
`channel='email'` conversation in the CRM inbox **and** the admin-mobile Email
tab; the AI auto-answers an FAQ, or escalates (sets `ai_paused_until`) on a
sensitive one. Send a human reply from both the web inbox and the mobile tab and
confirm it threads back to the sender.
```

---

**Order:** A → B → C → D → E → F → G → H → I. Steps C–D (Supabase) are
independent of the CRM container and can run before E; the watch (F) and OTA (H)
require E first.
