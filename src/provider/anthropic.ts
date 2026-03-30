import type { ModelProvider, ProviderRequest, ProviderResponse } from './model.js';

export interface AnthropicProviderOptions {
  model: string;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  return {
    name: 'anthropic',
    model: options.model,
    async generate(_request: ProviderRequest): Promise<ProviderResponse> {
      return {
        message: {
          role: 'assistant',
          content: 'Anthropic provider stub: no live API call configured.'
        },
        toolCalls: []
      };
    }
  };
}
