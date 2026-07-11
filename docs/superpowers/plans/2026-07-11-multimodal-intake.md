# Multimodal Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a WhatsApp customer sends a passport/ID image, a document, or a voice note, the AI agent reads it (vision + transcription), replies naturally, and auto-fills blank safe fields on the matching maid profile.

**Architecture:** Preprocess-at-ingestion. A new orchestrator (`media-intake.ts`) is called from the webhook right after a customer media message is stored and before `runAgent` is dispatched. It runs `understandMedia` (OpenRouter vision for images/PDF, OpenAI Whisper for audio), persists the result on the message row (so the inbox and agent both see it), then `applyMaidProfileAutofill` (fill blank safe fields, flag the passport number for human verify, conditionally upload the passport image). `agent.ts` renders the extraction in history and asks for a passport only when the maid has none on file.

**Tech Stack:** Next.js 16, TypeScript, Supabase (CRM DB + Storage), Hasura/GraphQL (maids app), OpenRouter (`gpt-4o-mini`, vision), OpenAI (`whisper-1`), Meta WhatsApp Cloud API, Vitest.

## Global Constraints

- Fill **blank** maid-profile fields only — never overwrite an existing value.
- **Never** write the raw passport/national-ID number to any column or log line — flag it for human verify.
- Passport image is uploaded **only** when the maid has no passport document on file; otherwise do not ask and do not upload.
- Vision uses the existing OpenRouter key/model from `ai_provider_config` — **no new vision key**.
- Voice transcription uses OpenAI `whisper-1` via `OPENAI_API_KEY` (call the REST endpoint with `fetch` — do not add an `openai` npm dependency).
- Reuse existing helpers: `makeHasuraClient`/`HasuraError` (`@/lib/ai/tools/hasura`), `getMediaUrl`/`downloadMedia` (`@/lib/whatsapp/meta-api`), `phonesMatch`/`normalizePhone` (`@/lib/whatsapp/phone-utils`), `supabaseAdmin` (`@/lib/flows/admin-client`), `decrypt` (`@/lib/whatsapp/encryption`).
- All new tests use Vitest (`import { describe, expect, it, vi } from 'vitest'`), files `*.test.ts` next to the code. Suite command: `npm test`. Types: `npm run typecheck`.
- Meta media proxy URLs (`/api/whatsapp/media/{id}`) are auth-gated and NOT fetchable by models — always download bytes server-side with the WhatsApp access token.

---

## Task 0: Prerequisites (no code)

**Files:** none (environment + infra).

- [ ] **Step 1: Add the OpenAI key.** In `.env.local` add: `OPENAI_API_KEY=sk-...`. Confirm it loads: `grep -c '^OPENAI_API_KEY=' .env.local` → expect `1`. If the user has not supplied a key yet, STOP and request it before Task 2's voice path can be verified end-to-end (unit tests mock the call and do not need it).
- [ ] **Step 2: Create the Supabase Storage bucket `maid-documents`.** Follow the pattern in `supabase/migrations/008_profile_avatars_storage.sql`. Create `supabase/migrations/011_maid_documents_storage.sql` that creates a **private** bucket `maid-documents` and a policy allowing the service role to insert/select. Apply it the same way migration 008 was applied. (This bucket is used in Task 6.)
- [ ] **Step 3: Confirm no new npm deps needed.** `grep -E '"(openai|firebase|@google-cloud)"' package.json` → expect no matches. Whisper is called via `fetch`.

---

## Task 1: Message columns migration

**Files:**
- Create: `supabase/migrations/012_messages_ai_media.sql`

**Interfaces:**
- Produces: three columns on `messages` — `ai_media_processed boolean not null default false`, `ai_media_summary text`, `ai_media_data jsonb`.

- [ ] **Step 1: Write the migration**

```sql
-- 012_messages_ai_media.sql
-- Multimodal intake: cache the AI understanding of inbound media on the
-- message row so the agent and inbox both read it, and processing is idempotent.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_media_processed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_media_summary   text,
  ADD COLUMN IF NOT EXISTS ai_media_data      jsonb;

COMMENT ON COLUMN messages.ai_media_summary IS
  'Human-readable AI understanding of inbound media (passport summary / voice transcript). Shown in inbox + fed to the agent.';
```

- [ ] **Step 2: Apply the migration** the same way prior migrations are applied in this project (Supabase migration runner / psql against the CRM DB). Verify:

Run: `node -e "require('@supabase/supabase-js').createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY).from('messages').select('ai_media_processed').limit(1).then(r=>console.log(r.error?r.error.message:'ok'))"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/012_messages_ai_media.sql
git commit -m "feat(db): add ai_media_* columns to messages for multimodal intake"
```

---

## Task 2: `media-understanding.ts` — module + voice (Whisper) path

**Files:**
- Create: `src/lib/ai/media-understanding.ts`
- Test: `src/lib/ai/media-understanding.test.ts`

**Interfaces:**
- Consumes: `getMediaUrl`, `downloadMedia` from `@/lib/whatsapp/meta-api` (`getMediaUrl({mediaId, accessToken})→{url, mimeType}`; `downloadMedia({downloadUrl, accessToken})→{buffer:Buffer, contentType}`).
- Produces:
  ```ts
  export type MediaKind = 'passport' | 'national_id' | 'selfie' | 'document' | 'voice' | 'other';
  export interface MediaFields {
    first_name?: string; full_name?: string; nationality?: string;
    passport_number?: string; passport_expiry?: string; date_of_birth?: string;
  }
  export interface MediaUnderstanding {
    kind: MediaKind; summary: string; transcript?: string; language?: string;
    fields?: MediaFields; confidence: number;
  }
  export interface UnderstandMediaInput {
    mediaId: string;
    contentType: 'image' | 'audio' | 'document';
    mimeType: string | null;
    accessToken: string;
    openrouter: { apiKey: string; baseUrl?: string; model: string };
    openaiKey: string;
  }
  export async function understandMedia(input: UnderstandMediaInput): Promise<MediaUnderstanding>;
  export async function transcribeAudio(bytes: Buffer, mimeType: string, openaiKey: string): Promise<{ text: string; language?: string }>;
  ```

- [ ] **Step 1: Write the failing test (voice path)**

