# Admin-Mobile ↔ CRM WhatsApp Bridge — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use `- [ ]` checkboxes. Spec: `docs/superpowers/specs/2026-07-11-admin-mobile-crm-whatsapp-bridge-design.md`.

**Goal:** Point the admin-mobile WhatsApp screen at the live CRM via a Firebase-ID-token-guarded mobile API.

**Tech:** Next.js 16 (CRM) + Supabase + `jose`; Expo/React Native (admin-mobile) + Firebase Auth. Vitest / Jest.

## Global Constraints

- Firebase project id: `ethiopian-maids`. Admin claim: `user_type==='admin'` OR Hasura `x-hasura-default-role==='site_admin'`.
- Meta number is shared and already CRM-owned; **no DB migration**.
- Every mobile endpoint is `verifyMobileAdmin`-guarded and scoped to the resolved `userId` via `supabaseAdmin()`. Never trust a client user id.
- Manual sentinel: `ai_paused_until = '2999-01-01T00:00:00Z'`. AI resume: `null`.
- Role map: customer→user; agent+human→admin; agent+ai→assistant; bot→assistant.
- Text replies only; no schema changes; old Firebase/Hasura path is retired, not preserved.

---

### Task 1 — Firebase token verification + `verifyMobileAdmin`

**Files:** Create `src/lib/mobile/firebase-verify.ts`, `src/lib/mobile/auth.ts`, `src/lib/mobile/firebase-verify.test.ts`, `src/lib/mobile/auth.test.ts`.

**Interfaces produced:**
- `verifyFirebaseIdToken(token: string): Promise<FirebasePayload>` — throws on invalid.
- `verifyMobileAdmin(request: Request): Promise<{ userId: string; firebaseUid: string }>` — throws `MobileAuthError` (has `.status=401`).
- `isMobileAuthError(e): boolean`.

**Steps**
- [ ] Test first: mock JWKS + sign tokens with a local RSA keypair (`jose.generateKeyPair('RS256')`, `SignJWT`). Cases: valid admin (user_type), valid admin (site_admin claim), expired, bad signature (2nd key), wrong iss, wrong aud, non-admin claim, missing header. Owner resolution: env vs sole connected `whatsapp_config` (Supabase mocked).
- [ ] Implement `firebase-verify.ts`: `createRemoteJWKSet(new URL(JWKS_URL))`, `jwtVerify(token, jwks, { issuer, audience })`; then assert admin claim; export payload type.
- [ ] Implement `auth.ts`: parse bearer header; call verify; resolve `userId` (env `CRM_WHATSAPP_OWNER_USER_ID` → else `supabaseAdmin().from('whatsapp_config').select('user_id').eq('status','connected')` single, memoized); wrap failures as `MobileAuthError(401)`.
- [ ] Run tests → green. Typecheck. Commit.

### Task 2 — Shared send core

**Files:** Create `src/lib/whatsapp/send-message.ts` + `.test.ts`; Modify `src/app/api/whatsapp/send/route.ts` to delegate.

**Interfaces produced:** `sendConversationMessage({ userId, conversationId, text, replyToMessageId? }): Promise<{ crmMessageId: string; waMessageId: string }>` — throws `SendError` with `.status`.

**Steps**
- [ ] Extract the existing send body (conversation+contact lookup, config decrypt/legacy-upgrade, phone-variant Meta send, message insert, AI-pause, flow-pause, conversation update) verbatim into `sendConversationMessage`, keyed by `userId` instead of the session user. Keep all behavior.
- [ ] Rewrite `send/route.ts` as: auth (`supabase.auth.getUser`) + rate limit + parse → `sendConversationMessage({ userId: user.id, ... })` → map `SendError.status` to the response. Text path only needs `text`; keep template path in the route (out of the shared core) OR include a `template` variant — **decision: keep template in the route**, core handles text.
- [ ] Test `sendConversationMessage`: inserts `sender_type='agent', agent_kind='human'`, sets `ai_paused_until` when agent enabled, returns ids (Meta + Supabase mocked). Existing send route behavior preserved.
- [ ] Run tests. Typecheck. Commit.

### Task 3 — Read endpoints

**Files:** Create `src/app/api/mobile/whatsapp/conversations/route.ts`, `src/app/api/mobile/whatsapp/conversations/[id]/messages/route.ts`, shared `src/lib/mobile/serializers.ts` (+ tests).

