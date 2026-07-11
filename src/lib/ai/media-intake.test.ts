import { describe, expect, it, vi } from 'vitest';

const updateEq = vi.fn(async () => ({ error: null }));
const messagesUpdate = vi.fn(() => ({ eq: updateEq }));
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
vi.mock('./config-load', () => ({ loadMediaConfig: vi.fn(async () => ({
  openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
  hasura: { query: vi.fn() } })) }));

import { processInboundMedia } from './media-intake';
import { understandMedia } from './media-understanding';

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
});
