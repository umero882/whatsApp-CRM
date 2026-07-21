import { describe, expect, it, vi, beforeEach } from 'vitest';

// Queues of maybeSingle() results per table, consumed in order by each
// selectExisting() call. Cleared in place (length = 0) between tests so the
// array references captured by the mock stay stable.
const contactSelectResults: Array<{ data: unknown }> = [];
const convSelectResults: Array<{ data: unknown }> = [];
let contactInsertResult: { data: unknown; error: { code?: string; message: string } | null } = {
  data: { id: 'c-1' }, error: null,
};
let convInsertResult: { data: unknown; error: { code?: string; message: string } | null } = {
  data: { id: 'conv-1' }, error: null,
};

const insertContact = vi.fn(() => ({ select: () => ({ single: async () => contactInsertResult }) }));
const insertConv = vi.fn(() => ({ select: () => ({ single: async () => convInsertResult }) }));

function eqChain(queue: Array<{ data: unknown }>) {
  const chain = {
    eq: () => chain,
    maybeSingle: async () => queue.shift() ?? { data: null },
  };
  return chain;
}
const contactsSelect = vi.fn(() => eqChain(contactSelectResults));
const convSelect = vi.fn(() => eqChain(convSelectResults));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => t === 'contacts'
      ? { select: contactsSelect, insert: insertContact }
      : { select: convSelect, insert: insertConv },
  }),
}));

import { findOrCreateEmailContact, findOrCreateEmailConversation } from './persist';
import { supabaseAdmin } from '@/lib/flows/admin-client';

beforeEach(() => {
  contactSelectResults.length = 0;
  convSelectResults.length = 0;
  contactInsertResult = { data: { id: 'c-1' }, error: null };
  convInsertResult = { data: { id: 'conv-1' }, error: null };
  insertContact.mockClear();
  insertConv.mockClear();
});

describe('findOrCreateEmailContact', () => {
  it('creates a contact keyed by external_id=email when none exists', async () => {
    const sb = supabaseAdmin() as never;
    const c = await findOrCreateEmailContact(sb, 'u1', 'jane@example.com', 'Jane');
    expect(c.id).toBe('c-1');
    expect(insertContact).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', external_id: 'jane@example.com', name: 'Jane' }),
    );
  });

  it('returns the existing contact without inserting', async () => {
    contactSelectResults.push({ data: { id: 'c-existing' } });
    const sb = supabaseAdmin() as never;
    const c = await findOrCreateEmailContact(sb, 'u1', 'jane@example.com', 'Jane');
    expect(c.id).toBe('c-existing');
    expect(insertContact).not.toHaveBeenCalled();
  });

  it('re-selects the winner when a concurrent insert loses the unique race (23505)', async () => {
    // First check: none. Insert: unique violation. Re-select: winner's row.
    contactSelectResults.push({ data: null }, { data: { id: 'c-raced' } });
    contactInsertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const sb = supabaseAdmin() as never;
    const c = await findOrCreateEmailContact(sb, 'u1', 'jane@example.com', 'Jane');
    expect(c.id).toBe('c-raced');
  });

  it('throws on a non-unique insert error', async () => {
    contactInsertResult = { data: null, error: { code: '42501', message: 'permission denied' } };
    const sb = supabaseAdmin() as never;
    await expect(findOrCreateEmailContact(sb, 'u1', 'jane@example.com', 'Jane')).rejects.toThrow(/permission denied/);
  });
});

describe('findOrCreateEmailConversation', () => {
  it('creates an email conversation when none exists', async () => {
    const sb = supabaseAdmin() as never;
    const conv = await findOrCreateEmailConversation(sb, 'u1', 'c-1', 'How do I register?');
    expect(conv.id).toBe('conv-1');
    expect(insertConv).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', contact_id: 'c-1', channel: 'email', subject: 'How do I register?' }),
    );
  });

  it('re-selects the winner when a concurrent insert loses the unique race (23505)', async () => {
    convSelectResults.push({ data: null }, { data: { id: 'conv-raced' } });
    convInsertResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const sb = supabaseAdmin() as never;
    const conv = await findOrCreateEmailConversation(sb, 'u1', 'c-1', 'subj');
    expect(conv.id).toBe('conv-raced');
  });
});
