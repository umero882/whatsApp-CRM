import { describe, expect, it, vi } from 'vitest';
vi.mock('./maid-lookup', () => ({ lookupMaidByPhone: vi.fn() }));
import { lookupMaidByPhone } from './maid-lookup';
import { applyMaidProfileAutofill } from './maid-profile-autofill';
import type { HasuraClient } from './tools/hasura';

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
    const setSpy = vi.fn(async (_op: string, _vars?: Record<string, unknown>) => ({ maid_profiles: { affected_rows: 1 } }));
    const hasura = { query: setSpy } as unknown as HasuraClient;
    (lookupMaidByPhone as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'match',
      maid: { maidId: 'm1', first_name: 'Almaz', full_name: null, nationality: null,
        passport_expiry: null, date_of_birth: null },
      passportOnFile: true,
    });
    const { client, insert } = supa();
    const messageCreatedAt = '2026-07-11T10:00:00.000Z';
    const r = await applyMaidProfileAutofill({
      hasura, supabase: client, userId: 'u1', contactPhone: '251973742567',
      conversationId: 'c1', contactId: 'ct1',
      understanding: passport({ first_name: 'Almaz', full_name: 'Almaz Tesfaye', nationality: 'Ethiopian',
        passport_number: 'EP1234567', passport_expiry: '2028-04-15', date_of_birth: '1996-02-03' }),
      messageCreatedAt,
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
    // The note's created_at must be stamped strictly BEFORE the triggering
    // customer message, so the customer message stays the newest row and
    // runAgent's race guard doesn't mistake this internal note for the last
    // turn (which would silently skip the agent's WhatsApp reply).
    const insertCalls = insert.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const noteCall = insertCalls.find((c) =>
      c[0]?.content_text && String(c[0].content_text).match(/verify/i));
    expect(noteCall).toBeDefined();
    const noteArg = noteCall![0] as { created_at?: string };
    expect(noteArg.created_at).toBeDefined();
    expect(new Date(noteArg.created_at!).getTime()).toBeLessThan(new Date(messageCreatedAt).getTime());
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
      hasura: { query: setSpy } as unknown as HasuraClient, supabase: client, userId: 'u1', contactPhone: '251900000000',
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
      hasura: { query: setSpy } as unknown as HasuraClient, supabase: client, userId: 'u1', contactPhone: '251900000000',
      conversationId: 'c1', contactId: 'ct1',
      understanding: { kind: 'passport', summary: 's', confidence: 0.95, fields: { nationality: 'Ethiopian' } },
      imageBytes: { buffer: Buffer.from('img'), mimeType: 'image/jpeg' },
    });
    expect(upload).not.toHaveBeenCalled();
    expect(r.documentUploaded).toBe(false);
  });
});
