import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { makeProvider, ProviderError, type ProviderId } from './providers';

const MAX_HISTORY_MESSAGES = 12;
const MAX_SUGGESTIONS = 3;

/**
 * Default role prompt — used when the user hasn't customized
 * `ai_provider_config.system_prompt`. Anything role/voice/business
 * related goes here; the wire-format directive is appended
 * separately so the JSON envelope can't be lost by user edits.
 */
const DEFAULT_ROLE_PROMPT = `You are an expert customer-support agent replying in WhatsApp on behalf of a business.
Read the conversation and propose ${MAX_SUGGESTIONS} short, distinct replies the human agent could send next.

Rules:
- Match the language the customer is using.
- Each reply is 1-3 short sentences. WhatsApp tone: warm, concise, no fluff.
- No formal letter language. No "Dear Sir/Madam". No "I hope this message finds you well".
- Don't repeat what the customer just said. Move the conversation forward.
- If the customer asked a question, the first suggestion must answer it directly.
- Vary the angle across the three suggestions: e.g. (1) answer + ask clarifying question, (2) answer + offer next step, (3) shorter empathetic acknowledgement.`;

/**
 * Wire-format directive — ALWAYS appended to whatever role prompt
 * is active (default or user-customized). This is the server's
 * contract with the LLM and cannot be overridden by the user-facing
 * system prompt, otherwise the JSON parser explodes.
 */
const FORMAT_DIRECTIVE = `## OUTPUT FORMAT — STRICT
Return ONLY a single JSON object with this exact shape, no markdown fences, no prose before or after:
{"suggestions":["reply 1","reply 2","reply 3"]}
The array MUST contain exactly ${MAX_SUGGESTIONS} non-empty strings. Each string is the literal text the human agent would send to the customer — no labels, no numbering, no JSON inside the string.`;

export interface AIProviderRow {
  provider: ProviderId;
  model: string;
  base_url: string | null;
  encrypted_api_key: string | null;
  system_prompt: string | null;
  is_enabled: boolean;
}

export class DraftReplyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'no_provider'
      | 'provider_disabled'
      | 'no_conversation'
      | 'no_messages'
      | 'provider_failed'
      | 'bad_response',
  ) {
    super(message);
    this.name = 'DraftReplyError';
  }
}

export interface DraftReplyResult {
  suggestions: string[];
  model: string;
  provider: ProviderId;
}

/**
 * Generates 3 reply suggestions for the given conversation. Pulls the
 * caller's saved AI provider config (RLS-gated to that user) and the
 * last N messages from the conversation, asks the LLM, and parses
 * the JSON envelope back into a typed result.
 *
 * Throws DraftReplyError on any predictable failure so route handlers
 * can map cleanly to HTTP status codes.
 */
export async function draftReply(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<DraftReplyResult> {
  const { data: cfg, error: cfgErr } = await supabase
    .from('ai_provider_config')
    .select('provider, model, base_url, encrypted_api_key, system_prompt, is_enabled')
    .maybeSingle();
  if (cfgErr) throw cfgErr;
  if (!cfg) throw new DraftReplyError('No AI provider configured', 'no_provider');
  if (!cfg.is_enabled) throw new DraftReplyError('AI provider disabled', 'provider_disabled');

  const row = cfg as AIProviderRow;
  const apiKey = row.encrypted_api_key ? decrypt(row.encrypted_api_key) : undefined;
  const provider = makeProvider(row.provider, {
    model: row.model,
    apiKey,
    baseUrl: row.base_url ?? undefined,
  });

  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('id, contact:contacts ( name, phone )')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) throw new DraftReplyError('Conversation not found', 'no_conversation');

  const { data: msgs, error: msgErr } = await supabase
    .from('messages')
    .select('sender_type, content_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);
  if (msgErr) throw msgErr;
  if (!msgs || msgs.length === 0) {
    throw new DraftReplyError('No messages to draft from', 'no_messages');
  }

  const history = [...msgs].reverse();
  const contact = (conv as { contact?: { name?: string | null; phone?: string | null } | null }).contact;
  const contactLabel = contact?.name?.trim() || contact?.phone || 'customer';

  const transcript = history
    .map((m) => {
      const who = m.sender_type === 'customer' ? contactLabel : 'agent';
      const text = (m.content_text ?? '').trim();
      const body = text || `[${m.content_type}]`;
      return `${who}: ${body}`;
    })
    .join('\n');

  const rolePrompt = row.system_prompt?.trim() || DEFAULT_ROLE_PROMPT;
  const systemPrompt = `${rolePrompt}\n\n${FORMAT_DIRECTIVE}`;

  let rawText: string;
  try {
    rawText = await provider.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Conversation so far (oldest first):\n${transcript}\n\nRespond with the JSON object only.` },
      ],
      temperature: 0.5,
      maxTokens: 600,
      jsonMode: true,
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      throw new DraftReplyError(e.message, 'provider_failed');
    }
    throw e;
  }

  const suggestions = parseSuggestions(rawText);
  if (!suggestions.length) {
    // Log the raw output so we can diagnose without re-running. Trimmed
    // to 800 chars to keep logs sane.
    console.error(
      '[ai/draft-reply] parse failed. provider=%s model=%s raw=%s',
      row.provider,
      row.model,
      rawText.slice(0, 800),
    );
    throw new DraftReplyError('Provider returned no valid suggestions', 'bad_response');
  }

  return {
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    model: row.model,
    provider: row.provider,
  };
}

/**
 * Best-effort JSON parser. Models occasionally wrap the JSON in
 * markdown fences or add a sentence before/after; strip those and
 * try again before giving up.
 */
function parseSuggestions(text: string): string[] {
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Try direct parse first.
  for (const candidate of [stripped, trimmed]) {
    try {
      const json = JSON.parse(candidate);
      const arr = Array.isArray(json?.suggestions) ? json.suggestions : json;
      if (Array.isArray(arr)) {
        return arr
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter((s) => s.length > 0);
      }
    } catch {
      // fall through to extraction
    }
  }

  // Pull the first {...suggestions...} block out.
  const match = stripped.match(/\{[\s\S]*"suggestions"[\s\S]*\}/);
  if (match) {
    try {
      const json = JSON.parse(match[0]);
      if (Array.isArray(json?.suggestions)) {
        return json.suggestions
          .map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
          .filter((s: string) => s.length > 0);
      }
    } catch {
      // fall through
    }
  }

  // Final fallback: numbered/bulleted lines. Catches models that
  // ignore the JSON directive and emit "1. ... 2. ... 3. ..." prose.
  // Strips leading numbering, bullets, and surrounding quotes.
  const lines = stripped
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[*•\-]|\d+[.)])\s+/, '').trim())
    .map((l) => l.replace(/^["“'`]+|["”'`]+$/g, '').trim())
    .filter((l) => l.length > 0 && l.length < 600);
  if (lines.length >= 1) return lines.slice(0, 3);

  return [];
}
