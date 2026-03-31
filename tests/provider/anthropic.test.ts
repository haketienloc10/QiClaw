import { describe, expect, it } from 'vitest';

import { normalizeAnthropicResponseMetadata } from '../../src/provider/anthropic.js';

describe('normalizeAnthropicResponseMetadata', () => {
  it('normalizes Anthropic usage counters and stop reason into provider metadata', () => {
    expect(normalizeAnthropicResponseMetadata({
      id: 'msg_123',
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 120,
        output_tokens: 24,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 10
      }
    })).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      requestId: 'msg_123',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 120,
        outputTokens: 24,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 10,
        totalTokens: 144
      }
    });
  });
});
