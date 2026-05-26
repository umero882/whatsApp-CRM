import type {
  ChatProvider,
  ChatCallOptions,
  ProviderInit,
} from './types';
import { ProviderError } from './types';

export class OpenAIProvider implements ChatProvider {
  readonly id = 'openai' as const;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(init: ProviderInit) {
    if (!init.apiKey) throw new ProviderError('OpenAI requires an API key');
    this.model = init.model;
    this.apiKey = init.apiKey;
    this.baseUrl = (init.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
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
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) throw new ProviderError(`OpenAI ${res.status}`, res.status, raw);
    const json = JSON.parse(raw);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('OpenAI returned no content', res.status, raw);
    }
    return content;
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
