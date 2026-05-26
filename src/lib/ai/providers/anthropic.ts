import type {
  ChatProvider,
  ChatCallOptions,
  ChatCallToolsOptions,
  ChatMessage,
  ChatToolsResult,
  ProviderInit,
  ToolCall,
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

  async chatWithTools(opts: ChatCallToolsOptions): Promise<ChatToolsResult> {
    const systemContent = opts.messages
      .filter((m) => m.role === 'system')
      .map((m) => (m as { content: string }).content)
      .join('\n\n');

    // Translate AgentMessage[] → Anthropic wire messages.
    const turns: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
    for (const m of opts.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        turns.push({ role: 'user', content: m.content });
      } else if (m.role === 'tool') {
        // Anthropic delivers tool results as a user-turn block array.
        turns.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ],
        });
      } else if (m.role === 'assistant') {
        if (m.tool_calls?.length) {
          const blocks: Array<Record<string, unknown>> = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.tool_calls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
          turns.push({ role: 'assistant', content: blocks });
        } else {
          turns.push({ role: 'assistant', content: m.content ?? '' });
        }
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.3,
      messages: turns,
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      tool_choice: opts.forceToolUse ? { type: 'any' } : { type: 'auto' },
    };
    if (systemContent) body.system = systemContent;

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
    const blocks = Array.isArray(json?.content) ? json.content : [];

    const calls: ToolCall[] = blocks
      .filter((b: { type: string }) => b.type === 'tool_use')
      .map((b: { id: string; name: string; input: Record<string, unknown> }) => ({
        id: b.id,
        name: b.name,
        arguments: b.input ?? {},
      }));

    if (calls.length > 0) {
      const text = blocks
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n');
      return { kind: 'tool_calls', calls, rawAssistantText: text || undefined };
    }

    const textBlock = blocks.find((b: { type: string; text?: string }) => b.type === 'text');
    if (textBlock?.text) return { kind: 'text', text: textBlock.text };

    throw new ProviderError('Anthropic returned no text or tool_use', res.status, raw);
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
