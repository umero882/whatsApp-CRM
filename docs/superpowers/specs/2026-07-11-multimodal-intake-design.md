# Multimodal Intake for the WhatsApp AI Agent — Design

- **Date:** 2026-07-11
- **Status:** Approved (design), pending implementation plan
- **Feature owner:** Ethiopian Maids WhatsApp CRM
- **Related:** competitive research (deep-research, 2026-07-11) — top-ranked "quick win"

## Problem

When a customer sends an **image** (passport / national ID / selfie), a **document** (PDF/DOCX), or a **voice note**, the AI agent currently sees only a placeholder — `stringifyHistoryMessage` renders `[image]` / `[audio]`, and `detectLanguage` falls back to English for voice. The agent therefore cannot read passports, acknowledge photos, or understand spoken messages, even though the webhook already downloads and proxies the media. For a recruitment marketplace this is the single most on-point gap: maids routinely submit passport scans and Amharic/Arabic voice notes.

## Goals (v1)

1. Turn inbound customer media into text the agent can read and respond to naturally, in the customer's language.
2. From a **passport / national ID** image, extract structured fields and **auto-fill blank** safe fields on the matching `maid_profiles` record.
3. Handle the sensitive ID number safely (do **not** write it raw) — flag it for human verification instead.
4. If the matched maid has **no passport document on file**, the agent asks for it and, on receipt, uploads the image into `maid_documents`. If a passport document already exists, do not ask and do not upload.
5. Surface the extraction in the **inbox** too, so human agents see "passport → Almaz, Ethiopian, exp 2028" instead of an empty bubble.

## Non-goals (v1)

- Writing the raw passport/ID **number** to any column (goes through human verification instead).
- Populating the app's `passport_number_encrypted` / `_hash` columns (the CRM cannot reach the app's encryption path) or `pii_access_log` (deferred).
- Uploading images to the app's **Firebase** bucket (v1 uses the CRM's own Supabase Storage; see Storage).
- Inbound **voice calls**, multi-page document parsing beyond first-page OCR, video understanding.

## Decisions (locked with user)

| Question | Decision |
|---|---|
| Scope of "act on it" | Converse **and** auto-fill maid profile |
| Voice transcription provider | **OpenAI Whisper** (`whisper-1`) — needs `OPENAI_API_KEY` |
| Vision provider | Reuse existing **OpenRouter `gpt-4o-mini`** (vision-capable) — no new key |
| Passport/ID number | Auto-write safe fields only; **number not written raw** → tag `passport_pending_verify` + internal note for the team |
| Field overwrite policy | Fill **blank** fields only; never overwrite existing profile values |
| Passport image upload | Conditional: **if no passport document on file → ask + upload**; else do nothing |

## Architecture — preprocess at ingestion

Extraction happens **once**, in the webhook's `processMessage`, right after the customer media message is inserted and **before** `runAgent` is dispatched. The result is persisted on the message row; the agent (and inbox) read from that row.

Rejected alternatives: (a) an agent *tool* the LLM calls on demand — `gpt-4o-mini` would have to reliably decide to call it and the media may be several turns back; (b) processing *inside* the agent loop — couples extraction to agent runs and hides it from the inbox. Preprocessing at ingestion is cached, independently testable, model-swappable, and benefits the inbox for free.

```
Meta webhook → parseMessageContent → insert message (content_type=image/audio/document)
                                            │
                                            ▼
                         understandMedia(mediaId, type, …)      ← new module
                            ├─ images/PDF → OpenRouter gpt-4o-mini (vision)
                            └─ audio      → OpenAI whisper-1
                                            │  {kind, summary, transcript, fields, confidence}
                                            ▼
                    persist to messages: ai_media_processed, ai_media_summary, ai_media_data
                                            │
                        (if passport/ID and kind confident) ▼
                         maidProfileAutofill(contactPhone, fields, imageBytes)   ← new module
                            ├─ match maid_profiles by phone
                            ├─ update_maid_profiles: blank safe fields only
                            ├─ passport number → tag + note (never raw write)
                            └─ if no passport doc on file → upload image → insert_maid_documents
                                            │
                                            ▼
                                    dispatch runAgent (unchanged entry point)
```

## Components

### 1. `src/lib/ai/media-understanding.ts` (new)

Single responsibility: media bytes → structured understanding. No DB, no side effects.

