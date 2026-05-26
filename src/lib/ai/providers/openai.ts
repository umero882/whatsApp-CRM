import type {
  ChatProvider,
  ChatCallOptions,
  ChatCallToolsOptions,
  ChatToolsResult,
  ProviderInit,
  ToolCall,
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

  async chatWithTools(opts: ChatCallToolsOptions): Promise<ChatToolsResult> {
    return openAIChatWithTools(this.baseUrl, this.apiKey, this.model, opts);
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

/**
 * Shared implementation of OpenAI's Chat Completions tools API.
 * Exported so OpenRouter (wire-compatible) can call it without
 * duplicating the request/response shaping.
 */
export async function openAIChatWithTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  opts: ChatCallToolsOptions,
  extraHeaders: Record<string, string> = {},
): Promise<ChatToolsResult> {
  // Translate our normalized AgentMessage shape to OpenAI's wire shape.
  const wireMessages = opts.messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.role === 'assistant' ? (m.content ?? '') : (m as { content: string }).content };
  });

  const body: Record<string, unknown> = {
    model,
    messages: wireMessages,
    temperature: opts.temperature ?? 0.3,
    tools: opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice: opts.forceToolUse ? 'required' : 'auto',
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) throw new ProviderError(`OpenAI ${res.status}`, res.status, raw);
  const json = JSON.parse(raw);
  const msg = json?.choices?.[0]?.message;
  if (!msg) throw new ProviderError('OpenAI returned no message', res.status, raw);

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const calls: ToolCall[] = msg.tool_calls.map((tc: {
      id: string;
      function: { name: string; arguments: string };
    }) => {
      let args: Record<string, unknown> = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { args = { _raw: tc.function?.arguments }; }
      return { id: tc.id, name: tc.function?.name, arguments: args };
    });
    return {
      kind: 'tool_calls',
      calls,
      rawAssistantText: typeof msg.content === 'string' ? msg.content : undefined,
    };
  }

  if (typeof msg.content === 'string') {
    return { kind: 'text', text: msg.content };
  }
  throw new ProviderError('OpenAI returned neither text nor tool calls', res.status, raw);
}