```ts
// src/lib/ai/media-understanding.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => ({ url: 'https://lookaside.fb/media', mimeType: 'audio/ogg' })),
  downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('fake-ogg'), contentType: 'audio/ogg' })),
}));

import { understandMedia } from './media-understanding';

afterEach(() => vi.restoreAllMocks());

describe('understandMedia — voice', () => {
  it('transcribes an audio note via Whisper and returns kind=voice', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'እኔ አማርኛ እናገራለሁ', language: 'amharic' }), { status: 200 }),
    );
    const r = await understandMedia({
      mediaId: 'm1', contentType: 'audio', mimeType: 'audio/ogg',
      accessToken: 'tok', openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
    });
    expect(r.kind).toBe('voice');
    expect(r.transcript).toContain('አማርኛ');
    expect(r.language?.toLowerCase()).toContain('amharic');
    expect(r.summary).toContain('አማርኛ');
    // Whisper endpoint was called
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- media-understanding`
Expected: FAIL — `understandMedia` not found / module missing.

- [ ] **Step 3: Write minimal implementation (module + voice path)**

```ts
// src/lib/ai/media-understanding.ts
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';

export type MediaKind = 'passport' | 'national_id' | 'selfie' | 'document' | 'voice' | 'other';

export interface MediaFields {
  first_name?: string; full_name?: string; nationality?: string;
  passport_number?: string; passport_expiry?: string; date_of_birth?: string;
}

export interface MediaUnderstanding {
  kind: MediaKind; summary: string; transcript?: string; language?: string;
  fields?: MediaFields; confidence: number;
}

export interface UnderstandMediaInput {
  mediaId: string;
  contentType: 'image' | 'audio' | 'document';
  mimeType: string | null;
  accessToken: string;
  openrouter: { apiKey: string; baseUrl?: string; model: string };
  openaiKey: string;
}

async function fetchBytes(mediaId: string, accessToken: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const info = await getMediaUrl({ mediaId, accessToken });
  const { buffer, contentType } = await downloadMedia({ downloadUrl: info.url, accessToken });
  return { buffer, mimeType: contentType || info.mimeType || 'application/octet-stream' };
}

export async function transcribeAudio(
  bytes: Buffer, mimeType: string, openaiKey: string,
): Promise<{ text: string; language?: string }> {
  const form = new FormData();
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'ogg';
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; language?: string };
  return { text: (json.text ?? '').trim(), language: json.language };
}

export async function understandMedia(input: UnderstandMediaInput): Promise<MediaUnderstanding> {
  if (input.contentType === 'audio') {
    const { buffer, mimeType } = await fetchBytes(input.mediaId, input.accessToken);
    const { text, language } = await transcribeAudio(buffer, mimeType, input.openaiKey);
    return {
      kind: 'voice',
      transcript: text,
      language,
      summary: text || '(unintelligible voice note)',
      confidence: text ? 0.9 : 0.2,
    };
  }
  // image / document handled in Task 3
  throw new Error(`understandMedia: unsupported contentType ${input.contentType} (not yet implemented)`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- media-understanding`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/media-understanding.ts src/lib/ai/media-understanding.test.ts
