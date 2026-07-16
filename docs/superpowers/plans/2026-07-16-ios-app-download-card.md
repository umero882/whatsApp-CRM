# iOS App Download Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach Lucy's `send_app_download_card` tool to send an App Store card to iPhone customers, and stop every card claiming iOS is "coming soon".

**Architecture:** Extend the existing pure `buildAppDownloadCard(language)` with a second `platform` param defaulting to `'android'` (so nothing regresses), swap the URL/badge/copy on it, and expose `platform` as an LLM tool parameter so Lucy picks it from the conversation. Apple's badge is SVG and Meta headers reject SVG, so a PNG is self-hosted on `ethiopianmaids.com` first.

**Tech Stack:** TypeScript, Next.js, vitest, Meta WhatsApp Cloud API (`interactive.cta_url`), sharp (SVG→PNG), Supabase.

## Global Constraints

- Meta `cta_url` allows **exactly one** button per message — hence two platform cards, never one card with both stores.
- Header image must be **PNG or JPEG**. SVG is rejected. (`meta-api.ts:202-204`)
- Button `display_text` ≤ **20 chars**. (`ethiopian-maids.ts:583`)
- Footer ≤ **60 chars**. (`meta-api.ts:176-177`)
- Body ≤ **1024 chars**, > 20 chars. (asserted in existing tests)
- `cta_url` only works inside the **24-hour customer service window**. (`meta-api.ts:187`)
- `platform` **defaults to `'android'`** everywhere — existing call sites and tests must keep passing untouched.
- Android body copy is **unchanged, byte for byte**. Only the footer changes.
- Never paste a raw store URL as text — the card exists because customers fear scam links.
- The iOS App Store URL is exactly `https://apps.apple.com/us/app/ethiopian-maids/id6762796104`.
- Two repos: badge PNG in `ethiopian-maids-monorepo`; all logic in `WhatsApp CRM`. **Task 1 must deploy before Task 3 ships.**

---

## File Structure

| File | Repo | Responsibility |
|---|---|---|
| `apps/web/public/badges/app-store.png` | monorepo | Create — Apple's official badge as PNG, served to Meta |
| `src/lib/ai/tools/ethiopian-maids.ts` | CRM | Modify — constants, `buildAppDownloadCard`, tool param, handler notes |
| `src/lib/ai/tools/ethiopian-maids.test.ts` | CRM | Modify — platform coverage + constraint/regression tests |

No new modules. The card logic stays in the file that already owns it.

---

### Task 1: Host Apple's App Store badge as PNG

**Files:**
- Create: `C:\dev\ethiopian-maids-monorepo\apps\web\public\badges\app-store.png`

**Interfaces:**
- Consumes: nothing.
- Produces: a public URL `https://ethiopianmaids.com/badges/app-store.png` returning `200` with `Content-Type: image/png`. Task 2 hardcodes this exact URL.

- [ ] **Step 1: Fetch Apple's official badge SVG and rasterize to PNG**

Apple serves the badge only as SVG; Meta rejects SVG. Rasterizing is a format
conversion, not a redesign, so the official artwork is preserved. Run from the
CRM repo (it has `sharp` installed; the monorepo does not):

```bash
cd "/c/dev/WhatsApp CRM"
node -e "
const sharp = require('sharp');
const url = 'https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us';
(async () => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Apple badge fetch failed: ' + res.status);
  const svg = Buffer.from(await res.arrayBuffer());
  const out = 'C:/dev/ethiopian-maids-monorepo/apps/web/public/badges/app-store.png';
  require('fs').mkdirSync(require('path').dirname(out), { recursive: true });
  await sharp(svg, { density: 384 }).resize({ width: 1200 }).png().toFile(out);
  console.log('wrote', out);
})();
"
```

- [ ] **Step 2: Verify the PNG is real and correctly shaped**

```bash
node -e "
const sharp = require('sharp');
sharp('C:/dev/ethiopian-maids-monorepo/apps/web/public/badges/app-store.png')
  .metadata()
  .then(m => console.log('format:', m.format, '| w:', m.width, '| h:', m.height));
"
```

