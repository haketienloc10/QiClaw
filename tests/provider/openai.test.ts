import { describe, expect, it } from 'vitest';

import { normalizeOpenAIResponseMetadata } from '../../src/provider/openai.js';

describe('normalizeOpenAIResponseMetadata', () => {
  it('normalizes OpenAI response usage and status into provider metadata', () => {
    expect(normalizeOpenAIResponseMetadata({
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'completed',
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100
      }
    })).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      requestId: 'resp_123',
      stopReason: 'completed',
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100
      }
    });
  });
});