git commit -m "feat(ai): media-understanding voice transcription via Whisper"
```

---

## Task 3: `media-understanding.ts` — vision (passport/image) path

**Files:**
- Modify: `src/lib/ai/media-understanding.ts`
- Test: `src/lib/ai/media-understanding.test.ts`

**Interfaces:**
- Produces: `understandMedia` now handles `contentType ∈ {image, document}` by calling an OpenRouter vision chat completion and parsing strict JSON. Adds internal `analyzeImage(bytes, mimeType, openrouter)` (not exported).

- [ ] **Step 1: Write the failing test (vision path)**

```ts
// add to src/lib/ai/media-understanding.test.ts
describe('understandMedia — vision', () => {
  it('classifies a passport image and extracts safe fields', async () => {
    const content = JSON.stringify({
      kind: 'passport',
      fields: { full_name: 'Almaz Tesfaye', first_name: 'Almaz', nationality: 'Ethiopian',
                passport_number: 'EP1234567', passport_expiry: '2028-04-15', date_of_birth: '1996-02-03' },
      summary: 'Ethiopian passport for Almaz Tesfaye, expires 2028-04-15',
      confidence: 0.94,
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
    const r = await understandMedia({
      mediaId: 'm2', contentType: 'image', mimeType: 'image/jpeg',
      accessToken: 'tok', openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
    });
    expect(r.kind).toBe('passport');
    expect(r.fields?.nationality).toBe('Ethiopian');
    expect(r.fields?.passport_number).toBe('EP1234567');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to kind=other on unparseable model output', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }),
    );
    const r = await understandMedia({
      mediaId: 'm3', contentType: 'image', mimeType: 'image/jpeg',
      accessToken: 'tok', openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
    });
    expect(r.kind).toBe('other');
    expect(r.confidence).toBeLessThan(0.6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- media-understanding`
Expected: FAIL — vision path throws "unsupported contentType".

- [ ] **Step 3: Implement the vision path**

Replace the trailing `throw` in `understandMedia` and add `analyzeImage`:

```ts
const VISION_PROMPT = `You are an intake assistant for a domestic-worker recruitment agency.
Classify the attached image and, if it is an identity document, extract fields.
Reply with ONLY a JSON object, no prose, matching:
{"kind": "passport"|"national_id"|"selfie"|"document"|"other",
 "fields": {"first_name"?,"full_name"?,"nationality"? (country name in English),
            "passport_number"?,"passport_expiry"? (YYYY-MM-DD),"date_of_birth"? (YYYY-MM-DD)},
 "summary": "one short human sentence",
 "confidence": 0.0-1.0}
Only include fields you can read with high confidence. Omit unknown fields.`;

async function analyzeImage(
  bytes: Buffer, mimeType: string, openrouter: { apiKey: string; baseUrl?: string; model: string },
): Promise<MediaUnderstanding> {
  const dataUri = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const base = openrouter.baseUrl ?? 'https://openrouter.ai/api/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openrouter.apiKey}` },
    body: JSON.stringify({
      model: openrouter.model,
      temperature: 0,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content ?? '';
  return parseVision(raw);
}

function parseVision(raw: string): MediaUnderstanding {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const p = JSON.parse(match[0]) as Partial<MediaUnderstanding> & { fields?: MediaFields };
    const kind = (['passport', 'national_id', 'selfie', 'document', 'other'] as const)
      .includes(p.kind as MediaKind) ? (p.kind as MediaKind) : 'other';
    const confidence = typeof p.confidence === 'number' ? p.confidence : 0.5;
    return {
      kind,
      fields: kind === 'passport' || kind === 'national_id' ? p.fields : undefined,
      summary: p.summary || 'received an image',
      confidence,
    };
  } catch {
    return { kind: 'other', summary: 'received an image (could not read details)', confidence: 0.3 };
  }
}
```

And update the guard in `understandMedia`:

```ts
  // replace the trailing throw with:
  const { buffer, mimeType } = await fetchBytes(input.mediaId, input.accessToken);
  return analyzeImage(buffer, mimeType, input.openrouter);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- media-understanding`
Expected: PASS (voice + both vision tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/media-understanding.ts src/lib/ai/media-understanding.test.ts
git commit -m "feat(ai): media-understanding vision classification + passport extraction"
```

---

## Task 4: Maid lookup helper (phone match + passport-doc check)

**Files:**
- Create: `src/lib/ai/maid-lookup.ts`
- Test: `src/lib/ai/maid-lookup.test.ts`

**Interfaces:**
- Consumes: `HasuraClient` (`@/lib/ai/tools/hasura`), `phonesMatch` (`@/lib/whatsapp/phone-utils`).
- Produces:
  ```ts
  export interface MaidMatch { maidId: string; first_name: string | null; full_name: string | null;
    nationality: string | null; passport_expiry: string | null; date_of_birth: string | null; }
  export interface MaidLookup { status: 'match' | 'none' | 'multiple'; maid?: MaidMatch; passportOnFile?: boolean; }
  export async function lookupMaidByPhone(hasura: HasuraClient, contactPhone: string): Promise<MaidLookup>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ai/maid-lookup.test.ts
import { describe, expect, it, vi } from 'vitest';
import { lookupMaidByPhone } from './maid-lookup';

const hasura = (rows: unknown[], docs: unknown[] = []) => ({
  query: vi.fn(async (op: string) =>
    op.includes('maid_documents') ? { maid_documents: docs } : { maid_profiles: rows }),
});

describe('lookupMaidByPhone', () => {
  it('returns a single match by last-8-digit phone comparison', async () => {
    const h = hasura([{ id: 'maid-1', first_name: 'Almaz', full_name: null, nationality: null,
      passport_expiry: null, date_of_birth: null, phone_country_code: '251', phone_number: '973742567' }]);
    const r = await lookupMaidByPhone(h, '251973742567');
    expect(r.status).toBe('match');
    expect(r.maid?.maidId).toBe('maid-1');
    expect(r.passportOnFile).toBe(false);
  });

  it('reports passportOnFile=true when a passport document exists', async () => {
    const h = hasura(
      [{ id: 'm2', first_name: null, full_name: null, nationality: null, passport_expiry: null,
         date_of_birth: null, phone_country_code: '251', phone_number: '911111111' }],
      [{ id: 'doc1', document_type: 'passport' }]);
    const r = await lookupMaidByPhone(h, '251911111111');
    expect(r.status).toBe('match');
    expect(r.passportOnFile).toBe(true);
  });

  it('returns none when no phone matches', async () => {
    const h = hasura([{ id: 'x', phone_country_code: '971', phone_number: '500000000',
      first_name: null, full_name: null, nationality: null, passport_expiry: null, date_of_birth: null }]);
    const r = await lookupMaidByPhone(h, '251973742567');
    expect(r.status).toBe('none');
  });

  it('returns multiple when >1 profile matches', async () => {
    const row = (id: string) => ({ id, phone_country_code: '251', phone_number: '973742567',
      first_name: null, full_name: null, nationality: null, passport_expiry: null, date_of_birth: null });
    const h = hasura([row('a'), row('b')]);
    const r = await lookupMaidByPhone(h, '251973742567');
    expect(r.status).toBe('multiple');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- maid-lookup`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/lib/ai/maid-lookup.ts
import type { HasuraClient } from './tools/hasura';
import { phonesMatch } from '@/lib/whatsapp/phone-utils';

export interface MaidMatch {
  maidId: string; first_name: string | null; full_name: string | null;
  nationality: string | null; passport_expiry: string | null; date_of_birth: string | null;
}
export interface MaidLookup { status: 'match' | 'none' | 'multiple'; maid?: MaidMatch; passportOnFile?: boolean; }

const PASSPORT_DOC_TYPES = ['passport', 'passport_front', 'passport_photo'];

// Fetch a bounded candidate set by last-8-digit suffix, then confirm in JS with
// phonesMatch (handles trunk-0 / country-code split differences).
const CANDIDATES_GQL = /* GraphQL */ `
  query MaidCandidates($suffix: String!) {
    maid_profiles(where: { phone_number: { _ilike: $suffix } }, limit: 10) {
      id first_name full_name nationality passport_expiry date_of_birth
      phone_country_code phone_number
    }
  }
`;
const DOCS_GQL = /* GraphQL */ `
  query MaidPassportDocs($maidId: uuid!, $types: [String!]!) {
    maid_documents(where: { maid_id: { _eq: $maidId }, document_type: { _in: $types } }, limit: 1) { id }
  }
`;

interface Row extends MaidMatch { phone_country_code: string | null; phone_number: string | null; }

export async function lookupMaidByPhone(hasura: HasuraClient, contactPhone: string): Promise<MaidLookup> {
  const digits = contactPhone.replace(/\D/g, '');
  const suffix = `%${digits.slice(-8)}`;
  const data = await hasura.query<{ maid_profiles: Array<Record<string, unknown>> }>(CANDIDATES_GQL, { suffix });
  const rows = (data.maid_profiles ?? []).map((r) => ({
    maidId: String(r.id), first_name: (r.first_name ?? null) as string | null,
    full_name: (r.full_name ?? null) as string | null, nationality: (r.nationality ?? null) as string | null,
    passport_expiry: (r.passport_expiry ?? null) as string | null,
    date_of_birth: (r.date_of_birth ?? null) as string | null,
    phone_country_code: (r.phone_country_code ?? null) as string | null,
    phone_number: (r.phone_number ?? null) as string | null,
  })) as Row[];

  const matches = rows.filter((r) =>
    phonesMatch(digits, `${r.phone_country_code ?? ''}${r.phone_number ?? ''}`) ||
    phonesMatch(digits, r.phone_number ?? ''));

  if (matches.length === 0) return { status: 'none' };
  if (matches.length > 1) return { status: 'multiple' };

  const maid = matches[0];
  const docs = await hasura.query<{ maid_documents: Array<{ id: string }> }>(
    DOCS_GQL, { maidId: maid.maidId, types: PASSPORT_DOC_TYPES });
  return {
    status: 'match',
    maid: { maidId: maid.maidId, first_name: maid.first_name, full_name: maid.full_name,
      nationality: maid.nationality, passport_expiry: maid.passport_expiry, date_of_birth: maid.date_of_birth },
    passportOnFile: (docs.maid_documents ?? []).length > 0,
  };
}
```

> **Plan note:** the `$suffix _ilike` prefilter assumes `phone_number` stores the subscriber number without the country code (confirmed: schema splits `phone_country_code` + `phone_number`). During execution, run one live check against real rows to confirm formats; if `phone_number` includes the country code, widen the prefilter to also match the full `digits`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- maid-lookup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/maid-lookup.ts src/lib/ai/maid-lookup.test.ts
git commit -m "feat(ai): maid lookup by phone + passport-on-file check"
```

---

## Task 5: `maid-profile-autofill.ts` — fill blanks + flag passport number

**Files:**
- Create: `src/lib/ai/maid-profile-autofill.ts`
- Test: `src/lib/ai/maid-profile-autofill.test.ts`

**Interfaces:**
- Consumes: `lookupMaidByPhone` (Task 4), `HasuraClient`, `SupabaseClient` (`@supabase/supabase-js`), `MediaUnderstanding` (Task 2).
- Produces:
  ```ts
  export interface AutofillResult {
    matched: boolean; maidId?: string; filledFields: string[];
    passportPendingVerify: boolean; documentUploaded: boolean; reason?: string;
  }
  export async function applyMaidProfileAutofill(input: {
    hasura: HasuraClient; supabase: SupabaseClient; userId: string;
    contactPhone: string; conversationId: string; contactId: string;
    understanding: MediaUnderstanding; imageBytes?: { buffer: Buffer; mimeType: string };
  }): Promise<AutofillResult>;
  ```
  (Task 5 delivers everything except the image upload branch, which Task 6 adds. `documentUploaded` is always `false` here.)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ai/maid-profile-autofill.test.ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('./maid-lookup', () => ({ lookupMaidByPhone: vi.fn() }));
import { lookupMaidByPhone } from './maid-lookup';
import { applyMaidProfileAutofill } from './maid-profile-autofill';

const supa = () => {
  const upsert = vi.fn(async () => ({ error: null }));
  const insert = vi.fn(async () => ({ error: null }));
  const client = {
    from: vi.fn((t: string) => t === 'tags'
      ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'tag-1' } }) }) }) }) }
      : { upsert, insert }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
  return { client, upsert, insert };
};

