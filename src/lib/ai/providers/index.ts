import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { OpenRouterProvider } from './openrouter';
import { OllamaProvider } from './ollama';
import type { ChatProvider, ProviderInit } from './types';

export type ProviderId = ChatProvider['id'];

/**
 * Factory — resolves the saved `ai_provider_config` row into a
 * concrete provider. Called by every server route that needs an LLM.
 */
export function makeProvider(
  id: ProviderId,
  init: ProviderInit,
): ChatProvider {
  switch (id) {
    case 'openai':
      return new OpenAIProvider(init);
    case 'anthropic':
      return new AnthropicProvider(init);
    case 'openrouter':
      return new OpenRouterProvider(init);
    case 'ollama':
      return new OllamaProvider(init);
  }
}

export type { ChatProvider, ProviderInit } from './types';
export { ProviderError } from './types';
