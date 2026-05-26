/**
 * Unified LLM provider interface. Implementations live in
 * sibling files (openai.ts, anthropic.ts, openrouter.ts, ollama.ts).
 *
 * Why a thin adapter per provider rather than a heavy SDK dependency:
 * each cloud SDK pulls 5–20MB of transitive deps into the Next bundle,
 * and the only call shape we need is "given messages, return a string."
 * Plain fetch keeps the build small and self-host friendly.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCallOptions {
  messages: ChatMessage[];
  /** 0..2. Defaults to 0.4 for reply drafting (mildly creative). */
  temperature?: number;
  /** Hard cap on output tokens; provider clamps if higher than its limit. */
  maxTokens?: number;
  /** Force JSON-shaped output (provider-specific; best-effort). */
  jsonMode?: boolean;
}

export interface ChatProvider {
  /** Provider identifier — matches the `provider` enum in DB. */
  readonly id: 'openai' | 'anthropic' | 'openrouter' | 'ollama';
  /** Returns the raw assistant text (or JSON string if `jsonMode` set). */
  chat(opts: ChatCallOptions): Promise<string>;
  /**
   * Returns either a text reply or a list of tool calls the agent
   * runner must execute and feed back. Used by the autonomous reply
   * agent (`src/lib/ai/agent.ts`). Providers without tool support
   * throw `ProviderError` (e.g. Ollama with non-tool-capable model).
   */
  chatWithTools(opts: ChatCallToolsOptions): Promise<ChatToolsResult>;
  /**
   * Cheap connectivity / auth check. Should perform a minimal request
   * that fails on bad credentials. Used by the settings "Test" button.
   */
  ping(): Promise<{ ok: true; model: string } | { ok: false; error: string }>;
}

// ============================================================
// Tool-calling types
// ============================================================

/**
 * Definition of a single tool the LLM may call. Schema is
 * JSON-Schema (object). Each provider serializes this slightly
 * differently — the adapters handle that.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * One tool invocation in an assistant turn. `id` is the provider's
 * call id — must be echoed back on the corresponding tool-result
 * message so the LLM can pair them.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * What the runner sends back to the LLM for each tool call.
 */
export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  /** JSON-stringified result the LLM will read. */
  content: string;
}

/**
 * Extended message types accepted by chatWithTools — includes
 * assistant turns that *contained* tool calls and the tool-result
 * messages the runner produced.
 */
export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | ToolResultMessage;

export interface ChatCallToolsOptions {
  messages: AgentMessage[];
  tools: ToolSpec[];
  /** 0..2. Defaults to 0.3 for agentic flows (less creative). */
  temperature?: number;
  maxTokens?: number;
  /** Force the model to call exactly one tool — used for first turn nudge. */
  forceToolUse?: boolean;
}

export type ChatToolsResult =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; calls: ToolCall[]; rawAssistantText?: string };

export interface ProviderInit {
  model: string;
  /** Required for openai/anthropic/openrouter. Ignored by ollama. */
  apiKey?: string;
  /** Override for self-hosted endpoints or non-default routing. */
  baseUrl?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerBody?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