const passport = (fields: Record<string, string>) => ({
  kind: 'passport' as const, summary: 's', confidence: 0.95, fields });

describe('applyMaidProfileAutofill', () => {
  it('fills only blank safe fields and never writes passport_number', async () => {
    const setSpy = vi.fn(async () => ({ maid_profiles: { affected_rows: 1 } }));
    const hasura = { query: setSpy };
    (lookupMaidByPhone as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'match',
      maid: { maidId: 'm1', first_name: 'Almaz', full_name: null, nationality: null,
        passport_expiry: null, date_of_birth: null },
      passportOnFile: true,
    });
    const { client, insert } = supa();
    const r = await applyMaidProfileAutofill({
      hasura, supabase: client, userId: 'u1', contactPhone: '251973742567',
      conversationId: 'c1', contactId: 'ct1',
      understanding: passport({ first_name: 'Almaz', full_name: 'Almaz Tesfaye', nationality: 'Ethiopian',
        passport_number: 'EP1234567', passport_expiry: '2028-04-15', date_of_birth: '1996-02-03' }),
    });
    expect(r.matched).toBe(true);
    // full_name/nationality/expiry/dob were blank → filled; first_name already set → skipped
    expect(r.filledFields.sort()).toEqual(['date_of_birth', 'full_name', 'nationality', 'passport_expiry']);
    expect(r.passportPendingVerify).toBe(true);
    // The GraphQL variables passed to update must NOT include passport_number
    const varsArg = JSON.stringify(setSpy.mock.calls.find((c) => String(c[0]).includes('update_maid_profiles'))?.[1] ?? {});
    expect(varsArg).not.toContain('passport_number');
    expect(varsArg).not.toContain('EP1234567');
    // INVARIANT: the raw number must not be stored anywhere — not in the internal note either
    expect(JSON.stringify(insert.mock.calls)).not.toContain('EP1234567');
    // A verification note was still posted (flag only, no number)
    expect(JSON.stringify(insert.mock.calls)).toMatch(/verify/i);
  });

  it('returns matched=false and writes nothing when no maid matches', async () => {
    (lookupMaidByPhone as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'none' });
    const setSpy = vi.fn();
    const { client } = supa();
    const r = await applyMaidProfileAutofill({
      hasura: { query: setSpy }, supabase: client, userId: 'u1', contactPhone: 'x',
      conversationId: 'c1', contactId: 'ct1', understanding: passport({ nationality: 'Ethiopian' }),
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('no_match');
    expect(setSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- maid-profile-autofill`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement (no upload branch yet)**

```ts
// src/lib/ai/maid-profile-autofill.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HasuraClient } from './tools/hasura';
import type { MediaUnderstanding } from './media-understanding';
import { lookupMaidByPhone, type MaidMatch } from './maid-lookup';

export interface AutofillResult {
  matched: boolean; maidId?: string; filledFields: string[];
  passportPendingVerify: boolean; documentUploaded: boolean; reason?: string;
}

const UPDATE_GQL = /* GraphQL */ `
  mutation FillMaid($id: uuid!, $set: maid_profiles_set_input!) {
    update_maid_profiles(where: { id: { _eq: $id } }, _set: $set) { affected_rows }
  }
`;

// Only these fields may be auto-written. passport_number is deliberately absent.
const SAFE_FIELDS = ['first_name', 'full_name', 'nationality', 'passport_expiry', 'date_of_birth'] as const;

function blankOnly(maid: MaidMatch, fields: MediaUnderstanding['fields']): Record<string, string> {
  const set: Record<string, string> = {};
  if (!fields) return set;
  for (const key of SAFE_FIELDS) {
    const current = (maid as unknown as Record<string, unknown>)[key];
    const incoming = (fields as unknown as Record<string, unknown>)[key];
    if ((current === null || current === undefined || current === '') && typeof incoming === 'string' && incoming.trim()) {
      set[key] = incoming.trim();
    }
  }
  return set;
}

async function tagContact(
  supabase: SupabaseClient, userId: string, contactId: string, name: string, color: string,
): Promise<void> {
  const { data: existing } = await supabase.from('tags').select('id').eq('user_id', userId).eq('name', name).maybeSingle();
  let tagId = existing?.id as string | undefined;
  if (!tagId) {
    const { data: created } = await supabase.from('tags')
      .insert({ user_id: userId, name, color }).select('id').single();
    tagId = created?.id;
  }
  if (tagId) {
    await supabase.from('contact_tags')
      .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id' });
  }
}

export async function applyMaidProfileAutofill(input: {
  hasura: HasuraClient; supabase: SupabaseClient; userId: string;
  contactPhone: string; conversationId: string; contactId: string;
  understanding: MediaUnderstanding; imageBytes?: { buffer: Buffer; mimeType: string };
}): Promise<AutofillResult> {
  const { understanding: u } = input;
  if (u.kind !== 'passport' && u.kind !== 'national_id') {
    return { matched: false, filledFields: [], passportPendingVerify: false, documentUploaded: false, reason: 'not_id_doc' };
  }
  if (u.confidence < 0.6) {
    return { matched: false, filledFields: [], passportPendingVerify: false, documentUploaded: false, reason: 'low_confidence' };
  }

  const lookup = await lookupMaidByPhone(input.hasura, input.contactPhone);
  if (lookup.status !== 'match' || !lookup.maid) {
    return { matched: false, filledFields: [], passportPendingVerify: false, documentUploaded: false,
      reason: lookup.status === 'multiple' ? 'multiple_matches' : 'no_match' };
  }
  const maid = lookup.maid;

  const set = blankOnly(maid, u.fields);
  const filledFields = Object.keys(set);
  if (filledFields.length > 0) {
    await input.hasura.query(UPDATE_GQL, { id: maid.maidId, set });
  }

  // An ID document was received for a matched maid → flag it for human
  // verification. The raw number is NEVER stored (not in the profile, not in
  // this note, not in logs) — the team reads it from the uploaded/existing
  // document, consistent with the app's encrypted-PII model.
  let passportPendingVerify = false;
  if (u.kind === 'passport' || u.kind === 'national_id') {
    await tagContact(input.supabase, input.userId, input.contactId, 'passport_pending_verify', '#f59e0b');
    await input.supabase.from('messages').insert({
      conversation_id: input.conversationId,
      sender_type: 'agent', agent_kind: 'ai', content_type: 'text', status: 'sent',
      content_text: '🔒 Passport/ID received — verify the number against the document (not auto-saved).',
    });
    passportPendingVerify = true;
  }

  return { matched: true, maidId: maid.maidId, filledFields, passportPendingVerify, documentUploaded: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- maid-profile-autofill`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/maid-profile-autofill.ts src/lib/ai/maid-profile-autofill.test.ts
git commit -m "feat(ai): auto-fill blank maid fields + flag passport number for verify"
```

---

## Task 6: Conditional passport-image upload

**Files:**
- Modify: `src/lib/ai/maid-profile-autofill.ts`
- Test: `src/lib/ai/maid-profile-autofill.test.ts`

**Interfaces:**
- Consumes: `lookupMaidByPhone` result's `passportOnFile`; Supabase Storage (`supabase.storage.from('maid-documents')`); Hasura `insert_maid_documents_one`.
- Produces: `applyMaidProfileAutofill` sets `documentUploaded: true` when it uploads.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/lib/ai/maid-profile-autofill.test.ts
it('uploads the passport image only when none is on file', async () => {
  const setSpy = vi.fn(async (op: string) =>
    op.includes('insert_maid_documents') ? { insert_maid_documents_one: { id: 'd1' } } : { update_maid_profiles: { affected_rows: 1 } });
  (lookupMaidByPhone as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: 'match', passportOnFile: false,
    maid: { maidId: 'm9', first_name: null, full_name: null, nationality: null, passport_expiry: null, date_of_birth: null },
  });
  const upload = vi.fn(async () => ({ data: { path: 'm9/passport.jpg' }, error: null }));
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://cdn/maid-documents/m9/passport.jpg?token=x' }, error: null }));
  const client = {
    from: vi.fn(() => ({ insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 't' } }) }) }) }),
      upsert: async () => ({ error: null }) })),
    storage: { from: vi.fn(() => ({ upload, createSignedUrl })) },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;

  const r = await applyMaidProfileAutofill({
    hasura: { query: setSpy }, supabase: client, userId: 'u1', contactPhone: '251900000000',
    conversationId: 'c1', contactId: 'ct1',
    understanding: { kind: 'passport', summary: 's', confidence: 0.95, fields: { nationality: 'Ethiopian', passport_expiry: '2029-01-01' } },
    imageBytes: { buffer: Buffer.from('img'), mimeType: 'image/jpeg' },
  });
  expect(upload).toHaveBeenCalled();
  expect(r.documentUploaded).toBe(true);
  expect(setSpy.mock.calls.some((c) => String(c[0]).includes('insert_maid_documents'))).toBe(true);
});

