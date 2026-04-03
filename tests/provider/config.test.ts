import { describe, expect, it } from 'vitest';

import {
  getDefaultModelForProvider,
  getModelCatalog,
  getProviderDisplayName,
  parseProviderId,
  resolveProviderConfig
} from '../../src/provider/config.js';

describe('provider config catalog', () => {
  it('returns a non-empty catalog for each supported provider', () => {
    const anthropicCatalog = getModelCatalog('anthropic');
    const openaiCatalog = getModelCatalog('openai');

    expect(anthropicCatalog.length).toBeGreaterThan(0);
    expect(openaiCatalog.length).toBeGreaterThan(0);
    expect(anthropicCatalog[0]?.provider).toBe('anthropic');
    expect(openaiCatalog[0]?.provider).toBe('openai');
  });

  it('includes the default model in each provider catalog', () => {
    expect(getModelCatalog('anthropic').some((model) => model.id === getDefaultModelForProvider('anthropic'))).toBe(true);
    expect(getModelCatalog('openai').some((model) => model.id === getDefaultModelForProvider('openai'))).toBe(true);
  });

  it('provides provider display names for TUI labels', () => {
    expect(getProviderDisplayName('anthropic')).toBe('Anthropic');
    expect(getProviderDisplayName('openai')).toBe('OpenAI');
  });

  it('still resolves provider config with explicit model override', () => {
    expect(resolveProviderConfig({
      provider: parseProviderId('openai'),
      model: 'gpt-4.1-mini'
    })).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1-mini'
    });
  });
});
