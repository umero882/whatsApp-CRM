import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkRowContent, chunkText, embedTexts } from './kb';

describe('chunkText', () => {
  it('returns the whole text as one chunk when short', () => {
    expect(chunkText('Our placement fee covers visa and medical.')).toEqual([
      'Our placement fee covers visa and medical.',
    ]);
  });

  it('returns [] for empty/whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n  ')).toEqual([]);
  });

  it('packs whole paragraphs and never splits one across chunks when it fits', () => {
    const p1 = 'A'.repeat(600);
    const p2 = 'B'.repeat(600);
    const p3 = 'C'.repeat(300);
    const chunks = chunkText(`${p1}\n\n${p2}\n\n${p3}`, { maxChars: 1000 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toBe(`${p2}\n\n${p3}`);
  });

  it('hard-splits an oversized paragraph with tail overlap', () => {
    const big = 'X'.repeat(2500);
    const chunks = chunkText(big, { maxChars: 1000, overlapChars: 150 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toHaveLength(1000);
    // Overlap: each subsequent chunk starts 150 chars before the
    // previous end, so total coverage = 1000 + 850 + 850 >= 2500.
    expect(chunks[1]).toHaveLength(1000);
    expect(chunks[2].length).toBeGreaterThan(0);
  });

  it('normalizes CRLF and trims chunks', () => {
    const chunks = chunkText('First paragraph.\r\n\r\nSecond paragraph.');
    expect(chunks).toEqual(['First paragraph.\n\nSecond paragraph.']);
  });
});

describe('embedTexts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null without an API key (text-only mode)', async () => {
    expect(await embedTexts(['hello'], undefined)).toBeNull();
  });

  it('returns [] for empty input without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await embedTexts([], 'sk-test')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns embeddings ordered by index', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0.2] },
          { index: 0, embedding: [0.1] },
        ],
      }),
    })));
    expect(await embedTexts(['a', 'b'], 'sk-test')).toEqual([[0.1], [0.2]]);
  });

  it('throws with the API error message on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Incorrect API key provided' } }),
    })));
    await expect(embedTexts(['a'], 'sk-bad')).rejects.toThrow('Incorrect API key provided');
  });
});

describe('chunkRowContent', () => {
  it('prefixes chunks with the document title as a header line', () => {
    expect(chunkRowContent('UAE — rules', 'At least 12 hours of rest per day.'))
      .toBe('[UAE — rules]\nAt least 12 hours of rest per day.');
  });

  it('passes content through when the title is blank', () => {
    expect(chunkRowContent('  ', 'Some chunk.')).toBe('Some chunk.');
  });
});
