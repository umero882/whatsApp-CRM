import type {
  ChatProvider,
  ChatCallOptions,
  ChatMessage,
  ProviderInit,
} from './types';
import { ProviderError } from './types';

/**
 * Anthropic differs from OpenAI in two ways the adapter normalizes:
 *   1. `system` is a top-level field, not a message role.
 *   2. Response has `content: [{ type:'text', text }]` not `choices`.
 */
export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(init: ProviderInit) {
    if (!init.apiKey) throw new ProviderError('Anthropic requires an API key');
    this.model = init.model;
    this.apiKey = init.apiKey;
    this.baseUrl = (init.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  }

  async chat(opts: ChatCallOptions): Promise<string> {
    const system = opts.messages.find((m) => m.role === 'system')?.content;
    const turns: ChatMessage[] = opts.messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.4,
      messages: turns,
    };
    if (system) body.system = system;

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) throw new ProviderError(`Anthropic ${res.status}`, res.status, raw);
    const json = JSON.parse(raw);
    const block = Array.isArray(json?.content)
      ? json.content.find((b: { type?: string; text?: string }) => b.type === 'text')
      : null;
    if (!block?.text) {
      throw new ProviderError('Anthropic returned no text block', res.status, raw);
    }
    return block.text as string;
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
