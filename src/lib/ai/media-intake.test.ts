import { describe, expect, it, vi } from 'vitest';

const updateEq = vi.fn(async () => ({ error: null }));
const messagesUpdate = vi.fn((_data: Record<string, unknown>) => ({ eq: updateEq }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => t === 'messages'
      ? { update: messagesUpdate, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ai_media_processed: false } }) }) }) }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) },
  }),
}));
vi.mock('./media-understanding', () => ({
  understandMedia: vi.fn(async () => ({ kind: 'voice', transcript: 'hi', summary: 'hi', confidence: 0.9 })),
}));
vi.mock('./maid-profile-autofill', () => ({ applyMaidProfileAutofill: vi.fn() }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => ({ url: 'https://lookaside.fb/media', mimeType: 'image/jpeg' })),
  downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('fake-jpg'), contentType: 'image/jpeg' })),
}));
vi.mock('./config-load', () => ({ loadMediaConfig: vi.fn(async () => ({
  openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
  hasura: { query: vi.fn() } })) }));

import { processInboundMedia } from './media-intake';
import { understandMedia } from './media-understanding';
import { applyMaidProfileAutofill } from './maid-profile-autofill';

describe('processInboundMedia', () => {
  it('persists the summary to the message row', async () => {
    await processInboundMedia({
      userId: 'u1', conversationId: 'c1', contactId: 'ct1', contactPhone: '251900000000',
      messageId: 'msg1', mediaId: 'md1', contentType: 'audio', mimeType: 'audio/ogg', accessToken: 'tok',
    });
    expect(understandMedia).toHaveBeenCalled();
    expect(messagesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      ai_media_processed: true, ai_media_summary: 'hi',
    }));
  });

  it('never persists the raw passport number to ai_media_data / ai_media_summary', async () => {
    const passportNumber = 'EP1234567';
    vi.mocked(understandMedia).mockResolvedValueOnce({
      kind: 'passport',
      fields: { passport_number: passportNumber, nationality: 'Ethiopian' },
      summary: `Passport for an Ethiopian national, number ${passportNumber}.`,
      confidence: 0.95,
    });

    await processInboundMedia({
      userId: 'u1', conversationId: 'c1', contactId: 'ct1', contactPhone: '251900000000',
      messageId: 'msg2', mediaId: 'md2', contentType: 'image', mimeType: 'image/jpeg', accessToken: 'tok',
    });

    const persistedCall = messagesUpdate.mock.calls.find((call) => call[0]?.ai_media_data !== undefined);
    expect(persistedCall).toBeDefined();
    const persisted = persistedCall![0] as { ai_media_data: unknown; ai_media_summary: string };

    expect(JSON.stringify(persisted.ai_media_data)).not.toContain(passportNumber);
    expect(persisted.ai_media_summary).not.toContain(passportNumber);
    expect(persisted.ai_media_summary).toContain('•••');
    // Safe fields (e.g. nationality) still make it through.
    expect(JSON.stringify(persisted.ai_media_data)).toContain('Ethiopian');

    // The ORIGINAL (unredacted) understanding must still reach the autofill step,
    // since it needs fields.passport_number to decide whether to flag for verification.
    expect(applyMaidProfileAutofill).toHaveBeenCalledWith(
      expect.objectContaining({
        understanding: expect.objectContaining({
          fields: expect.objectContaining({ passport_number: passportNumber }),
        }),
      }),
    );
  });

  it('redacts a passport number that appears ONLY in the summary prose (fields has no passport_number)', async () => {
    const passportNumber = 'EP1234567';
    const expiry = '2028-04-15';
    vi.mocked(understandMedia).mockResolvedValueOnce({
      kind: 'passport',
      // Deliberately NO passport_number in fields — the model echoed the
      // number only in the free-text summary. The redaction must be
      // deterministic (regex-based on the summary text itself), not gated
      // on fields.passport_number being present.
      fields: { nationality: 'Ethiopian', passport_expiry: expiry },
      summary: `Passport for Almaz, no. ${passportNumber}, expires ${expiry}`,
      confidence: 0.95,
    });

    await processInboundMedia({
      userId: 'u1', conversationId: 'c1', contactId: 'ct1', contactPhone: '251900000000',
      messageId: 'msg3', mediaId: 'md3', contentType: 'image', mimeType: 'image/jpeg', accessToken: 'tok',
    });

    const persistedCall = messagesUpdate.mock.calls.find((call) => call[0]?.ai_media_data !== undefined
      && (call[0] as { ai_media_summary?: string }).ai_media_summary?.includes('Almaz'));
    expect(persistedCall).toBeDefined();
    const persisted = persistedCall![0] as { ai_media_data: unknown; ai_media_summary: string };

    expect(persisted.ai_media_summary).not.toContain(passportNumber);
    expect(JSON.stringify(persisted.ai_media_data)).not.toContain(passportNumber);
    // The expiry date must survive the scrub (digit groups <= 4, dash-separated).
    expect(persisted.ai_media_summary).toContain(expiry);
    expect(JSON.stringify(persisted.ai_media_data)).toContain(expiry);
  });
});
