# iOS app download card — design

**Date:** 2026-07-16
**Status:** Approved, pending implementation plan
**Repos touched:** `WhatsApp CRM` (primary), `ethiopian-maids-monorepo` (badge asset only)

## Problem

The Ethiopian Maids iOS app went live on the App Store today
(`https://apps.apple.com/us/app/ethiopian-maids/id6762796104`). Lucy's
`send_app_download_card` tool only knows about Google Play, and every
localized footer still says *"iPhone app coming soon on the App Store"* —
copy that is now factually wrong in all three languages.

iPhone customers who ask Lucy for the app are currently sent a Google Play
card they cannot use, plus a footer telling them to wait for an app that
already shipped.

## Where the card actually lives

The live WhatsApp AI is **not** the `ethiopian-maids-monorepo` Cloud
Functions. It is the Next.js CRM at `crm.ethiopianmaids.com` (this repo).
Confirmed 2026-07-16:

- The monorepo's `whatsappWebhook` is deployed but has **no log entries**.
- Monorepo `whatsapp_messages` table is frozen at **2026-05-24**.
- No store URL exists in the monorepo DB (1,044 text/jsonb columns scanned)
  or in any of the 14 Meta templates.
- The card is `sendAppDownloadCard` in `src/lib/ai/tools/ethiopian-maids.ts`,
  sent as a Meta `interactive.cta_url` message — not a template.

Anyone extending the card must work here, not in the monorepo.

## Goals

1. iPhone customers receive an App Store card with the official Apple badge.
2. Android behaviour is unchanged.
3. Footers stop claiming iOS is "coming soon".
4. Lucy picks the platform from the conversation; asks when unsure.

## Non-goals

- **No** server-side platform detection via `device_tokens.platform`. A row
  only exists after the app is installed and push is granted, so a user being
  told to *download* the app has no row. Wrong audience by construction.
- **No** Meta message template. The card is sent inside the 24-hour customer
  service window, where `cta_url` interactive messages are allowed and free.
- **No** smart-redirect route. Two platform-specific cards preserve the
  official-store-badge trust rationale the tool was built around.

## Key constraints (verified, not assumed)

| Constraint | Value | Source |
|---|---|---|
| `cta_url` buttons | Exactly **1** per message | `meta-api.ts:194-201` |
| Header image format | PNG/JPEG only — **not SVG** | Meta interactive header |
| Apple's official badge | Served as `image/svg+xml` | `toolbox.marketingtools.apple.com` returns SVG |
| Google's official badge | Served as `image/png` | Already hotlinked today |
| Footer length | ≤60 chars | `meta-api.ts:176-177` |
| Button `display_text` | ≤20 chars | `ethiopian-maids.ts:583` |
| Delivery window | 24-hour service window only | `meta-api.ts:187` |

The one-button limit is why this is two cards rather than one card with both
stores. The SVG/PNG mismatch is why the Apple badge must be self-hosted.

## Design

### 1. Constants

```ts
export const APP_APP_STORE_URL =
  'https://apps.apple.com/us/app/ethiopian-maids/id6762796104';

/** Apple's official badge, rasterized to PNG (Meta cannot render SVG). */
const APP_STORE_BADGE_IMAGE_URL =
  'https://ethiopianmaids.com/badges/app-store.png';
```

`APP_PLAY_STORE_URL` and `PLAY_BADGE_IMAGE_URL` stay exactly as they are.

### 2. `buildAppDownloadCard(language, platform)`

Add a second parameter, mirroring the existing `language` shape:

```ts
export type AppCardPlatform = 'android' | 'ios';

export function buildAppDownloadCard(
  language: AppCardLanguage,
  platform: AppCardPlatform = 'android',
): AppDownloadCard
```

`platform` **defaults to `'android'`**, so existing call sites and tests keep
passing and unknown-platform behaviour is identical to today. The function
stays pure and exported for tests.

### 3. Copy matrix

