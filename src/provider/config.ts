import type { ProviderId, ResolvedProviderConfig } from './model.js';

const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-4.1'
};

export interface ResolveProviderConfigInput {
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function parseProviderId(value: string): ProviderId {
  if (value === 'anthropic' || value === 'openai') {
    return value;
  }

  throw new Error(`Unknown provider: ${value}`);
}

export function getDefaultModelForProvider(provider: ProviderId): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function resolveProviderConfig(input: ResolveProviderConfigInput): ResolvedProviderConfig {
  return {
    provider: input.provider,
    model: input.model ?? getProviderModelFromEnv(input.provider) ?? getDefaultModelForProvider(input.provider),
    baseUrl: input.baseUrl ?? getProviderBaseUrlFromEnv(input.provider),
    apiKey: input.apiKey ?? getProviderApiKeyFromEnv(input.provider)
  };
}

function getProviderModelFromEnv(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL;
    case 'openai':
      return process.env.OPENAI_MODEL;
    default:
      return undefined;
  }
}

function getProviderBaseUrlFromEnv(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_BASE_URL;
    case 'openai':
      return process.env.OPENAI_BASE_URL;
    default:
      return undefined;
  }
}

function getProviderApiKeyFromEnv(provider: ProviderId): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    default:
      return undefined;
  }
}
