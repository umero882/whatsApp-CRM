import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { understandMedia, type MediaUnderstanding } from './media-understanding';
import { applyMaidProfileAutofill } from './maid-profile-autofill';
import { loadMediaConfig } from './config-load';

// Alphanumeric runs of length >= 6 that contain at least one digit — matches
// passport/ID numbers like "EP1234567" or "123456789" but leaves dash-separated
// ISO dates (e.g. "2028-04-15", digit groups <= 4) untouched.
const ID_NUMBER_LIKE = /\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}\b/g;

function scrubIdNumbers(text: string): string {
  return text.replace(ID_NUMBER_LIKE, '•••');
}

// The raw passport/ID number must NEVER be persisted anywhere (hard invariant).
// This produces a copy of `understanding` safe to write to messages.ai_media_data /
// ai_media_summary: passport_number (and any future national-ID number field) is
// dropped from `fields`, and any passport/ID-number-like token is masked out of
// `summary` DETERMINISTICALLY — independent of whether `fields.passport_number`
// happened to be extracted (the model may echo the number in prose even when it
// doesn't structure it into `fields`).
function redactForPersistence(u: MediaUnderstanding): MediaUnderstanding {
  let safeFields = u.fields;
  if (safeFields && 'passport_number' in safeFields) {
    const { passport_number: _omit, ...rest } = safeFields;
    safeFields = rest;
  }
  return {
    ...u,
    fields: safeFields,
    summary: scrubIdNumbers(u.summary),
    ...(u.transcript ? { transcript: scrubIdNumbers(u.transcript) } : {}),
  };
}

export async function processInboundMedia(input: {
  userId: string; conversationId: string; contactId: string; contactPhone: string;
  messageId: string; mediaId: string;
  contentType: 'image' | 'audio' | 'document'; mimeType: string | null; accessToken: string;
}): Promise<void> {
  let sb: SupabaseClient | undefined;
  try {
    sb = supabaseAdmin();
    // Idempotency guard.
    const { data: existing } = await sb.from('messages')
      .select('ai_media_processed, created_at').eq('id', input.messageId).maybeSingle();
    if (existing?.ai_media_processed) return;
    const messageCreatedAt: string | null = existing?.created_at ?? null;

    const cfg = await loadMediaConfig(sb, input.userId);
    if (!cfg) {
      await sb.from('messages').update({ ai_media_processed: true }).eq('id', input.messageId);
      return;
    }

    const understanding = await understandMedia({
      mediaId: input.mediaId, contentType: input.contentType, mimeType: input.mimeType,
      accessToken: input.accessToken, openrouter: cfg.openrouter, openaiKey: cfg.openaiKey,
    });

    // Never persist the raw passport/ID number — only a redacted copy reaches the DB.
    const redacted = redactForPersistence(understanding);

    await sb.from('messages').update({
      ai_media_processed: true,
      ai_media_summary: redacted.summary,
      ai_media_data: redacted as unknown as Record<string, unknown>,
      // Surface voice transcript as the message text so detectLanguage + inbox work.
      ...(understanding.kind === 'voice' && understanding.transcript
        ? { content_text: understanding.transcript } : {}),
    }).eq('id', input.messageId);

    if (understanding.kind === 'passport' || understanding.kind === 'national_id') {
      // Re-download bytes for the upload branch (cheap; keeps understandMedia pure).
      let imageBytes: { buffer: Buffer; mimeType: string } | undefined;
      try {
        const info = await getMediaUrl({ mediaId: input.mediaId, accessToken: input.accessToken });
        const dl = await downloadMedia({ downloadUrl: info.url, accessToken: input.accessToken });
        imageBytes = { buffer: dl.buffer, mimeType: dl.contentType || info.mimeType || 'image/jpeg' };
      } catch { /* upload just won't happen */ }

      await applyMaidProfileAutofill({
        hasura: cfg.hasura, supabase: sb, userId: input.userId,
        contactPhone: input.contactPhone, conversationId: input.conversationId, contactId: input.contactId,
        understanding, imageBytes, messageCreatedAt,
      });
    }
  } catch (e) {
    console.error('[media-intake] failed (non-fatal):', e instanceof Error ? e.message : e);
    if (sb) {
      await sb.from('messages').update({ ai_media_processed: true }).eq('id', input.messageId).then(() => {}, () => {});
    }
  }
}