**Steps**
- [ ] Test `serializers.ts`: `roleForMessage(sender_type, agent_kind)` map; `serializeConversation`, `serializeMessage` (text falls back to `ai_media_summary`).
- [ ] Implement `GET /conversations`: `verifyMobileAdmin` → query `conversations` join `contacts` `.eq('user_id', userId)` order `last_message_at desc`, `range(offset, offset+limit-1)`, optional `ilike` search on contact; compute `ai_active`; return `{conversations,total}` (count via `head:true` count query).
- [ ] Implement `GET /conversations/[id]/messages`: verify tenant owns conversation (`.eq('id',id).eq('user_id',userId)` → 404); fetch messages asc; serialize.
- [ ] Endpoint tests: scoping (other tenant → 404), pagination clamp, role mapping. Supabase + auth mocked.
- [ ] Run tests. Typecheck. Commit.

### Task 4 — Write endpoints + stats

**Files:** Create `.../conversations/[id]/reply/route.ts`, `.../conversations/[id]/ai-mode/route.ts`, `.../stats/route.ts` (+ tests).

**Steps**
- [ ] `POST /reply`: verify → confirm tenant owns conversation → `sendConversationMessage({userId, conversationId:id, text})` → map errors → `{success, message_id, whatsapp_message_id}`.
- [ ] `POST /ai-mode`: verify → own conversation → set `ai_paused_until` = sentinel (manual) / null (ai) → `{success, ai_active}`. Validate `mode ∈ {ai,manual}` (400 else).
- [ ] `GET /stats`: verify → count queries over `messages` joined to tenant conversations for today/week/total + inbound/outbound today (`sender_type` split). Return the five numbers.
- [ ] Tests: reply happy + Meta-error passthrough; ai-mode set/clear + bad mode 400; stats shape. Mocked.
- [ ] Run tests. Typecheck. Commit.

### Task 5 — Mobile CRM service + config

**Files (monorepo `apps/admin-mobile`):** Create `services/crmWhatsapp.ts`; Modify `.env`, `app.config.js` (`extra.crmApiUrl`), `utils/` config accessor.

**Interfaces produced:** `listConversations`, `getMessages`, `sendReply`, `setAiMode`, `getStats` — all returning typed view models the screen already expects.

**Steps**
- [ ] Add `EXPO_PUBLIC_CRM_API_URL=https://crm.ethiopianmaids.com` to `.env`; expose via `app.config.js` extra + a small `getCrmApiUrl()`.
- [ ] Implement `crmWhatsapp.ts`: `authedFetch(path, init)` → `getIdToken()` bearer + base url + JSON + error surface. Five functions mapping CRM JSON → screen types (reuse `AdminWhatsappMessageRow`-shaped objects so the UI needn't change field names, or adapt in-mapper).
- [ ] Jest: `authedFetch` attaches token; each function parses a sample CRM payload. `auth.currentUser.getIdToken` + `fetch` mocked.
- [ ] Run jest. Typecheck (`tsc`/expo). Commit (monorepo).

### Task 6 — Rewire the screen + retire old path

**Files:** Modify `app/(drawer)/comms/whatsapp.tsx`; remove old imports.

**Steps**
- [ ] Replace `useQuery(GET_ADMIN_WHATSAPP_MESSAGES/_STATS)` and the conversation `useQuery` with `crmWhatsapp.listConversations/getStats/getMessages` (React Query or `useState`+`useEffect`; keep FlashList/sheet/KPIs/switch identical). Row key becomes conversation id; tap opens by conversation id (not phone).
- [ ] Replace `adminReplyFn`→`crmWhatsapp.sendReply(conversationId, text)`; `setModeFn`→`crmWhatsapp.setAiMode(conversationId, mode)`. Keep 24h logic (derive from last `role==='user'` message).
- [ ] Delete the now-unused `@ethio/admin-shared` WhatsApp query imports + `httpsCallable` WhatsApp callables from this file.
- [ ] Update `__tests__/screens/commsScreens.test.tsx` to mock `crmWhatsapp`. Run jest. Typecheck. Commit.

---

## Deploy / handoff

- CRM: merge → Coolify deploy; optionally set `CRM_WHATSAPP_OWNER_USER_ID`.
- Mobile: EAS build / `eas update` — **user action**.
- Meta: ensure only the CRM app is subscribed to WABA `926566973072766`.