Expected: `format: png | w: 1200 | h: <~400>`. If `format` is not `png`, stop — Meta will reject it.

- [ ] **Step 3: Commit the asset (monorepo)**

The monorepo deploys from `feat/admin-mobile-crm-whatsapp`, not `main` — commit there.

```bash
cd /c/dev/ethiopian-maids-monorepo
git checkout feat/admin-mobile-crm-whatsapp
git add apps/web/public/badges/app-store.png
git commit -m "feat(web): host Apple App Store badge PNG for WhatsApp card

Meta interactive headers accept PNG/JPEG only, and Apple serves its
official badge as SVG. Rasterized copy served from our own domain so
Lucy's iOS download card can render the official artwork."
```

- [ ] **Step 4: Deploy web and verify the badge is live**

Follow the repo's `deploy` skill (clean build is mandatory — a dirty
`dist/apps/web` bloats `sw.js`):

```bash
cd /c/dev/ethiopian-maids-monorepo
rm -rf dist/apps/web && pnpm nx reset
pnpm nx build web --configuration=production
cd dist/apps/web && tar czf /tmp/web-deploy.tar.gz . && cd -
scp -i ~/.ssh/id_ed25519_ethiopian_maids /tmp/web-deploy.tar.gz root@72.60.205.121:/tmp/web-deploy.tar.gz
ssh -i ~/.ssh/id_ed25519_ethiopian_maids root@72.60.205.121 'bash -s' <<'DEPLOY'
  set -e
  rm -rf /var/www/ethiopianmaids/assets
  rm -f /var/www/ethiopianmaids/sw.js /var/www/ethiopianmaids/workbox-*.js
  tar xzf /tmp/web-deploy.tar.gz -C /var/www/ethiopianmaids/
  rm -f /tmp/web-deploy.tar.gz
  ls -la /var/www/ethiopianmaids/badges/app-store.png
DEPLOY
```

Then verify what Meta will actually see (run from the VPS, since local SSL
verification is unreliable here):

```bash
ssh -i ~/.ssh/id_ed25519_ethiopian_maids root@72.60.205.121 \
  "curl -sI https://ethiopianmaids.com/badges/app-store.png | head -3"
```

Expected: `HTTP/2 200` and `content-type: image/png`.
**Do not start Task 3 until this passes** — Meta fetches this URL server-side.

---

### Task 2: Add `platform` to `buildAppDownloadCard`

**Files:**
- Modify: `C:\dev\WhatsApp CRM\src\lib\ai\tools\ethiopian-maids.ts:564-617`
- Test: `C:\dev\WhatsApp CRM\src\lib\ai\tools\ethiopian-maids.test.ts:43-56`

**Interfaces:**
- Consumes: the live badge URL from Task 1.
- Produces:
  - `export type AppCardPlatform = 'android' | 'ios'`
  - `export const APP_APP_STORE_URL: string`
  - `buildAppDownloadCard(language: AppCardLanguage, platform?: AppCardPlatform): AppDownloadCard` — `platform` defaults to `'android'`.
  - `AppDownloadCard` shape is unchanged: `{ bodyText, buttonText, footerText, headerImageUrl, url }`.