it('does NOT upload when a passport is already on file', async () => {
  const setSpy = vi.fn(async () => ({ update_maid_profiles: { affected_rows: 1 } }));
  (lookupMaidByPhone as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    status: 'match', passportOnFile: true,
    maid: { maidId: 'm9', first_name: null, full_name: null, nationality: null, passport_expiry: null, date_of_birth: null },
  });
  const upload = vi.fn();
  const client = {
    from: vi.fn(() => ({ insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 't' } }) }) }) }),
      upsert: async () => ({ error: null }) })),
    storage: { from: vi.fn(() => ({ upload })) },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
  const r = await applyMaidProfileAutofill({
    hasura: { query: setSpy }, supabase: client, userId: 'u1', contactPhone: '251900000000',
    conversationId: 'c1', contactId: 'ct1',
    understanding: { kind: 'passport', summary: 's', confidence: 0.95, fields: { nationality: 'Ethiopian' } },
    imageBytes: { buffer: Buffer.from('img'), mimeType: 'image/jpeg' },
  });
  expect(upload).not.toHaveBeenCalled();
  expect(r.documentUploaded).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- maid-profile-autofill`
Expected: FAIL — upload never happens (`documentUploaded` always false).

- [ ] **Step 3: Implement the upload branch**

Add the mutation constant and thread `passportOnFile` through. In `applyMaidProfileAutofill`, capture the lookup result and, before the final return, insert the upload branch:

```ts
const INSERT_DOC_GQL = /* GraphQL */ `
  mutation InsertMaidDoc($obj: maid_documents_insert_input!) {
    insert_maid_documents_one(object: $obj) { id }
  }
`;

