import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_APP_STORE_URL,
  APP_PLAY_STORE_URL,
  buildAppDownloadCard,
  buildChoiceMessage,
  buildEscalationForward,
  buildMaidContactButton,
  CONTACT_CARD_FOOTER,
  ETHIOPIAN_MAIDS_TOOLS,
  maidProfileUrl,
  saveMatchAlert,
  sendAppDownloadCard,
  sendMaidCards,
} from './ethiopian-maids';
import { formatKbPassages } from './knowledge-base';
import type { ToolContext } from './registry';

/**
 * Minimal supabase mock: records update/insert payloads and their
 * .eq filters; both chains are awaitable and resolve { error: null }.
 * Shared across suites that need a stand-in `ctx.supabase`.
 */
function mockSupabase(selectRows: Array<Record<string, unknown>> = []) {
  const ops: Array<{ table: string; kind: 'update' | 'insert'; payload: unknown; eqs: Array<[string, unknown]> }> = [];
  return {
    ops,
    client: {
      from(table: string) {
        return {
          select() {
            const chain = {
              eq() { return chain; },
              ilike() { return chain; },
              limit() { return chain; },
              then(resolve: (r: { data: Array<Record<string, unknown>>; error: null }) => void) { resolve({ data: selectRows, error: null }); },
            };
            return chain;
          },
          update(payload: unknown) {
            const rec = { table, kind: 'update' as const, payload, eqs: [] as Array<[string, unknown]> };
            ops.push(rec);
            const chain = {
              eq(k: string, v: unknown) { rec.eqs.push([k, v]); return chain; },
              then(resolve: (r: { error: null }) => void) { resolve({ error: null }); },
            };
            return chain;
          },
          insert(payload: unknown) {
            ops.push({ table, kind: 'insert', payload, eqs: [] });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('buildEscalationForward', () => {
  it('includes name, normalized number, reason, issue, and reply link', () => {
    const msg = buildEscalationForward({
      customerName: 'Muna Kedir',
      customerPhone: '+971 58 586 8560',
      reason: 'job application needs human follow-up',
      issueSummary: 'Job seeker in UAE, wants cleaning work, available immediately.',
      urgent: false,
    });
    expect(msg).toContain('🟠 Human needed');
    expect(msg).toContain('Customer: Muna Kedir (+971585868560)');
    expect(msg).toContain('Reason: job application needs human follow-up');
    expect(msg).toContain('Issue: Job seeker in UAE, wants cleaning work, available immediately.');
    expect(msg).toContain('https://wa.me/971585868560');
  });

  it('marks urgent escalations and tolerates missing name/summary', () => {
    const msg = buildEscalationForward({
      customerName: null,
      customerPhone: '971526799960',
      reason: 'customer is angry',
      issueSummary: null,
      urgent: true,
    });
    expect(msg).toContain('🔴 URGENT — human needed');
    expect(msg).toContain('Customer: Unknown (+971526799960)');
    expect(msg).not.toContain('Issue:');
    expect(msg).toContain('https://wa.me/971526799960');
  });
});

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
      // Arabic "soon" appears with the tanween mark (U+064B) either after the
      // alif (قريباً) or, per standard orthography, before it (قريبًا) — both
      // are just 'قريبا' plus that mark in a different spot. Strip U+064B so
      // every orthography collapses to the same base string; otherwise a
      // banned-word list keyed on one spelling silently misses the other.
      const footerNoTanween = card.footerText.replace(/\u064B/g, '');
      for (const banned of ['coming soon', 'قريبا', 'በቅርቡ']) {
        expect(footerNoTanween).not.toContain(banned);
      }
    },
  );

  it('each card footer points at the other store', () => {
    expect(buildAppDownloadCard('en', 'android').footerText).toContain('App Store');
    expect(buildAppDownloadCard('en', 'ios').footerText).toContain('Google Play');
  });
});

describe('saveMatchAlert.handler', () => {
  function makeCtx(client: unknown): ToolContext {
    return {
      supabase: client,
      userId: 'user-1',
      conversationId: 'conv-1',
      contactPhone: '+971585868560',
      contactName: 'Ahmed',
      channel: 'whatsapp',
      escalationPhone: null,
      hasuraUrl: null,
      hasuraAdminSecret: null,
      whatsapp: null,
    } as ToolContext;
  }

  it('cancels the previous active alert for the same side, then inserts the new one', async () => {
    const sb = mockSupabase();
    const result = (await saveMatchAlert.handler(
      {
        side: 'sponsor',
        language: 'ar',
        live_in: true,
        skills: ['childcare', 'childcare'],
        max_salary_aed: 1500,
        country: 'UAE', // maid-side field — dropped by normalization
      },
      makeCtx(sb.client),
    )) as { ok?: boolean; note?: string };

    expect(result.ok).toBe(true);
    expect(result.note).toContain('candidate');

    expect(sb.ops).toHaveLength(2);
    const [cancel, insert] = sb.ops;
    expect(cancel.table).toBe('ai_match_alerts');
    expect(cancel.kind).toBe('update');
    expect(cancel.payload).toEqual({ status: 'cancelled' });
    expect(cancel.eqs).toEqual([
      ['conversation_id', 'conv-1'],
      ['side', 'sponsor'],
      ['status', 'active'],
    ]);
    expect(insert.kind).toBe('insert');
    expect(insert.payload).toEqual({
      user_id: 'user-1',
      conversation_id: 'conv-1',
      recipient_phone: '+971585868560',
      side: 'sponsor',
      criteria: { live_in: true, skills: ['childcare'], max_salary_aed: 1500 },
      language: 'ar',
    });
  });

  it('defaults to side-appropriate note and en language on the maid side', async () => {
    const sb = mockSupabase();
    const result = (await saveMatchAlert.handler(
      { side: 'maid', country: 'UAE', city: 'Dubai' },
      makeCtx(sb.client),
    )) as { ok?: boolean; note?: string };
    expect(result.ok).toBe(true);
    expect(result.note).toContain('job');
    const insert = sb.ops[1];
    expect(insert.payload).toMatchObject({
      side: 'maid',
      language: 'en',
      criteria: { country: 'UAE', city: 'Dubai' },
    });
  });
});

describe('buildChoiceMessage', () => {
  it('renders 2-3 options as buttons with 20-char titles and stable ids', () => {
    const c = buildChoiceMessage('Live-in or live-out?', ['Live-in', 'Live-out']);
    expect(c.kind).toBe('buttons');
    expect(c.options).toEqual([
      { id: 'opt_1', title: 'Live-in' },
      { id: 'opt_2', title: 'Live-out' },
    ]);
    expect(c.buttonLabel).toBeUndefined();
  });

  it('renders 4+ options as a list with a default button label', () => {
    const c = buildChoiceMessage('Which emirate?', ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Fujairah']);
    expect(c.kind).toBe('list');
    expect(c.options).toHaveLength(5);
    expect(c.buttonLabel).toBe('Choose an option');
  });

  it('truncates long titles to the per-kind Meta limit', () => {
    const long = 'This option title is way too long for Meta';
    const buttons = buildChoiceMessage('Q?', [long, 'B']);
    expect(buttons.options[0].title).toHaveLength(20);
    const list = buildChoiceMessage('Q?', [long, 'B', 'C', 'D']);
    expect(list.options[0].title).toHaveLength(24);
  });

  it('dedupes, drops empties, caps at 10, and validates inputs', () => {
    const c = buildChoiceMessage('Q?', ['A', 'A', ' ', ...'BCDEFGHIJKLM'.split('')]);
    expect(c.options).toHaveLength(10);
    expect(() => buildChoiceMessage('', ['A'])).toThrow(/body_text/);
    expect(() => buildChoiceMessage('Q?', ['', '  '])).toThrow(/options/);
  });
});

describe('formatKbPassages', () => {
  it('formats hits with source titles and a strict answering note', () => {
    const r = formatKbPassages([
      { chunk_id: 'c1', document_id: 'd1', document_title: 'Fees & inclusions', content: 'The placement fee includes visa and medical.', score: 0.9 },
      { chunk_id: 'c2', document_id: 'd2', document_title: 'Refund policy', content: '90-day replacement guarantee.', score: 0.5 },
    ]);
    expect(r.found).toBe(2);
    expect(r.passages).toEqual([
      { source: 'Fees & inclusions', content: 'The placement fee includes visa and medical.' },
      { source: 'Refund policy', content: '90-day replacement guarantee.' },
    ]);
    expect(r.note).toContain('ONLY these passages');
  });

  it('empty result instructs the model to admit the gap, never invent', () => {
    const r = formatKbPassages([]);
    expect(r.found).toBe(0);
    expect(r.note).toContain('do NOT guess');
  });
});

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

  it('sends only the App Store card when the customer said iPhone', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubMetaSend(sent);

    const supa = mockSupabase();
    const res = await sendAppDownloadCard.handler({ language: 'en', platform: 'ios' }, ctxFor(supa.client));

    expect((res as { ok: boolean }).ok).toBe(true);
    expect((res as { sent_cards: string[] }).sent_cards).toEqual(['ios']);
    expect((res as { note: string }).note).toContain('App Store');
    const payload = JSON.stringify(sent);
    expect(payload).toContain(APP_APP_STORE_URL);
    expect(payload).not.toContain(APP_PLAY_STORE_URL);
  });

  // Regression (production incident 2026-07-17): when the phone is unknown
  // the model must not pick a store — BOTH cards go out so the customer taps
  // their own. A junk value is treated as "unknown", never coerced to a store.
  it('omitted platform sends BOTH store cards', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubMetaSend(sent);

    const supa = mockSupabase();
    const res = await sendAppDownloadCard.handler({ language: 'en' }, ctxFor(supa.client));

    expect((res as { sent_cards: string[] }).sent_cards).toEqual(['android', 'ios']);
    const payload = JSON.stringify(sent);
    expect(payload).toContain(APP_PLAY_STORE_URL);
    expect(payload).toContain(APP_APP_STORE_URL);
    expect((res as { note: string }).note).toContain('Google Play');
    expect((res as { note: string }).note).toContain('App Store');
  });

  it.each(['IOS', 'windows', 'ios ', ''])('junk platform %p sends both cards', async (junk) => {
    const sent: Array<Record<string, unknown>> = [];
    stubMetaSend(sent);

    const supa = mockSupabase();
    const res = await sendAppDownloadCard.handler({ language: 'en', platform: junk }, ctxFor(supa.client));

    expect((res as { sent_cards: string[] }).sent_cards).toEqual(['android', 'ios']);
    const payload = JSON.stringify(sent);
    expect(payload).toContain(APP_PLAY_STORE_URL);
    expect(payload).toContain(APP_APP_STORE_URL);
  });
});

