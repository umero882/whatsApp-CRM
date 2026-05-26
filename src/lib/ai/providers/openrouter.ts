import type {
  ChatProvider,
  ChatCallOptions,
  ChatCallToolsOptions,
  ChatToolsResult,
  ProviderInit,
} from './types';
import { ProviderError } from './types';
import { openAIChatWithTools } from './openai';

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://github.com/umero882/whatsApp-CRM',
  'X-Title': 'wacrm',
};

/**
 * OpenRouter is wire-compatible with OpenAI's Chat Completions API.
 * Implemented as a standalone adapter (not a subclass of OpenAIProvider)
 * because TypeScript can't widen a readonly literal `id` field across
 * inheritance. The implementations are intentionally near-identical.
 */
export class OpenRouterProvider implements ChatProvider {
  readonly id = 'openrouter' as const;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(init: ProviderInit) {
    if (!init.apiKey) throw new ProviderError('OpenRouter requires an API key');
    this.model = init.model;
    this.apiKey = init.apiKey;
    this.baseUrl = (init.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  }

  async chat(opts: ChatCallOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...OPENROUTER_HEADERS,
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) throw new ProviderError(`OpenRouter ${res.status}`, res.status, raw);
    const json = JSON.parse(raw);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('OpenRouter returned no content', res.status, raw);
    }
    return content;
  }

  async chatWithTools(opts: ChatCallToolsOptions): Promise<ChatToolsResult> {
    return openAIChatWithTools(this.baseUrl, this.apiKey, this.model, opts, OPENROUTER_HEADERS);
  }

  async ping(): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    try {
      await this.chat({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
      });
      return { ok: true, model: this.model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
