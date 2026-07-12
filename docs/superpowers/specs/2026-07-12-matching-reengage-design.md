# Two-Sided Matching + Re-Engage — Design

**Date:** 2026-07-12
**Status:** Approved (autonomous session — derived from existing roadmap item "Two-sided matching + re-engage")

## Problem

The AI agent today is purely reactive: it only speaks when a customer messages first.
Two revenue leaks follow:

1. **Lost matches.** A sponsor asks for a live-in nanny in Dubai, `search_maids`
   returns nothing, the agent apologizes, and the lead dies — even if a perfect
   candidate registers two days later. Same on the maid side: no active job in her
   destination today means she never hears about tomorrow's posting.
2. **Dormant funnels.** Customers frequently go silent mid-qualification. Nobody
   nudges them, and after Meta's 24-hour customer-service window closes, free-form
   messages can no longer be sent at all.

## Solution overview

Two cooperating capabilities, both deterministic (no LLM calls on the proactive path),
drained by one new cron route in the same pattern as `/api/ai/reminders/cron`:

### A. Match alerts (two-sided matching)

- New table **`ai_match_alerts`**: a saved search per conversation + side
  (`sponsor` wants maids, `maid` wants jobs), with criteria JSONB, language,
  watermark timestamps, notify caps, and expiry (30 days).
- New agent tool **`save_match_alert`**: the agent offers it when a search comes
  up empty (or thin) and the customer agrees to be notified. Handler replaces any
  existing active alert for the same conversation + side.
- The cron sweep re-runs each active alert's search against Hasura and, when **new**
  rows appear (created/updated after the alert watermark), sends the customer a short
  WhatsApp message with the top matches. Sponsors are notified about new maids; maids
  about new jobs — both sides of the marketplace close the loop.

### B. Dormant re-engage

- Conversations where the **agent spoke last** and the customer has been silent
  6–23 h get ONE gentle, language-matched nudge — deliberately inside Meta's 24 h
  window so a free-form send is still legal. A new `conversations.last_reengage_at`
  column guarantees at most one nudge per silence lull.

### Meta 24 h window strategy

- Dormant nudges are **scheduled inside the window by construction** (≤23 h).
- Match alerts can fire days later (outside the window). The sweep tries a free-form
  text first; when Meta rejects with the re-engagement error (code 131047), it falls
  back to a pre-approved template if `REENGAGE_TEMPLATE_NAME` is configured
  (via existing `sendTemplateMessage`), else records the failure and retries on a
  later sweep (up to 3 attempts, then status `failed`).

## Approaches considered

1. **Deterministic DB-backed alerts + cron sweep (CHOSEN).** Reuses the proven
   `ai_scheduled_reminders` → cron pattern, zero LLM cost, fully unit-testable pure
   helpers, messages persisted into the inbox like all other traffic.
2. **LLM-driven proactive runs** (run the agent on a cron for dormant conversations).
   Richer copy, but the agent architecture assumes a pending customer turn (race
   guard), adds token cost + hallucination risk on unsolicited sends. Rejected.
3. **Extend the automations/flows engine.** It is user-configurable and generic;
   marketplace matching against Hasura is tenant-specific logic that doesn't belong
   there. Rejected.

## Components

| Unit | Purpose | Depends on |
|---|---|---|
| `supabase/migrations/016_ai_match_alerts.sql` | `ai_match_alerts` table + `conversations.last_reengage_at` | — |
| `src/lib/ai/matching.ts` | Pure: criteria normalization, Hasura `where` builders (maid search / job search with watermark), match summarizers, localized notification composer | `tools/hasura` types only |
| `src/lib/ai/reengage.ts` | Pure: dormancy eligibility predicate, localized nudge composer | `agent.ts` (`detectLanguage`) |
| `save_match_alert` tool in `tools/ethiopian-maids.ts` | Agent-facing entry; cancel-then-insert alert row | `matching.ts`, registry |
| `src/app/api/ai/engagement/cron/route.ts` | Thin orchestration: match sweep + dormant sweep, per-user config loading, send + persist + counters | all above, `meta-api` |

### `ai_match_alerts` schema

```
id UUID PK, user_id UUID → auth.users, conversation_id UUID → conversations,
recipient_phone TEXT, side TEXT CHECK (sponsor|maid), criteria JSONB,
language TEXT CHECK (en|ar|am) DEFAULT en,
status TEXT CHECK (active|notified_max|cancelled|expired|failed) DEFAULT active,
last_checked_at TIMESTAMPTZ, last_notified_at TIMESTAMPTZ,
notify_count INT DEFAULT 0, max_notifications INT DEFAULT 3,
retry_count INT DEFAULT 0, last_error TEXT,
expires_at TIMESTAMPTZ DEFAULT now() + 30 days, created_at, updated_at
```

Partial index on `(last_checked_at)` where `status='active'`. RLS: owner read/update;
cron uses service role.

### Data flow — match sweep (every cron hit, batch ≤ 25)

1. Expire alerts past `expires_at`.
2. Pick active alerts with `last_checked_at IS NULL OR < now() - 30 min`.
3. Group by user → load `ai_agent_config` (Hasura creds) + `whatsapp_config` once.
4. Per alert: run side-appropriate Hasura query filtered to rows newer than
   `last_notified_at ?? created_at`. No new rows → stamp `last_checked_at`, done.
5. New rows → compose message (top 2 matches + "reply for details" CTA, in alert
   language), send text → fallback template → persist into `messages` +
   `conversations`, bump `notify_count`/watermarks; at cap → `notified_max`.

### Data flow — dormant sweep (batch ≤ 50)

1. Conversations `status='open'`, `last_message_at` between 23 h and 6 h ago.
2. Load last 2 messages: eligible iff last is agent-side, the newest customer
   message is < 24 h old, `ai_paused_until` not in the future, agent enabled,
   and `last_reengage_at` predates the newest customer message.
3. Send one nudge (language from last customer text), persist, stamp
   `last_reengage_at`.

## Error handling

- All sends are per-row try/catch: one bad alert/conversation never aborts the sweep.
- Meta window rejection detected by error text (`131047` / "re-engagement"); template
  fallback only for match alerts.
- Alert failures increment `retry_count`; 3 strikes → `status='failed'` (mirrors
  reminders cron).
- Missing per-user config (Hasura/WhatsApp) marks that user's alerts failed with a
  reason, same as reminders cron.

## Security

- Cron auth: `x-cron-secret` timing-safe compare against existing
  `AUTOMATION_CRON_SECRET` (identical to the other three cron routes).
- RLS on the new table; service-role only in the cron.
- No new secrets; template name via env `REENGAGE_TEMPLATE_NAME` (optional),
  language via `REENGAGE_TEMPLATE_LANG` (default `en`).

## Testing

Vitest, colocated: pure `where`-builders, watermark filtering, message composers
(en/ar/am), dormancy eligibility matrix (silent-customer, human-spoke-last,
window-expired, already-nudged, paused), criteria normalization, and the
131047-detection helper. Route stays thin; logic lives in the libs.

## Ops notes

- Provision the external pinger to hit `GET /api/ai/engagement/cron` every
  ~15 min with the existing cron secret (same pinger that hits
  `/api/ai/reminders/cron`).
- Apply migration 016 to the production Supabase before deploy.
- Optional: create + approve a Meta utility template and set
  `REENGAGE_TEMPLATE_NAME` to unlock outside-window match notifications.
