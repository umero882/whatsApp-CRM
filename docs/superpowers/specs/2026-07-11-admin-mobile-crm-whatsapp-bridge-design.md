# Admin-Mobile ↔ CRM WhatsApp Bridge — Design

**Date:** 2026-07-11
**Status:** Approved (approach + auth locked with user)
**Branch:** `feat/admin-mobile-crm-whatsapp`

## Goal

Make the Ethiopian Maids **admin-mobile** app's WhatsApp screen operate against the **live CRM** (`crm.ethiopianmaids.com`, Supabase + Meta Cloud API) instead of the retired Firebase-Functions + Hasura `whatsapp_messages` stack. Same WhatsApp number, same UI — pointed at the one backend that actually receives messages.

## Background (verified 2026-07-11)

Both stacks target the **same Meta number**: `phone_number_id 1023329570860164`, `waba_id 926566973072766`.

| | Old — admin-mobile (dormant, not working) | New — CRM (live) |
|---|---|---|
| Store | Hasura `whatsapp_messages` | Supabase `messages` / `conversations` / `contacts` |
| Send + webhook | Firebase Functions (`whatsappWebhook`, `whatsappAdminReply`, `whatsappSetConversationMode`) | Next.js `/api/whatsapp/*` |
| AI/manual | Firestore `whatsapp_conversation_state` | `conversations.ai_paused_until` + `ai_agent_config` |
| Auth | Firebase Auth (`user_type:'admin'`, Hasura claim `site_admin`) | Supabase Auth |

Meta's webhook now points at the CRM (`crm.sheger.cloud`), so the old Firebase feed is dormant. The user confirmed the old admin path is dead — so it is **retired, not preserved** (no Hasura mirror, no dual-run). This also removes any double-AI-reply risk.

## Architecture

The CRM exposes a small **mobile API** (`/api/mobile/whatsapp/*`) authenticated by the app's **Firebase ID token**, verified server-side. The admin-mobile WhatsApp screen swaps its Apollo/Hasura queries + Firebase callables for these endpoints. The CRM stays the single source of truth; its existing AI-pause logic remains authoritative.

```
admin-mobile (Expo, Firebase Auth)
        │  Authorization: Bearer <firebase ID token>
        ▼
CRM  /api/mobile/whatsapp/*   ──verifyMobileAdmin()──►  maps to CRM owner user_id
        │                                                 (whatsapp_config owner)
        ▼
Supabase (conversations / messages / contacts)  +  Meta Cloud API (send)
```

## Auth bridge — `verifyMobileAdmin(request)`

New: `src/lib/mobile/firebase-verify.ts` + `src/lib/mobile/auth.ts`.

1. Read `Authorization: Bearer <token>`. Missing → 401.
2. Verify the RS256 JWT against Google's Secure Token public keys
   (JWKS `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`, cached by `Cache-Control` max-age) with `jose.jwtVerify`. **No Firebase service-account secret required** — verification only.
3. Claim checks (all required):
   - `iss === 'https://securetoken.google.com/ethiopian-maids'`
   - `aud === 'ethiopian-maids'`
   - `exp` in the future, `sub` non-empty
   - **admin:** `payload.user_type === 'admin'` OR the Hasura claim
     `payload['https://hasura.io/jwt/claims']['x-hasura-default-role'] === 'site_admin'`
     (or `site_admin` ∈ `x-hasura-allowed-roles`).
4. Resolve CRM tenant: `user_id` = env `CRM_WHATSAPP_OWNER_USER_ID`, falling back to the sole `whatsapp_config` row with `status='connected'`. Cache the fallback per process.
5. Return `{ userId, firebaseUid }`. Any failure → 401 (never leak which check failed beyond a generic message; log detail server-side).

Firebase project id (`ethiopian-maids`) is a constant in code; JWKS URL is public. Nothing secret is added to the CRM.

## Endpoints (all `verifyMobileAdmin`-guarded, JSON, `user_id`-scoped)

All read/write goes through `supabaseAdmin()` (service role) but is **always** filtered by the resolved `userId` — never trust a client-supplied user id.

### `GET /api/mobile/whatsapp/conversations?limit&offset&search`
List conversations for the tenant, newest activity first. Returns:
```jsonc
{ "conversations": [ {
    "id", "phone", "name", "last_message_text", "last_message_at",
    "unread_count", "ai_active": boolean   // ai_paused_until null or in the past
} ], "total": number }
```
`search` filters on contact phone/name (ilike). `limit` default 50 (max 100), `offset` default 0.

### `GET /api/mobile/whatsapp/conversations/:id/messages?limit`
Thread for one conversation (must belong to tenant → else 404), ascending by `created_at`. `limit` default 100 (max 200). Each message:
```jsonc
{ "id", "role", "text", "type", "media_url", "ai_summary", "status", "created_at" }
```
`role` mapping from CRM → app bubbles:
- `sender_type='customer'` → `"user"`
- `sender_type='agent'` & `agent_kind='human'` → `"admin"`
- `sender_type='agent'` & `agent_kind='ai'` → `"assistant"`
- `sender_type='bot'` → `"assistant"`

