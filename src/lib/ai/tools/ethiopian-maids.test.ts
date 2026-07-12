import { describe, expect, it } from 'vitest';
import {
  APP_PLAY_STORE_URL,
  buildAppDownloadCard,
  buildEscalationForward,
  saveMatchAlert,
} from './ethiopian-maids';
import type { ToolContext } from './registry';

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
  it.each(['en', 'ar', 'am'] as const)('%s card points at the official store with a valid button', (lang) => {
    const card = buildAppDownloadCard(lang);
    expect(card.url).toBe(APP_PLAY_STORE_URL);
    expect(card.url).toContain('play.google.com/store/apps/details?id=com.ethiopianmaids.app');
    expect(card.headerImageUrl).toMatch(/^https:\/\/play\.google\.com\/.*badge.*\.png$/);
    // Meta cta_url limits: display_text ≤20 chars, footer ≤60 chars.
    expect(card.buttonText.length).toBeGreaterThan(0);
    expect(card.buttonText.length).toBeLessThanOrEqual(20);
    expect(card.footerText.length).toBeLessThanOrEqual(60);
    expect(card.bodyText.length).toBeGreaterThan(20);
    expect(card.bodyText.length).toBeLessThanOrEqual(1024);
  });
});

describe('saveMatchAlert.handler', () => {
  /**
   * Minimal supabase mock: records update/insert payloads and their
   * .eq filters; both chains are awaitable and resolve { error: null }.
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

  function makeCtx(client: unknown): ToolContext {
    return {
      supabase: client,
      userId: 'user-1',
      conversationId: 'conv-1',
      contactPhone: '+971585868560',
      contactName: 'Ahmed',
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
