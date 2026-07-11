import type { HasuraClient } from './tools/hasura';
import { phonesMatch } from '@/lib/whatsapp/phone-utils';

export interface MaidMatch {
  maidId: string; first_name: string | null; full_name: string | null;
  nationality: string | null; passport_expiry: string | null; date_of_birth: string | null;
}
export interface MaidLookup { status: 'match' | 'none' | 'multiple'; maid?: MaidMatch; passportOnFile?: boolean; }

const PASSPORT_DOC_TYPES = ['passport', 'passport_front', 'passport_photo'];

// Fetch a bounded candidate set by last-8-digit suffix, then confirm in JS with
// phonesMatch (handles trunk-0 / country-code split differences).
//
// Plan note: this prefilter assumes `phone_number` stores the subscriber number
// without the country code (schema splits phone_country_code + phone_number).
// Not verified against live data during this task (no DB access available) — if
// phone_number turns out to include the country code, widen the prefilter to
// also match the full `digits`.
const CANDIDATES_GQL = /* GraphQL */ `
  query MaidCandidates($suffix: String!) {
    maid_profiles(where: { phone_number: { _ilike: $suffix } }, limit: 10) {
      id first_name full_name nationality passport_expiry date_of_birth
      phone_country_code phone_number
    }
  }
`;
// maid_documents.maid_id is a Firebase UID stored as GraphQL String, not uuid.
const DOCS_GQL = /* GraphQL */ `
  query MaidPassportDocs($maidId: String!, $types: [String!]!) {
    maid_documents(where: { maid_id: { _eq: $maidId }, document_type: { _in: $types } }, limit: 1) { id }
  }
`;

interface Row extends MaidMatch { phone_country_code: string | null; phone_number: string | null; }

export async function lookupMaidByPhone(hasura: HasuraClient, contactPhone: string): Promise<MaidLookup> {
  const digits = contactPhone.replace(/\D/g, '');
  const suffix = `%${digits.slice(-8)}`;
  const data = await hasura.query<{ maid_profiles: Array<Record<string, unknown>> }>(CANDIDATES_GQL, { suffix });
  const rows = (data.maid_profiles ?? []).map((r) => ({
    maidId: String(r.id), first_name: (r.first_name ?? null) as string | null,
    full_name: (r.full_name ?? null) as string | null, nationality: (r.nationality ?? null) as string | null,
    passport_expiry: (r.passport_expiry ?? null) as string | null,
    date_of_birth: (r.date_of_birth ?? null) as string | null,
    phone_country_code: (r.phone_country_code ?? null) as string | null,
    phone_number: (r.phone_number ?? null) as string | null,
  })) as Row[];

  const matches = rows.filter((r) =>
    phonesMatch(digits, `${r.phone_country_code ?? ''}${r.phone_number ?? ''}`) ||
    phonesMatch(digits, r.phone_number ?? ''));

  if (matches.length === 0) return { status: 'none' };
  if (matches.length > 1) return { status: 'multiple' };

  const maid = matches[0];
  const docs = await hasura.query<{ maid_documents: Array<{ id: string }> }>(
    DOCS_GQL, { maidId: maid.maidId, types: PASSPORT_DOC_TYPES });
  return {
    status: 'match',
    maid: { maidId: maid.maidId, first_name: maid.first_name, full_name: maid.full_name,
      nationality: maid.nationality, passport_expiry: maid.passport_expiry, date_of_birth: maid.date_of_birth },
    passportOnFile: (docs.maid_documents ?? []).length > 0,
  };
}
