import { describe, expect, it, vi } from 'vitest';
import type { HasuraClient } from './tools/hasura';
import { lookupMaidByPhone } from './maid-lookup';

// Cast needed: HasuraClient.query<T>() is generic, but the mock's concrete
// union return type doesn't structurally satisfy an arbitrary T under strict TS.
const hasura = (rows: unknown[], docs: unknown[] = []): HasuraClient => ({
  query: vi.fn(async (op: string) =>
    op.includes('maid_documents') ? { maid_documents: docs } : { maid_profiles: rows }),
}) as unknown as HasuraClient;

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
