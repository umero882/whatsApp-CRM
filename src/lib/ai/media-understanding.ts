import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';

export type MediaKind = 'passport' | 'national_id' | 'selfie' | 'document' | 'voice' | 'other';

export interface MediaFields {
  first_name?: string; full_name?: string; nationality?: string;
  passport_number?: string; passport_expiry?: string; date_of_birth?: string;
}

export interface MediaUnderstanding {
  kind: MediaKind; summary: string; transcript?: string; language?: string;
  fields?: MediaFields; confidence: number;
}

export interface UnderstandMediaInput {
  mediaId: string;
  contentType: 'image' | 'audio' | 'document';
  mimeType: string | null;
  accessToken: string;
  openrouter: { apiKey: string; baseUrl?: string; model: string };
  openaiKey: string;
}

async function fetchBytes(mediaId: string, accessToken: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const info = await getMediaUrl({ mediaId, accessToken });
  const { buffer, contentType } = await downloadMedia({ downloadUrl: info.url, accessToken });
  return { buffer, mimeType: contentType || info.mimeType || 'application/octet-stream' };
}

export async function transcribeAudio(
  bytes: Buffer, mimeType: string, openaiKey: string,
): Promise<{ text: string; language?: string }> {
  const form = new FormData();
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'ogg';
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; language?: string };
  return { text: (json.text ?? '').trim(), language: json.language };
}

export async function understandMedia(input: UnderstandMediaInput): Promise<MediaUnderstanding> {
  if (input.contentType === 'audio') {
    const { buffer, mimeType } = await fetchBytes(input.mediaId, input.accessToken);
    const { text, language } = await transcribeAudio(buffer, mimeType, input.openaiKey);
    return {
      kind: 'voice',
      transcript: text,
      language,
      summary: text || '(unintelligible voice note)',
      confidence: text ? 0.9 : 0.2,
    };
  }
  // image / document handled in Task 3
  throw new Error(`understandMedia: unsupported contentType ${input.contentType} (not yet implemented)`);
}
