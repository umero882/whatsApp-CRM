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

const VISION_PROMPT = `You are an intake assistant for a domestic-worker recruitment agency.
Classify the attached image and, if it is an identity document, extract fields.
Reply with ONLY a JSON object, no prose, matching:
{"kind": "passport"|"national_id"|"selfie"|"document"|"other",
 "fields": {"first_name"?,"full_name"?,"nationality"? (country name in English),
            "passport_number"?,"passport_expiry"? (YYYY-MM-DD),"date_of_birth"? (YYYY-MM-DD)},
 "summary": "one short human sentence",
 "confidence": 0.0-1.0}
Only include fields you can read with high confidence. Omit unknown fields.`;

async function analyzeImage(
  bytes: Buffer, mimeType: string, openrouter: { apiKey: string; baseUrl?: string; model: string },
): Promise<MediaUnderstanding> {
  const dataUri = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const base = openrouter.baseUrl ?? 'https://openrouter.ai/api/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openrouter.apiKey}` },
    body: JSON.stringify({
      model: openrouter.model,
      temperature: 0,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content ?? '';
  return parseVision(raw);
}

function parseVision(raw: string): MediaUnderstanding {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const p = JSON.parse(match[0]) as Partial<MediaUnderstanding> & { fields?: MediaFields };
    const kind = (['passport', 'national_id', 'selfie', 'document', 'other'] as MediaKind[])
      .includes(p.kind as MediaKind) ? (p.kind as MediaKind) : 'other';
    const confidence = typeof p.confidence === 'number' ? p.confidence : 0.5;
    return {
      kind,
      fields: kind === 'passport' || kind === 'national_id' ? p.fields : undefined,
      summary: p.summary || 'received an image',
      confidence,
    };
  } catch {
    return { kind: 'other', summary: 'received an image (could not read details)', confidence: 0.3 };
  }
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
  const { buffer, mimeType } = await fetchBytes(input.mediaId, input.accessToken);
  return analyzeImage(buffer, mimeType, input.openrouter);
}
