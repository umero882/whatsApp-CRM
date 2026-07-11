import type { SupabaseClient } from '@supabase/supabase-js';
import type { HasuraClient } from './tools/hasura';
import type { MediaUnderstanding } from './media-understanding';
import { lookupMaidByPhone, type MaidMatch } from './maid-lookup';

export interface AutofillResult {
  matched: boolean; maidId?: string; filledFields: string[];
  passportPendingVerify: boolean; documentUploaded: boolean; reason?: string;
}

// NOTE: maid_profiles.id is a Firebase UID stored as GraphQL `String`, NOT uuid
// (verified against live Hasura). Use String! for every maid-id variable.
const UPDATE_GQL = /* GraphQL */ `
  mutation FillMaid($id: String!, $set: maid_profiles_set_input!) {
    update_maid_profiles(where: { id: { _eq: $id } }, _set: $set) { affected_rows }
  }
`;

const INSERT_DOC_GQL = /* GraphQL */ `
  mutation InsertMaidDoc($obj: maid_documents_insert_input!) {
    insert_maid_documents_one(object: $obj) { id }
  }
`;

// Only these fields may be auto-written. passport_number is deliberately absent.
const SAFE_FIELDS = ['first_name', 'full_name', 'nationality', 'passport_expiry', 'date_of_birth'] as const;

function blankOnly(maid: MaidMatch, fields: MediaUnderstanding['fields']): Record<string, string> {
  const set: Record<string, string> = {};
  if (!fields) return set;
  for (const key of SAFE_FIELDS) {
    const current = (maid as unknown as Record<string, unknown>)[key];
    const incoming = (fields as unknown as Record<string, unknown>)[key];
    if ((current === null || current === undefined || current === '') && typeof incoming === 'string' && incoming.trim()) {
      set[key] = incoming.trim();
    }
  }
  return set;
}

async function tagContact(
  supabase: SupabaseClient, userId: string, contactId: string, name: string, color: string,
): Promise<void> {
  const { data: existing } = await supabase.from('tags').select('id').eq('user_id', userId).eq('name', name).maybeSingle();
  let tagId = existing?.id as string | undefined;
  if (!tagId) {
    const { data: created } = await supabase.from('tags')
      .insert({ user_id: userId, name, color }).select('id').single();
    tagId = created?.id;
  }
  if (tagId) {
    await supabase.from('contact_tags')
      .upsert({ contact_id: contactId, tag_id: tagId }, { onConflict: 'contact_id,tag_id' });
  }
}

export async function applyMaidProfileAutofill(input: {
  hasura: HasuraClient; supabase: SupabaseClient; userId: string;
  contactPhone: string; conversationId: string; contactId: string;
  understanding: MediaUnderstanding; imageBytes?: { buffer: Buffer; mimeType: string };
}): Promise<AutofillResult> {
  const { understanding: u } = input;
  if (u.kind !== 'passport' && u.kind !== 'national_id') {
    return { matched: false, filledFields: [], passportPendingVerify: false, documentUploaded: false, reason: 'not_id_doc' };
  }
  if (u.confidence < 0.6) {
    return { matched: false, filledFields: [], passportPendingVerify: false, documentUploaded: false, reason: 'low_confidence' };
  }

  const lookup = await lookupMaidByPhone(input.hasura, input.contactPhone);
  if (lookup.status !== 'match' || !lookup.maid) {
    return { matched: false, filledFields: [], passportPendingVerify: false, documentUploaded: false,
      reason: lookup.status === 'multiple' ? 'multiple_matches' : 'no_match' };
  }
  const maid = lookup.maid;

  const set = blankOnly(maid, u.fields);
  const filledFields = Object.keys(set);
  if (filledFields.length > 0) {
    await input.hasura.query(UPDATE_GQL, { id: maid.maidId, set });
  }

  // An ID document was received for a matched maid → flag it for human
  // verification. The raw number is NEVER stored (not in the profile, not in
  // this note, not in logs) — the team reads it from the uploaded/existing
  // document, consistent with the app's encrypted-PII model.
  let passportPendingVerify = false;
  if (u.kind === 'passport' || u.kind === 'national_id') {
    await tagContact(input.supabase, input.userId, input.contactId, 'passport_pending_verify', '#f59e0b');
    await input.supabase.from('messages').insert({
      conversation_id: input.conversationId,
      sender_type: 'agent', agent_kind: 'ai', content_type: 'text', status: 'sent',
      content_text: '🔒 Passport/ID received — verify the number against the document (not auto-saved).',
    });
    passportPendingVerify = true;
  }

  let documentUploaded = false;
  const wantUpload =
    input.imageBytes && lookup.passportOnFile === false && (u.kind === 'passport' || u.kind === 'national_id');
  if (wantUpload && input.imageBytes) {
    try {
      const ext = input.imageBytes.mimeType.includes('png') ? 'png' : 'jpg';
      const path = `${maid.maidId}/passport_${Date.now()}.${ext}`;
      const { error: upErr } = await input.supabase.storage
        .from('maid-documents')
        .upload(path, input.imageBytes.buffer, { contentType: input.imageBytes.mimeType, upsert: false });
      if (!upErr) {
        // Private bucket → long-lived SIGNED url (passport must not be world-readable).
        // 10 years so the maids app has a durable link.
        const { data: signed } = await input.supabase.storage
          .from('maid-documents').createSignedUrl(path, 315_360_000);
        if (signed?.signedUrl) {
          await input.hasura.query(INSERT_DOC_GQL, {
            obj: {
              maid_id: maid.maidId, document_type: 'passport', document_url: signed.signedUrl,
              expiry_date: u.fields?.passport_expiry ?? null, mime_type: input.imageBytes.mimeType, verified: false,
            },
          });
          documentUploaded = true;
        }
      }
    } catch (e) {
      console.warn('[autofill] passport upload failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  return { matched: true, maidId: maid.maidId, filledFields, passportPendingVerify, documentUploaded };
}