// ════════════════════════════════════════════════════════════════════
// send_maid_cards — a Contact button on every card, the app card after
// (2026-09-20: contact and the video interview happen in the app, for a
// registered sponsor on a package — never from WhatsApp)
// ════════════════════════════════════════════════════════════════════

describe('maid card contact pieces', () => {
  it('links to the maid\'s own profile page — the route the mobile app shares and can open', () => {
    expect(maidProfileUrl('abc-123')).toBe('https://ethiopianmaids.com/maid/abc-123');
    expect(maidProfileUrl('a b')).toBe('https://ethiopianmaids.com/maid/a%20b');
  });

  it('keeps the button label inside Meta\'s 20 characters', () => {
    expect(buildMaidContactButton('Roza')).toBe('Contact Roza');
    expect(buildMaidContactButton('Nakyejjwe Justine')).toBe('Contact her');
    expect(buildMaidContactButton('')).toBe('Contact her');
    expect(CONTACT_CARD_FOOTER.length).toBeLessThanOrEqual(60);
  });

  it('book_interview is no longer a WhatsApp agent tool', () => {
    expect(ETHIOPIAN_MAIDS_TOOLS.map((t) => t.name)).not.toContain('book_interview');
    expect(ETHIOPIAN_MAIDS_TOOLS.map((t) => t.name)).toContain('send_maid_cards');
  });
});

