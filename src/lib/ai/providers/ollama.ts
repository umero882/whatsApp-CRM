import type {
  ChatProvider,
  ChatCallOptions,
  ChatCallToolsOptions,
  ChatToolsResult,
  ProviderInit,
} from './types';
import { ProviderError } from './types';

/**
 * Ollama runs locally (default http://localhost:11434). No API key.
 * For container deployments, point baseUrl at host.docker.internal:11434
 * (the docker host's loopback) or a sidecar service.
 *
 * Uses Ollama's native /api/chat endpoint (non-streaming).
 */
export class OllamaProvider implements ChatProvider {
  readonly id = 'ollama' as const;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(init: ProviderInit) {
    this.model = init.model;
    this.baseUrl = (init.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  }

  async chat(opts: ChatCallOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: opts.messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.4,
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
      },
    };
    if (opts.jsonMode) body.format = 'json';

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const raw = await res.text();
    if (!res.ok) throw new ProviderError(`Ollama ${res.status}`, res.status, raw);
    const json = JSON.parse(raw);
    const content = json?.message?.content;
    if (typeof content !== 'string') {
      throw new ProviderError('Ollama returned no content', res.status, raw);
    }
    return content;
  }

  async chatWithTools(_opts: ChatCallToolsOptions): Promise<ChatToolsResult> {
    throw new ProviderError(
      'Tool calling via Ollama is not implemented yet. ' +
        'Use OpenAI / Anthropic / OpenRouter for the AI Agent for now, or open an issue if you have a tool-capable Ollama model you want supported (llama3.1+, qwen2.5+, mistral-nemo).',
    );
  }

  async ping(): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!res.ok) {
        return { ok: false, error: `Ollama ${res.status}` };
      }
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const found = json.models?.some((m) => m.name.startsWith(this.model));
      if (!found) {
        return {
          ok: false,
          error: `Model "${this.model}" not pulled. Run: ollama pull ${this.model}`,
        };
      }
      return { ok: true, model: this.model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