// ... inside applyMaidProfileAutofill, after computing `maid` keep the lookup:
// const lookup = await lookupMaidByPhone(...); (already present)
// ... after the passport-number block, before `return`:

let documentUploaded = false;
const wantUpload =
  input.imageBytes && lookup.passportOnFile === false && (u.kind === 'passport' || u.kind === 'national_id');
if (wantUpload && input.imageBytes) {
  try {
    const ext = input.imageBytes.mimeType.includes('png') ? 'png' : 'jpg';
    const path = `${maid.maidId}/passport_${Date.now()}.${ext}`;
    const { error: upErr } = await input.supabase.storage
      .from('maid-documents')
      .upload(path, input.imageBytes.buffer, { contentType: input.imageBytes.mimeType, upsert: false });
    if (!upErr) {
      // Private bucket → long-lived SIGNED url (passport must not be world-readable).
      // 10 years so the maids app has a durable link.
      const { data: signed } = await input.supabase.storage
        .from('maid-documents').createSignedUrl(path, 315_360_000);
      if (signed?.signedUrl) {
        await input.hasura.query(INSERT_DOC_GQL, {
          obj: {
            maid_id: maid.maidId, document_type: 'passport', document_url: signed.signedUrl,
            expiry_date: u.fields?.passport_expiry ?? null, mime_type: input.imageBytes.mimeType, verified: false,
          },
        });
        documentUploaded = true;
      }
    }
  } catch (e) {
    console.warn('[autofill] passport upload failed (non-fatal):', e instanceof Error ? e.message : e);
  }
}

return { matched: true, maidId: maid.maidId, filledFields, passportPendingVerify, documentUploaded };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- maid-profile-autofill`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/maid-profile-autofill.ts src/lib/ai/maid-profile-autofill.test.ts
git commit -m "feat(ai): conditional passport image upload to maid_documents"
```

---

## Task 7: `media-intake.ts` orchestrator

**Files:**
- Create: `src/lib/ai/media-intake.ts`
- Test: `src/lib/ai/media-intake.test.ts`

**Interfaces:**
- Consumes: `understandMedia` (Task 2/3), `applyMaidProfileAutofill` (Task 5/6), `makeHasuraClient` + `decrypt` + `supabaseAdmin` + `getMediaUrl`/`downloadMedia`.
- Produces:
  ```ts
  export async function processInboundMedia(input: {
    userId: string; conversationId: string; contactId: string; contactPhone: string;
    messageId: string;             // internal messages.id (uuid)
    mediaId: string;               // Meta media id
    contentType: 'image' | 'audio' | 'document';
    mimeType: string | null;
    accessToken: string;           // WhatsApp token (already decrypted in webhook)
  }): Promise<void>;
  ```
  Always resolves (best-effort). Persists `ai_media_*` on the message; runs autofill for ID docs.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ai/media-intake.test.ts
import { describe, expect, it, vi } from 'vitest';

const updateEq = vi.fn(async () => ({ error: null }));
const messagesUpdate = vi.fn(() => ({ eq: updateEq }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => t === 'messages'
      ? { update: messagesUpdate, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ai_media_processed: false } }) }) }) }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) },
  }),
}));
vi.mock('./media-understanding', () => ({
  understandMedia: vi.fn(async () => ({ kind: 'voice', transcript: 'hi', summary: 'hi', confidence: 0.9 })),
}));
vi.mock('./maid-profile-autofill', () => ({ applyMaidProfileAutofill: vi.fn() }));
vi.mock('./config-load', () => ({ loadMediaConfig: vi.fn(async () => ({
  openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
  hasura: { query: vi.fn() } })) }));

import { processInboundMedia } from './media-intake';
import { understandMedia } from './media-understanding';

