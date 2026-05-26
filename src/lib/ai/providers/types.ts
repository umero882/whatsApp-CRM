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
   * Cheap connectivity / auth check. Should perform a minimal request
   * that fails on bad credentials. Used by the settings "Test" button.
   */
  ping(): Promise<{ ok: true; model: string } | { ok: false; error: string }>;
}

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
