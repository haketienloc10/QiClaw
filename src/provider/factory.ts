import { createAnthropicProvider } from './anthropic.js';
import type { ModelProvider, ResolvedProviderConfig } from './model.js';
import { createOpenAIProvider } from './openai.js';

export interface CreateProviderOptions extends ResolvedProviderConfig {}

export function createProvider(options: CreateProviderOptions): ModelProvider {
  switch (options.provider) {
    case 'anthropic':
      return createAnthropicProvider({ model: options.model, apiKey: options.apiKey, baseUrl: options.baseUrl });
    case 'openai':
      return createOpenAIProvider({ model: options.model, apiKey: options.apiKey, baseUrl: options.baseUrl });
    default:
      throw new Error(`Unknown provider: ${String(options.provider)}`);
  }
}