describe('processInboundMedia', () => {
  it('persists the summary to the message row', async () => {
    await processInboundMedia({
      userId: 'u1', conversationId: 'c1', contactId: 'ct1', contactPhone: '251900000000',
      messageId: 'msg1', mediaId: 'md1', contentType: 'audio', mimeType: 'audio/ogg', accessToken: 'tok',
    });
    expect(understandMedia).toHaveBeenCalled();
    expect(messagesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      ai_media_processed: true, ai_media_summary: 'hi',
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- media-intake`
Expected: FAIL — `media-intake` and `config-load` modules missing.

- [ ] **Step 3: Implement config loader + orchestrator**

Create `src/lib/ai/config-load.ts`:

```ts
// src/lib/ai/config-load.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { makeHasuraClient, type HasuraClient } from './tools/hasura';

export interface MediaConfig {
  openrouter: { apiKey: string; baseUrl?: string; model: string };
  openaiKey: string;
  hasura: HasuraClient;
}

/** Load + decrypt the provider/hasura config needed for media understanding. Null if unconfigured. */
export async function loadMediaConfig(sb: SupabaseClient, userId: string): Promise<MediaConfig | null> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  const { data: prov } = await sb.from('ai_provider_config')
    .select('provider, model, base_url, encrypted_api_key').eq('user_id', userId).maybeSingle();
  const { data: agent } = await sb.from('ai_agent_config')
    .select('hasura_url, encrypted_hasura_admin_secret').eq('user_id', userId).maybeSingle();
  if (!prov || !agent?.hasura_url) return null;

  const apiKey = prov.encrypted_api_key ? decrypt(prov.encrypted_api_key) : '';
  const adminSecret = agent.encrypted_hasura_admin_secret ? decrypt(agent.encrypted_hasura_admin_secret) : null;
  return {
    openrouter: { apiKey, baseUrl: prov.base_url ?? undefined, model: prov.model },
    openaiKey,
    hasura: makeHasuraClient(agent.hasura_url, adminSecret),
  };
}
```

Create `src/lib/ai/media-intake.ts`:

```ts
// src/lib/ai/media-intake.ts
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { understandMedia } from './media-understanding';
import { applyMaidProfileAutofill } from './maid-profile-autofill';
import { loadMediaConfig } from './config-load';

export async function processInboundMedia(input: {
  userId: string; conversationId: string; contactId: string; contactPhone: string;
  messageId: string; mediaId: string;
  contentType: 'image' | 'audio' | 'document'; mimeType: string | null; accessToken: string;
}): Promise<void> {
  const sb = supabaseAdmin();
  try {
    // Idempotency guard.
    const { data: existing } = await sb.from('messages')
      .select('ai_media_processed').eq('id', input.messageId).maybeSingle();
    if (existing?.ai_media_processed) return;

    const cfg = await loadMediaConfig(sb, input.userId);
    if (!cfg) {
      await sb.from('messages').update({ ai_media_processed: true }).eq('id', input.messageId);
      return;
    }

    const understanding = await understandMedia({
      mediaId: input.mediaId, contentType: input.contentType, mimeType: input.mimeType,
      accessToken: input.accessToken, openrouter: cfg.openrouter, openaiKey: cfg.openaiKey,
    });

    await sb.from('messages').update({
      ai_media_processed: true,
      ai_media_summary: understanding.summary,
      ai_media_data: understanding as unknown as Record<string, unknown>,
      // Surface voice transcript as the message text so detectLanguage + inbox work.
      ...(understanding.kind === 'voice' && understanding.transcript
        ? { content_text: understanding.transcript } : {}),
    }).eq('id', input.messageId);

    if (understanding.kind === 'passport' || understanding.kind === 'national_id') {
      // Re-download bytes for the upload branch (cheap; keeps understandMedia pure).
      let imageBytes: { buffer: Buffer; mimeType: string } | undefined;
      try {
        const info = await getMediaUrl({ mediaId: input.mediaId, accessToken: input.accessToken });
        const dl = await downloadMedia({ downloadUrl: info.url, accessToken: input.accessToken });
        imageBytes = { buffer: dl.buffer, mimeType: dl.contentType || info.mimeType || 'image/jpeg' };
      } catch { /* upload just won't happen */ }

      await applyMaidProfileAutofill({
        hasura: cfg.hasura, supabase: sb, userId: input.userId,
        contactPhone: input.contactPhone, conversationId: input.conversationId, contactId: input.contactId,
        understanding, imageBytes,
      });
    }
  } catch (e) {
    console.error('[media-intake] failed (non-fatal):', e instanceof Error ? e.message : e);
    await sb.from('messages').update({ ai_media_processed: true }).eq('id', input.messageId).then(() => {}, () => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- media-intake`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/config-load.ts src/lib/ai/media-intake.ts src/lib/ai/media-intake.test.ts
git commit -m "feat(ai): media-intake orchestrator + config loader"
```

---

## Task 8: Webhook glue

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (in `processMessage`, after the message insert at ~line 538–557, and where `runAgent` is dispatched at ~line 666–680)

**Interfaces:**
- Consumes: `processInboundMedia` (Task 7). Needs the internal `messages.id` of the just-inserted row, the `mediaId` (Meta id), `contentType`, `mimeType`, `contactPhone`, `contactId`, `userId`, and `accessToken` (already in scope).

- [ ] **Step 1: Capture the inserted message id and Meta media id.** The current insert (line 538) does not `.select()` the id. Change it to return the id, and thread the raw Meta media id out of `parseMessageContent`.

Add to `parseMessageContent`'s return type and the image/audio/document cases a `mediaMetaId: string | null` field (the raw `message.image?.id` etc., before proxying). Example for the image case:

```ts
    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
          mediaMetaId: message.image.id,   // NEW
        };
      }
      return empty
```

Do the same for `audio` and `document`. Add `mediaMetaId: null` to the `empty` default and the return-type declaration.

- [ ] **Step 2: Make the insert return the id.**

```ts
  const { data: insertedMsg, error: msgError } = await supabaseAdmin().from('messages').insert({
    /* ...existing fields... */
  }).select('id').single()
```

- [ ] **Step 3: Dispatch media processing before the agent.** Find the AI-agent dispatch block (`if (!flowConsumed) { runAgent(conversation.id)... }`). Immediately BEFORE it, add:

```ts
  // Multimodal intake: understand inbound media (passport/voice/doc) and
  // auto-fill the maid profile BEFORE the agent reasons over history.
  if (
    !flowConsumed && insertedMsg?.id &&
    (contentType === 'image' || contentType === 'audio' || contentType === 'document') &&
    mediaMetaId
  ) {
    try {
      await processInboundMedia({
        userId,
        conversationId: conversation.id,
        contactId: contactRecord.id,
        contactPhone: contactRecord.phone,
        messageId: insertedMsg.id,
        mediaId: mediaMetaId,
        contentType,
        mimeType: mediaType,
        accessToken,
      })
    } catch (err) {
      console.error('[webhook] media intake failed:', err)
    }
  }
```

Add the import at the top: `import { processInboundMedia } from '@/lib/ai/media-intake'` and destructure `mediaMetaId` from the `parseMessageContent` result (alongside `mediaUrl`, `mediaType`).

- [ ] **Step 4: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts
git commit -m "feat(webhook): run multimodal intake before dispatching the AI agent"
```

---

## Task 9: Agent surfaces extraction + passport-on-file context

**Files:**
- Modify: `src/lib/ai/agent.ts`
- Test: `src/lib/ai/agent.test.ts` (extend existing)

**Interfaces:**
- Consumes: `messages.ai_media_summary` (Task 1), `lookupMaidByPhone` (Task 4).
- Produces: `stringifyHistoryMessage` renders media summaries; the runtime block includes a passport-on-file line for job-seekers.

- [ ] **Step 1: Write failing tests**

```ts
// add to src/lib/ai/agent.test.ts
import { stringifyHistoryMessage } from './agent';

describe('stringifyHistoryMessage — media', () => {
  it('renders the AI media summary with a kind prefix', () => {
    const s = stringifyHistoryMessage({
      sender_type: 'customer', content_type: 'image', content_text: null,
      ai_media_summary: 'Ethiopian passport for Almaz, expires 2028-04-15',
      created_at: '2026-07-11T00:00:00Z',
    } as never);
    expect(s).toContain('passport');
    expect(s).toContain('Almaz');
  });

  it('falls back to [content_type] when no text and no summary', () => {
    const s = stringifyHistoryMessage({
      sender_type: 'customer', content_type: 'image', content_text: null,
      ai_media_summary: null, created_at: '2026-07-11T00:00:00Z',
    } as never);
    expect(s).toBe('[image]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent`
Expected: FAIL — `stringifyHistoryMessage` not exported / doesn't read `ai_media_summary`.

- [ ] **Step 3: Implement**

In `agent.ts`: (a) export `stringifyHistoryMessage`; (b) add `ai_media_summary?: string | null` to `HistoryRow`; (c) add `ai_media_summary` to the history `select`; (d) update the function:

```ts
export function stringifyHistoryMessage(m: HistoryRow): string {
  const text = (m.content_text ?? '').trim();
  if (m.ai_media_summary && m.ai_media_summary.trim()) {
    const label = m.content_type === 'image' ? 'photo' : m.content_type === 'audio' ? 'voice note' : m.content_type;
    return `[${label}] ${m.ai_media_summary.trim()}`;
  }
  if (text) return text;
  return `[${m.content_type ?? 'message'}]`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent`
Expected: PASS.

- [ ] **Step 5: Add passport-on-file runtime context.** In `runAgentInner`, after `intent`/`stage` are computed, when `intent === 'job_seeker'` look up the maid and expose the flag. Add a helper call:

```ts
  let maidPassportOnFile: boolean | null = null;
  if (intent === 'job_seeker' && agent.hasura_url) {
    try {
      const lookup = await lookupMaidByPhone(
        makeHasuraClient(agent.hasura_url, hasuraAdminSecret), contact.phone);
      if (lookup.status === 'match') maidPassportOnFile = lookup.passportOnFile ?? false;
    } catch { /* non-fatal */ }
  }
```

Pass `maidPassportOnFile` into `buildRuntimeBlock` and append one line when it is `false`:

```
PASSPORT: This registered maid has NO passport document on file. If the conversation reaches document collection, ask ONCE for a clear photo of her passport. If she already sent it this session, do not ask again. When maidPassportOnFile is true or null, NEVER ask for the passport.
```

Import `lookupMaidByPhone` from `./maid-lookup` and reuse the already-decrypted `hasuraAdminSecret` + `makeHasuraClient` (already imported for tools).

- [ ] **Step 6: Typecheck + full suite.**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/agent.ts src/lib/ai/agent.test.ts
git commit -m "feat(ai): agent reads media summaries + asks for passport only when missing"
```

---

## Task 10: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full green build.** Run `npm run typecheck && npm test`. Expected: typecheck clean; all tests pass (existing 171 + the new suites).
- [ ] **Step 2: Confirm the `/verify` project flow.** Invoke the `verify` skill to drive the affected flow if a project verify harness exists.
- [ ] **Step 3: Manual smoke (staging/local against a test WhatsApp number), each logged:**
  - Send a **voice note** (Amharic) → inbox shows the transcript; agent replies in Amharic.
  - Send a **passport photo** as a registered maid with blank profile fields + no passport doc → profile safe fields fill; `passport_pending_verify` tag appears; internal note with the number posts; a `maid_documents` row (type `passport`, `verified=false`) is created; agent acknowledges + continues.
  - Send a **passport photo** when a passport doc already exists → fields fill if still blank, but NO new upload and the agent does not ask for the passport.
  - Send a **selfie** → agent acknowledges; no profile writes.
  - Send a passport as a **non-registered** phone → converse only; no writes; agent nudges to the app.
- [ ] **Step 4: Verify the invariant in the DB.** Confirm no `maid_profiles.passport_number` was written by the CRM for the test maid (should remain as it was). Confirm no raw passport number appears in server logs.
- [ ] **Step 5: Update the live agent prompt if needed** so it acknowledges documents (only if the persona in `ai_agent_config` needs the new guidance; the runtime block already injects passport-on-file context, so a prompt change may be unnecessary).
- [ ] **Step 6: Open PR** from `feat/multimodal-intake` with a summary linking the spec and plan.

---

## Self-Review

**Spec coverage:** Goals 1–5 → Tasks 2/3 (understand), 5 (fill safe fields), 5 (flag number), 6 (conditional upload), 7+8 (inbox surfacing via persisted summary), 9 (agent reads + asks). Non-goals respected (no raw number write — Task 5 invariant test; no encrypted columns; Firebase deferred — Task 6 uses Supabase Storage). Decisions table → Global Constraints. Prerequisites (OPENAI_API_KEY, bucket) → Task 0. Phone-format risk → Task 4 plan note + Task 10 step 3.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output.

**Type consistency:** `MediaUnderstanding`/`MediaFields`/`MediaKind` defined in Task 2, reused in Tasks 5/6/7. `MaidLookup`/`MaidMatch` defined Task 4, used Tasks 5/9. `AutofillResult` Task 5, extended Task 6 (same shape). `processInboundMedia` signature consistent Task 7↔8. `loadMediaConfig` defined Task 7, mocked in the same task's test.