Task 3 calls `buildAppDownloadCard(language, platform)` and imports `AppCardPlatform`.

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe('buildAppDownloadCard', ...)` block at
`ethiopian-maids.test.ts:43-56` with:

```ts
describe('buildAppDownloadCard', () => {
  const LANGS = ['en', 'ar', 'am'] as const;

  it.each(LANGS)('%s android card points at Google Play with the official badge', (lang) => {
    const card = buildAppDownloadCard(lang, 'android');
    expect(card.url).toBe(APP_PLAY_STORE_URL);
    expect(card.headerImageUrl).toMatch(/^https:\/\/play\.google\.com\/.*badge.*\.png$/);
  });

  it.each(LANGS)('%s ios card points at the App Store with a PNG badge', (lang) => {
    const card = buildAppDownloadCard(lang, 'ios');
    expect(card.url).toBe(APP_APP_STORE_URL);
    expect(card.url).toContain('apps.apple.com/us/app/ethiopian-maids/id6762796104');
    // Meta rejects SVG headers; the badge must be a self-hosted PNG.
    expect(card.headerImageUrl).toMatch(/^https:\/\/ethiopianmaids\.com\/badges\/app-store\.png$/);
  });

  it('defaults to the Google Play card when platform is omitted', () => {
    const card = buildAppDownloadCard('en');
    expect(card.url).toBe(APP_PLAY_STORE_URL);
  });

  it.each(LANGS.flatMap((l) => (['android', 'ios'] as const).map((p) => [l, p] as const)))(
    '%s/%s card respects Meta cta_url limits',
    (lang, platform) => {
      const card = buildAppDownloadCard(lang, platform);
      expect(card.buttonText.length).toBeGreaterThan(0);
      expect(card.buttonText.length).toBeLessThanOrEqual(20);
      expect(card.footerText.length).toBeLessThanOrEqual(60);
      expect(card.bodyText.length).toBeGreaterThan(20);
      expect(card.bodyText.length).toBeLessThanOrEqual(1024);
    },
  );

  it.each(LANGS.flatMap((l) => (['android', 'ios'] as const).map((p) => [l, p] as const)))(
    '%s/%s footer no longer claims iOS is coming soon',
    (lang, platform) => {
      const card = buildAppDownloadCard(lang, platform);
      for (const banned of ['coming soon', 'قريبا', 'قريباً', 'በቅርቡ']) {
        expect(card.footerText).not.toContain(banned);
      }
    },
  );

  it('each card footer points at the other store', () => {
    expect(buildAppDownloadCard('en', 'android').footerText).toContain('App Store');
    expect(buildAppDownloadCard('en', 'ios').footerText).toContain('Google Play');
  });
});
```

Add `APP_APP_STORE_URL` to the existing import block at the top of the test
file (it already imports `APP_PLAY_STORE_URL` and `buildAppDownloadCard`):

```ts
import {
  APP_APP_STORE_URL,
  APP_PLAY_STORE_URL,
  buildAppDownloadCard,
  buildChoiceMessage,
  buildEscalationForward,
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "/c/dev/WhatsApp CRM"
pnpm test -- ethiopian-maids
```

Expected: FAIL — `APP_APP_STORE_URL` is not exported (TypeScript/import error).

- [ ] **Step 3: Write the implementation**

In `ethiopian-maids.ts`, replace lines 564-617 (from `export const APP_PLAY_STORE_URL` through the end of `buildAppDownloadCard`) with:

```ts
export const APP_PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.ethiopianmaids.app';

export const APP_APP_STORE_URL =
  'https://apps.apple.com/us/app/ethiopian-maids/id6762796104';

/** Google's own hosted "Get it on Google Play" badge (official artwork). */
const PLAY_BADGE_IMAGE_URL =
  'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

/**
 * Apple's official badge, rasterized to PNG and served from our domain.
 * Apple only publishes it as SVG, which Meta's image header rejects.
 */
const APP_STORE_BADGE_IMAGE_URL = 'https://ethiopianmaids.com/badges/app-store.png';

export type AppCardLanguage = 'en' | 'ar' | 'am';
export type AppCardPlatform = 'android' | 'ios';

export interface AppDownloadCard {
  bodyText: string;
  buttonText: string;
  footerText: string;
  headerImageUrl: string;
  url: string;
}

/**
 * Localized copy for the app-download card. Pure — exported for tests.
 * Button text must stay ≤20 chars (Meta cta_url display_text limit);
 * footer ≤60. Each footer names the OTHER store so a single card still
 * tells both audiences the app exists.
 */
export function buildAppDownloadCard(
  language: AppCardLanguage,
  platform: AppCardPlatform = 'android',
): AppDownloadCard {
  const copy: Record<
    AppCardLanguage,
    Record<AppCardPlatform, { body: string; button: string; footer: string }>
  > = {
    en: {
      android: {
        body:
          'This is the official Ethiopian Maids app on Google Play. ' +
          'Download it to register, browse candidates, and apply for jobs — all in one safe place.',
        button: 'Open Google Play',
        footer: 'Also available on the App Store',
      },
      ios: {
        body:
          'This is the official Ethiopian Maids app on the App Store. ' +
          'Download it to register, browse candidates, and apply for jobs — all in one safe place.',
        button: 'Open App Store',
        footer: 'Also available on Google Play',
      },
    },
    ar: {
      android: {
        body:
          'هذا هو تطبيق Ethiopian Maids الرسمي على متجر Google Play. ' +
          'حمّله للتسجيل وتصفح المرشحات والتقديم على الوظائف — كل ذلك في مكان واحد آمن.',
        button: 'افتح Google Play',
        footer: 'متوفر أيضاً على App Store',
      },
      ios: {
        body:
          'هذا هو تطبيق Ethiopian Maids الرسمي على App Store. ' +
          'حمّله للتسجيل وتصفح المرشحات والتقديم على الوظائف — كل ذلك في مكان واحد آمن.',
        button: 'افتح App Store',
        footer: 'متوفر أيضاً على Google Play',
      },
    },
    am: {
      android: {
        body:
          'ይህ በGoogle Play ላይ ያለው ኦፊሴላዊ የEthiopian Maids መተግበሪያ ነው። ' +
          'ለመመዝገብ፣ እጩዎችን ለማየት እና ለስራ ለማመልከት ያውርዱት።',
        button: 'Google Play ክፈት',
        footer: 'በApp Store ላይም ይገኛል',
      },
      ios: {
        body:
          'ይህ በApp Store ላይ ያለው ኦፊሴላዊ የEthiopian Maids መተግበሪያ ነው። ' +
          'ለመመዝገብ፣ እጩዎችን ለማየት እና ለስራ ለማመልከት ያውርዱት።',
        button: 'App Store ክፈት',
        footer: 'በGoogle Play ላይም ይገኛል',
      },
    },
  };
  const byPlatform = copy[language] ?? copy.en;
  const c = byPlatform[platform] ?? byPlatform.android;
  const isIos = platform === 'ios';
  return {
    bodyText: c.body,
    buttonText: c.button,
    footerText: c.footer,
    headerImageUrl: isIos ? APP_STORE_BADGE_IMAGE_URL : PLAY_BADGE_IMAGE_URL,
    url: isIos ? APP_APP_STORE_URL : APP_PLAY_STORE_URL,
  };
}
```

Note: `AppCardLanguage` and `AppDownloadCard` already exist above the old
`buildAppDownloadCard` (lines 571-579). Move them into this block as shown and
delete the originals so they are declared exactly once.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "/c/dev/WhatsApp CRM"
pnpm test -- ethiopian-maids
```

Expected: PASS, all `buildAppDownloadCard` cases green.

- [ ] **Step 5: Commit**

```bash
cd "/c/dev/WhatsApp CRM"
git add src/lib/ai/tools/ethiopian-maids.ts src/lib/ai/tools/ethiopian-maids.test.ts
git commit -m "feat(ai): platform-aware app download card copy

iOS shipped today, so buildAppDownloadCard takes a platform param and
returns the App Store URL + self-hosted PNG badge for iPhone users.
Defaults to android so existing callers are unchanged.

Footers stopped claiming 'iPhone app coming soon' — each card now names
the other store instead."
```

---

### Task 3: Expose `platform` to Lucy and fix the handler's reply notes

**Files:**
- Modify: `C:\dev\WhatsApp CRM\src\lib\ai\tools\ethiopian-maids.ts:619-717`
- Test: `C:\dev\WhatsApp CRM\src\lib\ai\tools\ethiopian-maids.test.ts`

**Interfaces:**
- Consumes: `buildAppDownloadCard(language, platform)`, `AppCardPlatform`, `APP_APP_STORE_URL` from Task 2.
- Produces: `sendAppDownloadCard.handler` accepts `args.platform` and returns `{ ok, delivered_as, language, platform, note }`.

The handler currently hardcodes "Google Play" in both `note` strings
(lines 711-714). Those notes tell Lucy what to say next, so an iPhone customer
would get a card for the App Store followed by Lucy saying "Google Play".

- [ ] **Step 1: Write the failing test**

Append to `ethiopian-maids.test.ts`. It reuses the `mockSupabase()` helper
already defined in the `saveMatchAlert.handler` describe block — move that
helper to module scope (above the first `describe`) so both suites share it.

```ts
describe('sendAppDownloadCard.handler', () => {
  function ctxFor(supabase: unknown) {
    return {
      supabase,
      conversationId: 'conv-1',
      contactPhone: '+971585868560',
      whatsapp: { phoneNumberId: 'pn-1', accessToken: 'tok-1' },
    } as unknown as ToolContext;
  }

  /**
   * Mock Meta's send endpoint the way the rest of this repo does
   * (`vi.stubGlobal` + a plain object). `sendCtaUrlMessage` only reads
   * `.ok`, `.status` and `.json()` — see meta-api.ts:222-226.
   */
  function stubMetaSend(sent: Array<Record<string, unknown>>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'wamid.test' }] }),
        };
      }),
    );
  }

  it('sends the App Store card and tells Lucy to say App Store', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubMetaSend(sent);

    const supa = mockSupabase();
    const res = await sendAppDownloadCard.handler({ language: 'en', platform: 'ios' }, ctxFor(supa.client));

    expect((res as { ok: boolean }).ok).toBe(true);
    expect((res as { platform: string }).platform).toBe('ios');
    expect((res as { note: string }).note).toContain('App Store');
    expect((res as { note: string }).note).not.toContain('Google Play');
    expect(JSON.stringify(sent[0])).toContain(APP_APP_STORE_URL);
  });

  it('defaults to the Google Play card when platform is omitted', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubMetaSend(sent);

    const supa = mockSupabase();
    const res = await sendAppDownloadCard.handler({ language: 'en' }, ctxFor(supa.client));

    expect((res as { platform: string }).platform).toBe('android');
    expect(JSON.stringify(sent[0])).toContain(APP_PLAY_STORE_URL);
  });
});
```

Add `sendAppDownloadCard` to the test file's import block, and ensure
`vi` is imported: `import { describe, expect, it, vi } from 'vitest';`.
Add `afterEach(() => vi.unstubAllGlobals());` at module scope so the stubbed
`fetch` does not leak into other suites.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/c/dev/WhatsApp CRM"
pnpm test -- ethiopian-maids
```

Expected: FAIL — `res.platform` is `undefined` and `note` contains "Google Play".

- [ ] **Step 3: Update the tool description and parameters**

Replace `sendAppDownloadCard`'s `description` and `parameters` (lines 621-636):

```ts
  description:
    'Send the OFFICIAL Ethiopian Maids app download card: the store badge image + a tappable button. ' +
    'ALWAYS use this when directing a customer to download the app or register — NEVER paste a store URL as text (customers fear scam links). ' +
    'After the card is sent, your text reply is ONE short sentence (e.g. "Tap the button above to get our official app 🌸") — do not repeat any link.',
  parameters: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['en', 'ar', 'am'],
        description: 'Card language matching the conversation: en (English), ar (Arabic), am (Amharic). Default en.',
      },
      platform: {
        type: 'string',
        enum: ['android', 'ios'],
        description:
          "The customer's phone type. Pass 'ios' if they mention iPhone, iOS, or the App Store; "
          + "'android' if they mention Android, Samsung, or Google Play. "
          + 'If you do not know, ASK one short question ("Are you on iPhone or Android?") before calling this tool. '
          + 'Defaults to android.',
      },
    },
    required: [],
    additionalProperties: false,
  },
