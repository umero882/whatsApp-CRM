import { describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);

import { isCustomerEmail } from './relevance';
import type { ParsedEmail } from './parse';

const parsed: ParsedEmail = {
  messageId: 'x', fromEmail: 'jane@example.com', fromName: 'Jane', replyTo: null,
  toAddresses: ['support@ethiopianmaids.com'], subject: 'register', text: 'how do I sign up as a maid?',
  references: null, autoSubmitted: false,
};

const chat = vi.fn(async () => 'YES');
const provider = { chat } as any;

describe('isCustomerEmail', () => {
  it('short-circuits true for a known profiles.email', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { profiles: [{ id: 'u1' }] } }) });
    const r = await isCustomerEmail({ parsed, hasuraUrl: 'h', hasuraSecret: 's', provider });
    expect(r.isCustomer).toBe(true);
    expect(r.reason).toBe('known_user');
    expect(chat).not.toHaveBeenCalled();
  });

  it('falls back to LLM classification when not a known user', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { profiles: [] } }) });
    const r = await isCustomerEmail({ parsed, hasuraUrl: 'h', hasuraSecret: 's', provider });
    expect(chat).toHaveBeenCalled();
    expect(r.isCustomer).toBe(true);
    expect(r.reason).toBe('llm_related');
  });
});
