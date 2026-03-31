import { describe, expect, it } from 'vitest';

import { createProvider } from '../../src/provider/factory.js';
import { getDefaultModelForProvider, parseProviderId, resolveProviderConfig } from '../../src/provider/config.js';
import type { ProviderId } from '../../src/provider/model.js';

describe('createProvider', () => {
  it('throws for an unknown provider instead of falling back to OpenAI', () => {
    expect(() => createProvider({ provider: 'bedrock' as ProviderId, model: 'test-model' })).toThrow(
      'Unknown provider: bedrock'
    );
  });

  it('resolves provider config from env with provider-specific defaults and overrides', () => {
    const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
    const previousOpenAIApiKey = process.env.OPENAI_API_KEY;

    process.env.ANTHROPIC_BASE_URL = 'https://anthropic.example/v1';
    process.env.ANTHROPIC_API_KEY = 'anthropic-env-key';
    process.env.OPENAI_BASE_URL = 'https://openai.example/v1';
    process.env.OPENAI_API_KEY = 'openai-env-key';

    expect(parseProviderId('anthropic')).toBe('anthropic');
    expect(parseProviderId('openai')).toBe('openai');
    expect(() => parseProviderId('bedrock')).toThrow('Unknown provider: bedrock');
    expect(getDefaultModelForProvider('anthropic')).toBe('claude-opus-4-6');
    expect(getDefaultModelForProvider('openai')).toBe('gpt-4.1');

    expect(resolveProviderConfig({ provider: 'anthropic' })).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      baseUrl: 'https://anthropic.example/v1',
      apiKey: 'anthropic-env-key'
    });

    expect(resolveProviderConfig({ provider: 'openai' })).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://openai.example/v1',
      apiKey: 'openai-env-key'
    });

    expect(resolveProviderConfig({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://override.example/v1',
      apiKey: 'override-key'
    })).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://override.example/v1',
      apiKey: 'override-key'
    });

    if (previousAnthropicBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
    }

    if (previousAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }

    if (previousOpenAIBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousOpenAIBaseUrl;
    }

    if (previousOpenAIApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIApiKey;
    }
  });
});