```ts
export type MediaKind = 'passport' | 'national_id' | 'selfie' | 'document' | 'voice' | 'other';

export interface MediaUnderstanding {
  kind: MediaKind;
  summary: string;            // human-readable, shown to agent + inbox
  transcript?: string;        // voice only
  language?: string;          // voice: detected language
  fields?: {                  // passport/national_id only
    first_name?: string;
    full_name?: string;
    nationality?: string;     // ISO country name
    passport_number?: string; // extracted but handled specially (never raw-written)
    passport_expiry?: string; // ISO date
    date_of_birth?: string;   // ISO date
  };
  confidence: number;         // 0..1
}

export async function understandMedia(input: {
  mediaId: string;
  contentType: 'image' | 'audio' | 'document';
  mimeType: string | null;
  accessToken: string;        // WhatsApp token to download bytes (getMediaUrl + downloadMedia)
  openrouter: { apiKey: string; baseUrl?: string; model: string }; // vision
  openaiKey: string;          // whisper
}): Promise<MediaUnderstanding>;
```

- **Images / PDF:** download bytes → base64 data URI → OpenRouter chat completion with a vision `image_url` part + a strict JSON-schema prompt: classify `kind`, and if passport/ID, extract MRZ fields. Returns `fields` + a one-line `summary`.
- **Audio:** download bytes → `POST https://api.openai.com/v1/audio/transcriptions` (`model=whisper-1`, `response_format=verbose_json`) → `transcript` + `language`; `summary` = short prefix + transcript.
- Pure enough to unit-test by mocking the two `fetch` calls.

### 2. `src/lib/ai/maid-profile-autofill.ts` (new)

```ts
export interface AutofillResult {
  matched: boolean;
  maidId?: string;
  filledFields: string[];         // which blank fields we wrote
  passportPendingVerify: boolean; // number surfaced for human verify
  documentUploaded: boolean;      // passport image stored (only if none existed)
  reason?: string;                // 'no_match' | 'multiple_matches' | 'low_confidence' | ...
}

export async function applyMaidProfileAutofill(input: {
  hasura: HasuraClient;
  supabase: SupabaseClient;       // for Storage upload + CRM tags
  contactPhone: string;           // E.164 from contacts
  conversationId: string;
  understanding: MediaUnderstanding;
  imageBytes?: { buffer: Buffer; mimeType: string }; // for upload
}): Promise<AutofillResult>;
```

Logic:
1. **Match** `maid_profiles` by phone: normalise both sides to digits-only E.164 and compare `phone_country_code || phone_number` to the contact phone; fall back to `phone_number` suffix match. 0 matches → `{matched:false, reason:'no_match'}`. >1 → `{matched:false, reason:'multiple_matches'}` (flag, no writes).
2. **Fill blanks** via `update_maid_profiles(where:{id}, _set:{…})` for `first_name, full_name, nationality, passport_expiry, date_of_birth` — **only** where the current value is null/empty. Never overwrite.
3. **Passport number** — never written. If `fields.passport_number` present: upsert CRM tag `passport_pending_verify` on the conversation's contact (same tag mechanism as `escalate_to_human`) and insert an internal note capturing the number for the team. Not written to `maid_profiles`.
4. **Conditional image upload** — query `maid_documents(where:{maid_id, document_type:{_in:["passport","passport_front","passport_photo"]}})`. If **none** and `kind ∈ {passport, national_id}` and `imageBytes` present: upload bytes to CRM Supabase Storage bucket `maid-documents` → public/signed URL → `insert_maid_documents_one({ maid_id, document_type:'passport', document_url:url, expiry_date:fields.passport_expiry, mime_type, verified:false })`. If a passport doc already exists → skip silently.

### 3. Storage (CRM Supabase Storage)

New bucket `maid-documents` (private; served via signed URL or a proxy route mirroring `008_profile_avatars_storage.sql`). The CRM has no Firebase Admin credentials, so v1 stores the image in its own Supabase Storage and writes that URL into `maid_documents.document_url`. This is a deliberate mixed-storage choice — the app only needs a fetchable URL. If uniformity with the app's Firebase bucket is later required, that needs Firebase Admin creds (a v1.1 option, noted as a risk).

### 4. Webhook glue (`src/app/api/whatsapp/webhook/route.ts`)

In `processMessage`, after inserting a **customer** message whose `content_type ∈ {image, audio, document}` and not already processed: load the user's OpenRouter/Hasura config (same rows `runAgent` uses), call `understandMedia`, persist `ai_media_*` to the message, then (for passport/ID kinds) call `applyMaidProfileAutofill`, **then** dispatch `runAgent`. Awaited before `runAgent` so the agent sees the extraction. Skipped when a flow consumed the message (mirrors current agent-dispatch guard). Best-effort: any failure logs and still dispatches `runAgent`.

