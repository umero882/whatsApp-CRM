import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_APP_STORE_URL,
  APP_PLAY_STORE_URL,
  buildAppDownloadCard,
  buildChoiceMessage,
  buildEscalationForward,
  saveMatchAlert,
  sendAppDownloadCard,
} from './ethiopian-maids';
import { formatKbPassages } from './knowledge-base';
import type { ToolContext } from './registry';

/**
 * Minimal supabase mock: records update/insert payloads and their
 * .eq filters; both chains are awaitable and resolve { error: null }.
 * Shared across suites that need a stand-in `ctx.supabase`.
 */
function mockSupabase() {
  const ops: Array<{ table: string; kind: 'update' | 'insert'; payload: unknown; eqs: Array<[string, unknown]> }> = [];
  return {
    ops,
    client: {
      from(table: string) {
        return {
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

  it('sends the App Store card and tells the agent to say App Store', async () => {
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