describe('sendMaidCards.handler', () => {
  const ROWS = [
    { id: 'm-1', first_name: 'Roza', full_name: 'Roza Keder', nationality: 'ET', country: 'AE', experience_years: 5,
      languages: ['english', 'amharic'], skills: ['cleaning', 'childcare'], preferred_salary_min: 3000, preferred_salary_max: 3750,
      preferred_currency: 'AED', profile_photo_url: 'https://img.example/roza.jpg', available_from: null, live_in_preference: true },
    { id: 'm-2', first_name: 'Haweni', full_name: null, nationality: 'ET', country: null, experience_years: 0,
      languages: ['amharic'], skills: ['cooking'], preferred_salary_min: null, preferred_salary_max: null,
      preferred_currency: null, profile_photo_url: null, available_from: '2026-08-19', live_in_preference: null },
  ];

  function ctxFor(supabase: unknown) {
    return {
      supabase,
      conversationId: 'conv-1',
      contactPhone: '+971585868560',
      hasuraUrl: 'https://hasura.example/v1/graphql',
      hasuraAdminSecret: null,
      cardLanguage: 'en',
      whatsapp: { phoneNumberId: 'pn-1', accessToken: 'tok-1' },
    } as unknown as ToolContext;
  }

  /** Hasura answers with the rows; Meta records every payload. `refuse` makes Meta reject a payload shape. */
  function stubFetch(sent: Array<Record<string, unknown>>, refuse?: (payload: Record<string, unknown>) => boolean) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        if (String(url).includes('hasura.example')) {
          return { ok: true, status: 200, text: async (): Promise<string> => JSON.stringify({ data: { maid_profiles_public: ROWS } }) };
        }
        const payload = JSON.parse(String(init.body));
        if (refuse && refuse(payload)) {
          return { ok: false, status: 400, json: async () => ({ error: { message: 'refused' } }), text: async (): Promise<string> => 'refused' };
        }
        sent.push(payload);
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${sent.length}` }] }), text: async (): Promise<string> => '' };
      }),
    );
  }

  it('sends each maid as a CTA card — photo header when there is one, Contact button to her profile — then the app cards once', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubFetch(sent);
    const supa = mockSupabase();
    const res = await sendMaidCards.handler({ maid_ids: ['m-1', 'm-2'] }, ctxFor(supa.client)) as Record<string, unknown>;

    expect(res.success_count).toBe(2);
    expect(res.sent).toEqual([{ maid_id: 'm-1', ok: true, delivered_as: 'card' }, { maid_id: 'm-2', ok: true, delivered_as: 'card_no_image' }]);
    expect(res.app_card).toBe('sent');
    expect(String(res.note)).toMatch(/Contact/);
    expect(String(res.note)).toMatch(/do NOT offer to book/);

    const cards = sent.filter((p) => (p.interactive as { type: string } | undefined)?.type === 'cta_url');
    expect(cards).toHaveLength(4); // two maids + Google Play + App Store
    const roza = cards[0].interactive as { header?: unknown; body: { text: string }; footer: { text: string }; action: { parameters: { display_text: string; url: string } } };
    expect(roza.header).toEqual({ type: 'image', image: { link: 'https://img.example/roza.jpg' } });
    expect(roza.body.text).toContain('*Roza* — ET');
    expect(roza.body.text).toContain('3,000–3,750 AED/mo · Live-in');
    expect(roza.footer.text).toBe(CONTACT_CARD_FOOTER);
    expect(roza.action.parameters).toEqual({ display_text: 'Contact Roza', url: 'https://ethiopianmaids.com/maid/m-1' });
    const haweni = cards[1].interactive as { header?: unknown; action: { parameters: { display_text: string; url: string } } };
    expect(haweni.header).toBeUndefined();
    expect(haweni.action.parameters).toEqual({ display_text: 'Contact Haweni', url: 'https://ethiopianmaids.com/maid/m-2' });
    expect(JSON.stringify(cards.slice(2))).toContain(APP_PLAY_STORE_URL);
    expect(JSON.stringify(cards.slice(2))).toContain(APP_APP_STORE_URL);

    // The inbox sees the photo card as an image with the caption and where the button goes; the app card as its usual row.
    const inserts = supa.ops.filter((o) => o.kind === 'insert' && o.table === 'messages').map((o) => o.payload as Record<string, unknown>);
    expect(inserts).toHaveLength(3);
    expect(inserts[0]).toMatchObject({ content_type: 'image', media_url: 'https://img.example/roza.jpg', message_id: 'wamid.1' });
    expect(String(inserts[0].content_text)).toContain('Contact Roza → https://ethiopianmaids.com/maid/m-1');
    expect(inserts[1]).toMatchObject({ content_type: 'text', message_id: 'wamid.2' });
    expect(inserts[2]).toMatchObject({ content_text: '[Official app download card]' });
  });

  it('does not send the app card again when the conversation already has one', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubFetch(sent);
    const supa = mockSupabase([{ id: 'msg-old' }]);
    const res = await sendMaidCards.handler({ maid_ids: ['m-1'] }, ctxFor(supa.client)) as Record<string, unknown>;
    expect(res.app_card).toBe('already_sent');
    expect(sent.filter((p) => (p.interactive as { type: string } | undefined)?.type === 'cta_url')).toHaveLength(1);
  });

  it('falls back to the photo + caption when Meta refuses the CTA form, and still reports the link', async () => {
    const sent: Array<Record<string, unknown>> = [];
    stubFetch(sent, (p) => (p.interactive as { type?: string } | undefined)?.type === 'cta_url' && !!(p.interactive as { header?: unknown }).header && String(JSON.stringify(p)).includes('/maid/'));
    const supa = mockSupabase([{ id: 'msg-old' }]);
    const res = await sendMaidCards.handler({ maid_ids: ['m-1'] }, ctxFor(supa.client)) as Record<string, unknown>;
    expect(res.sent).toEqual([{ maid_id: 'm-1', ok: true, delivered_as: 'card_no_image' }]);
    // Even the imageless CTA refused → the plain photo goes, caption carrying the link.
    stubFetch(sent, (p) => (p.interactive as { type?: string } | undefined)?.type === 'cta_url');
    const again = await sendMaidCards.handler({ maid_ids: ['m-1'] }, ctxFor(supa.client)) as Record<string, unknown>;
    expect(again.sent).toEqual([{ maid_id: 'm-1', ok: true, delivered_as: 'image' }]);
    const image = sent[sent.length - 1] as { type: string; image: { caption: string } };
    expect(image.type).toBe('image');
    expect(image.image.caption).toContain('https://ethiopianmaids.com/maid/m-1');
  });
});