### 5. Agent changes (`src/lib/ai/agent.ts`)

- `HistoryRow` gains `ai_media_summary`, `content_type`.
- `stringifyHistoryMessage`: if `ai_media_summary` present, render `"[<kind>] <summary>"` (e.g. `[passport] Almaz Tesfaye, Ethiopian, expires 2028-04`); else keep the `[content_type]` fallback.
- `detectLanguage`: for a voice message, use the transcript (now in `content_text`/summary) so replies match the spoken language.
- **Passport-on-file context:** when the intent is `job_seeker`, `runAgentInner` matches the contact to a `maid_profiles` row and checks `maid_documents` for a passport-type doc, computing `maidPassportOnFile: boolean`. This is injected into the runtime block so the prompt can conditionally act. (Reuses the same phone-match + doc-check helpers as the autofill module — one shared function, two call sites.)
- Prompt: acknowledge received documents/photos naturally; and **only when** `maidPassportOnFile === false` (registered maid, no passport doc), ask once for a clear passport photo. When `true`, never ask for the passport.

### 6. Data model changes

CRM `messages` (Supabase migration):
```sql
ALTER TABLE messages
  ADD COLUMN ai_media_processed boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_media_summary   text,
  ADD COLUMN ai_media_data      jsonb;
```
Idempotency: skip understanding when `ai_media_processed = true`.

Hasura writes: `update_maid_profiles` (blank safe fields), `insert_maid_documents_one` (conditional). No schema change on the app side.

## Data flow by case

- **Passport, registered maid, no passport doc** → extract → fill blanks → tag+note number → upload image → agent: *"Thanks Almaz — got your passport (Ethiopian, expires Apr 2028). How many years of experience do you have?"*
- **Passport, registered maid, passport already on file** → extract → fill any still-blank fields → tag+note number → **no** ask/upload → agent acknowledges and continues.
- **Voice note** → transcribe → agent reads + replies in that language.
- **Selfie / other photo** → `kind='selfie'/'other'` → agent acknowledges; no profile writes.
- **No matching maid profile** → converse only; agent nudges to register in the app.
- **Multiple matches / low confidence** → skip auto-fill; flag for human.

## Error handling & guardrails

- Media download / vision / whisper failure → mark `ai_media_processed=true` with a fallback `ai_media_summary` ("customer sent a <type>; could not read it"), agent replies asking for a resend; `runAgent` still dispatched.
- Idempotent: `ai_media_processed` guard prevents re-processing/duplicate uploads.
- Raw passport numbers never written to logs (redact in any log line).
- Overwrite guard: only blank fields updated.
- Confidence threshold (e.g. `< 0.6`) → treat as `other`, no writes.

## Config / dependencies

- `OPENAI_API_KEY` in `.env.local` (Whisper). Vision reuses the existing OpenRouter key/model from `ai_provider_config`.
- Add `openai` SDK **or** call the transcription endpoint via `fetch` (prefer `fetch`, no new dependency — matches the codebase's Meta-API style).
- Supabase Storage bucket `maid-documents` + access policy.

## Testing

- `media-understanding.test.ts`: mock the vision + whisper `fetch`; assert `kind` classification, field parsing (incl. malformed JSON handling), voice `language`, confidence gating.
- `maid-profile-autofill.test.ts`: phone-match (single/none/multiple), **blank-only** fill invariant, **passport_number never in the `_set`** invariant, conditional-upload (skip when a passport doc exists), tag/note on number present.
- Webhook: media message → extraction persisted → `runAgent` still dispatched on extractor failure.
- Existing 171-test suite stays green; `npm run typecheck` clean.

## Open prerequisites / risks

1. **`OPENAI_API_KEY`** must be provided before the voice path works.
2. **Phone-format matching** between `contacts.phone` and `maid_profiles.phone_country_code + phone_number` must be verified against real rows (plan task) — formats may differ (leading `+`, country-code split).
3. **Supabase Storage bucket** `maid-documents` must be created (migration/dashboard).
4. **Latency:** vision + whisper add ~2–5 s before the agent replies; acceptable for WhatsApp, but the webhook must return 200 to Meta immediately (it already does — extraction runs in the post-response async chain).
5. **PII:** passport images are sent to OpenAI/OpenRouter for processing — accepted per the user's scope decision; documented here for the record.