Each card's footer points at the *other* store, so one card still tells both
audiences the app exists — replacing the false "coming soon" line.

| Lang | Platform | Body (store name) | Button (≤20) | Footer (≤60) |
|---|---|---|---|---|
| en | android | Google Play | `Open Google Play` | `Also available on the App Store` |
| en | ios | the App Store | `Open App Store` | `Also available on Google Play` |
| ar | android | Google Play | `افتح Google Play` | `متوفر أيضاً على App Store` |
| ar | ios | App Store | `افتح App Store` | `متوفر أيضاً على Google Play` |
| am | android | Google Play | `Google Play ክፈት` | `በApp Store ላይም ይገኛል` |
| am | ios | App Store | `App Store ክፈት` | `በGoogle Play ላይም ይገኛል` |

Android body text is unchanged from today. iOS body reuses the same sentence
with the store name swapped, preserving the "official … safe place"
anti-scam framing.

### 4. Tool parameter — this is the "AI detects phone type"

Add to `sendAppDownloadCard.parameters.properties`:

```ts
platform: {
  type: 'string',
  enum: ['android', 'ios'],
  description:
    "Customer's phone type. Pass 'ios' if they mention iPhone/iOS/App Store, "
    + "'android' if they mention Android/Samsung/Google Play. "
    + 'If unknown, ASK one short question before calling this tool. '
    + 'Defaults to android.',
}
```

`required` stays `[]`. Detection happens through the conversation Lucy is
already having — the only channel that can see a user who has not installed
the app yet.

### 5. Badge asset

Rasterize Apple's official badge SVG to PNG and commit it to the monorepo at
`apps/web/public/badges/app-store.png`, served at
`https://ethiopianmaids.com/badges/app-store.png`.

Apple's badge artwork must not be redesigned; rasterizing at correct aspect
ratio is format conversion, not modification. Serving from the official
domain also reinforces the anti-scam rationale.

This is the only monorepo change and must deploy **before** the CRM change,
or Meta will fail to fetch the image.

## Error handling

The existing three-step degradation in `sendAppDownloadCard.handler` is
unchanged and already covers the new risk:

1. `cta_url` **with** header image → `deliveredAs: 'card'`
2. on failure → `cta_url` **without** image → `'card_no_image'`
3. on failure → plain text (`body + url + footer`) → `'text_fallback'`

If Meta cannot fetch the Apple badge, the iOS card still sends without the
image. No new failure mode is introduced.

## Testing

Extend `src/lib/ai/tools/ethiopian-maids.test.ts` (vitest, `pnpm test`):

- `it.each` over the 6 (language × platform) combinations:
  - `platform: 'ios'` → `card.url === APP_APP_STORE_URL`
  - `platform: 'android'` → `card.url === APP_PLAY_STORE_URL`
- Default-arg test: `buildAppDownloadCard('en')` still returns the Play card
  (guards the existing call sites).
- Constraint tests across all 6: `buttonText.length <= 20`,
  `footerText.length <= 60`.
- Regression: no card's footer contains "coming soon" / "قريباً" / "በቅርቡ".
- iOS cards use the App Store badge URL; Android cards keep the Google URL.

## Rollout

1. Add + deploy `apps/web/public/badges/app-store.png` (monorepo). Verify it
   returns HTTP 200 with `Content-Type: image/png` at the public URL.
2. Land the CRM change (branch + PR to `main`, matching repo convention).
3. Verify by messaging the live number: ask as an iPhone user, confirm the
   App Store card renders with badge + working button; repeat for Android.

## Risks

| Risk | Mitigation |
|---|---|
| Meta cannot fetch the Apple PNG | Existing `card_no_image` fallback still delivers |
| Badge deployed after CRM change | Step 1 gates step 2 |
| Lucy guesses platform wrong | Footer names the other store; customer can still self-correct |
| Arabic/Amharic footer >60 chars | Asserted in tests |
