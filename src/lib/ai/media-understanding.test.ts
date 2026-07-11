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

describe('understandMedia — vision', () => {
  it('classifies a passport image and extracts safe fields', async () => {
    const content = JSON.stringify({
      kind: 'passport',
      fields: { full_name: 'Almaz Tesfaye', first_name: 'Almaz', nationality: 'Ethiopian',
                passport_number: 'EP1234567', passport_expiry: '2028-04-15', date_of_birth: '1996-02-03' },
      summary: 'Ethiopian passport for Almaz Tesfaye, expires 2028-04-15',
      confidence: 0.94,
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
    const r = await understandMedia({
      mediaId: 'm2', contentType: 'image', mimeType: 'image/jpeg',
      accessToken: 'tok', openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
    });
    expect(r.kind).toBe('passport');
    expect(r.fields?.nationality).toBe('Ethiopian');
    expect(r.fields?.passport_number).toBe('EP1234567');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to kind=other on unparseable model output', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }),
    );
    const r = await understandMedia({
      mediaId: 'm3', contentType: 'image', mimeType: 'image/jpeg',
      accessToken: 'tok', openrouter: { apiKey: 'or', model: 'openai/gpt-4o-mini' }, openaiKey: 'oa',
    });
    expect(r.kind).toBe('other');
    expect(r.confidence).toBeLessThan(0.6);
  });
});