```

- [ ] **Step 4: Make the handler platform-aware**

In `sendAppDownloadCard.handler`, replace the `language`/`card` lines (641-642):

```ts
    const language = (['en', 'ar', 'am'].includes(String(args.language)) ? String(args.language) : 'en') as AppCardLanguage;
    const platform = (['android', 'ios'].includes(String(args.platform)) ? String(args.platform) : 'android') as AppCardPlatform;
    const card = buildAppDownloadCard(language, platform);
    const storeName = platform === 'ios' ? 'App Store' : 'Google Play';
```

Then replace the `return` block (707-715) so the notes name the right store:

```ts
    return {
      ok: true,
      delivered_as: deliveredAs,
      language,
      platform,
      note:
        deliveredAs === 'text_fallback'
          ? `Card rendering unavailable — a plain message with the official link was sent instead. Reply with ONE short reassuring sentence that this is our official ${storeName} page.`
          : `Official app card with the ${storeName} button is now in the customer's chat. Reply with ONE short sentence pointing at it (e.g. "Tap the button above to get our official app 🌸"). Do NOT paste any link.`,
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "/c/dev/WhatsApp CRM"
pnpm test -- ethiopian-maids
```

Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
cd "/c/dev/WhatsApp CRM"
pnpm lint
pnpm build
```

Expected: no errors. `pnpm build` catches type errors `vitest` does not.

- [ ] **Step 7: Commit**

```bash
cd "/c/dev/WhatsApp CRM"
git add src/lib/ai/tools/ethiopian-maids.ts src/lib/ai/tools/ethiopian-maids.test.ts
git commit -m "feat(ai): let Lucy send the App Store card to iPhone users

Adds a platform param to send_app_download_card so Lucy picks the store
from the conversation, asking when unsure — the only signal available for
someone who has not installed the app yet.

Also fixes the handler notes, which hardcoded 'Google Play' and would
have had Lucy name the wrong store right after an App Store card."
```

---

### Task 4: Verify on the live number

**Files:** none — this is end-to-end verification against production.

**Interfaces:**
- Consumes: Task 1's deployed badge, Task 3's deployed CRM.

- [ ] **Step 1: Open a PR and merge to `main`**

The CRM repo ships via PR to `main` (see `#43`, `#44`, `#45`).

```bash
cd "/c/dev/WhatsApp CRM"
git push -u origin feat/ios-app-download-card
gh pr create --title "feat(ai): iOS app download card" \
  --body "Apple approved the iOS app on 2026-07-16. Lucy now sends an App Store card to iPhone customers and no card claims iOS is 'coming soon'.

Spec: docs/superpowers/specs/2026-07-16-ios-app-download-card-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 2: Verify the iOS card on WhatsApp**

Message the live number (+971 58 859 3894) and say: *"Send me the app download, I have an iPhone"*.

Expected: a card with the **Apple badge image**, an **`Open App Store`** button opening `apps.apple.com/us/app/ethiopian-maids/id6762796104`, and the footer **"Also available on Google Play"**. Lucy's follow-up sentence must not say "Google Play".

- [ ] **Step 3: Verify the Android card did not regress**

In a new conversation, say: *"Send me the app download, I have an Android"*.

Expected: the **unchanged** Google Play card, footer now reading **"Also available on the App Store"** (not "coming soon").

- [ ] **Step 4: Verify the ask-when-unknown path**

Say only: *"Send me the app"*.

Expected: Lucy asks which phone you use before sending, **or** sends the Android card (the safe default). Both are acceptable; a broken/missing card is not.

- [ ] **Step 5: Confirm the badge rendered rather than silently degrading**

```bash
cd "/c/dev/WhatsApp CRM"
grep -r "cta_url with image failed" --include=*.log . 2>/dev/null || true
```

Check the CRM's runtime logs for `[send_app_download_card] cta_url with image failed`. If present, Meta could not fetch the Apple PNG — re-check Task 1 Step 4 (must be `200` + `image/png`). The card still delivers without the image, so this is a quality issue, not an outage.

---

## Notes for the implementer

- **Task 1 gates Task 3.** If the badge URL is not live, Meta silently drops the header image and every iOS card degrades to `card_no_image`.
- **Do not touch the Android body copy.** It is deliberate anti-scam wording. Only its footer changes.
- **`device_tokens.platform` is not an option** for detection — a row only exists after the app is installed, and these users have not installed it.
- **The monorepo deploys from `feat/admin-mobile-crm-whatsapp`, not `main`.** `main` is ~272 commits stale.
