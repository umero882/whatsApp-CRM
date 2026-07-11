import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => ({ url: 'https://lookaside.fb/media', mimeType: 'audio/ogg' })),
  downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('fake-ogg'), contentType: 'audio/ogg' })),
}));

import { understandMedia } from './media-understanding';

afterEach(() => vi.restoreAllMocks());

describe('understandMedia — voice', () => {
  it('transcribes an audio note via Whisper and returns kind=voice', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'እኔ አማርኛ እናገራለሁ', language: 'amharic' }), { status: 200 }),
    );
    const r = await understandMedia({
      mediaId: 'm1', contentType: 'audio', mimeType: 'audio/ogg',
      accessToken: 'tok', openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
    });
    expect(r.kind).toBe('voice');
    expect(r.transcript).toContain('አማርኛ');
    expect(r.language?.toLowerCase()).toContain('amharic');
    expect(r.summary).toContain('አማርኛ');
    // Whisper endpoint was called
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
