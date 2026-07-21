import { describe, expect, it, vi } from 'vitest';

const insertContact = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'c-1' }, error: null }) }) }));
const contactsSelect = vi.fn(() => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }));
const convInsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'conv-1' }, error: null }) }) }));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => t === 'contacts'
      ? { select: contactsSelect, insert: insertContact }
      : { insert: convInsert },
  }),
}));

import { findOrCreateEmailContact } from './persist';
import { supabaseAdmin } from '@/lib/flows/admin-client';

describe('findOrCreateEmailContact', () => {
  it('creates a contact keyed by external_id=email when none exists', async () => {
    const sb = supabaseAdmin() as any;
    const c = await findOrCreateEmailContact(sb, 'u1', 'jane@example.com', 'Jane');
    expect(c.id).toBe('c-1');
    expect(insertContact).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', external_id: 'jane@example.com', name: 'Jane' }),
    );
  });
});