`text` prefers `content_text`; falls back to `ai_media_summary` for media-only inbound. `type` = `content_type`.

### `POST /api/mobile/whatsapp/conversations/:id/reply`  `{ text }`
Sends a human WhatsApp reply through the shared send core (below). Pauses the AI (same as web send). Returns `{ success, message_id, whatsapp_message_id }`. 24h-window / Meta errors surface as 4xx/502 with the Meta message.

### `POST /api/mobile/whatsapp/conversations/:id/ai-mode`  `{ mode: 'ai' | 'manual' }`
- `manual` → set `conversations.ai_paused_until` to a far-future sentinel (`'2999-01-01T00:00:00Z'`) = indefinite manual.
- `ai` → set `ai_paused_until = null` = AI resumes.
Returns `{ success, ai_active }`.

### `GET /api/mobile/whatsapp/stats`
`{ today, week, total, inbound_today, outbound_today }` — counts over the tenant's messages (join conversations on user_id). Powers the KPI tiles.

## Shared send core (refactor)

Extract the body of `POST /api/whatsapp/send` into
`src/lib/whatsapp/send-message.ts` → `sendConversationMessage({ userId, conversationId, text, replyToMessageId? })`, returning `{ crmMessageId, waMessageId }` or throwing typed errors. Behavior identical (phone variants, AI-pause, flow-pause, DB insert). Both the session route and the mobile reply route call it. This keeps one code path for sending — no drift.

## Admin-mobile changes (`apps/admin-mobile`)

- **Config:** `EXPO_PUBLIC_CRM_API_URL=https://crm.ethiopianmaids.com` in `.env` + `app.config.js` `extra`.
- **New `services/crmWhatsapp.ts`:** typed fetch wrappers; each call does `await auth.currentUser.getIdToken()` and sets the bearer header; base URL from config; maps CRM JSON → the screen's existing view types.
- **Rewire `app/(drawer)/comms/whatsapp.tsx`:** replace the three `useQuery` calls + `adminReplyFn`/`setModeFn` (Firebase callables) with `crmWhatsapp` calls. The FlashList, bottom sheet, KPI tiles, AI/Manual switch, and 24h-window logic are unchanged — only the data source swaps. Use React Query (already a dep) or `useState`+`useEffect` polling for the list/thread; refetch after reply/toggle.
- **Retire old path:** remove the app's imports of `GET_ADMIN_WHATSAPP_MESSAGES/_STATS`, `GET_WHATSAPP_CONVERSATION`, and the two Firebase WhatsApp callables from this screen. The Cloud Functions stay deployed-but-unused; the Hasura `whatsapp_messages` table becomes a read-only archive. No mobile code should reference them after this.

## Data mappings summary

| App concept | CRM source |
|---|---|
| message log row | `conversations` + latest `messages` |
| conversation thread | `messages` where `conversation_id` |
| sender bubble | `sender_type` + `agent_kind` (see role map) |
| AI Active / Manual | `ai_paused_until` (null/past = AI; far-future = manual) |
| 24h window | last `sender_type='customer'` message `created_at` |
| send reply | `sendConversationMessage()` |

## Testing

**CRM (vitest):**
- `firebase-verify` / `verifyMobileAdmin`: valid admin token → `{userId}`; expired → 401; bad signature → 401; wrong `iss`/`aud` → 401; valid token **without** admin claim → 401; missing header → 401. Google JWKS + `jose` mocked; sign test tokens with a local RSA keypair.
- Owner resolution: env present → used; env absent → sole connected `whatsapp_config`.
- Endpoints: tenant scoping (conversation of another user → 404), role mapping, ai-mode set/clear, stats shape. Supabase mocked.
- `sendConversationMessage`: refactor covered by existing send behavior + a focused unit test (AI-pause set, message row inserted, phone-variant retry).

**Mobile (jest):** rewired screen renders list/thread from mocked `crmWhatsapp` responses; reply calls the reply endpoint; toggle calls ai-mode. `auth.currentUser.getIdToken` mocked.

## Deployment

- **CRM:** merge → Coolify deploy (established flow). Add `CRM_WHATSAPP_OWNER_USER_ID` to Coolify env (optional; fallback works). No DB migration needed.
- **Mobile:** ships via EAS — **user action**. `eas update` (OTA) if the JS-only change qualifies, else an EAS build. Flagged in the handoff.
- **⚠️ Meta (user action):** confirm only the CRM app is subscribed to WABA `926566973072766` webhooks, so the dormant Firebase app can't double-process.

## Out of scope

- Media **sending** from the app (text replies only this pass; inbound media already renders via `ai_media_summary`).
- Templates / flows from the app (old `whatsappSendTemplate` etc. stay as-is, unused by this screen).
- Migrating historical `whatsapp_messages` rows into Supabase (old table remains an archive).
- Multi-tenant admin (single WhatsApp-owner tenant assumed, matching today's reality).
