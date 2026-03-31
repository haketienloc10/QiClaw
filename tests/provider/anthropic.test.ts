import { describe, expect, it } from 'vitest';

import {
  extractAnthropicToolCalls,
  normalizeAnthropicResponseMetadata,
  readAnthropicTextContent
} from '../../src/provider/anthropic.js';

describe('normalizeAnthropicResponseMetadata', () => {
  it('normalizes finish, usage, response metrics, and debug metadata for Task 3', () => {
    const content = [
      {
        type: 'text',
        text: 'I will inspect it. Authorization: Bearer secret-token\napi_key=secret-key\ncookie: session=abc123'
      },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'note.txt', apiKey: 'secret-key' } }
    ];

    expect(normalizeAnthropicResponseMetadata({
      id: 'msg_123',
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 120,
        output_tokens: 24,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 10
      },
      content
    })).toEqual({
      finish: {
        stopReason: 'tool_use'
      },
      usage: {
        inputTokens: 120,
        outputTokens: 24,
        totalTokens: 144
      },
      responseMetrics: {
        contentBlockCount: 2,
        toolCallCount: 1,
        hasTextOutput: true,
        contentBlocksByType: {
          text: 1,
          tool_use: 1
        }
      },
      debug: {
        providerUsageRawRedacted: {
          input_tokens: '[REDACTED]',
          output_tokens: '[REDACTED]',
          cache_creation_input_tokens: '[REDACTED]',
          cache_read_input_tokens: '[REDACTED]'
        },
        providerStopDetails: {
          stop_reason: 'tool_use'
        },
        toolCallSummaries: [
          {
            id: 'toolu_1',
            name: 'read_file'
          }
        ],
        responseContentBlocksByType: {
          text: 1,
          tool_use: 1
        },
        responsePreviewRedacted:
          '[{"text":"I will inspect it. Authorization: [REDACTED]\\napi_key=[REDACTED]\\ncookie: [REDACTED]","type":"text"},{"id":"toolu_1","input":{"apiKey":"[REDACTED]","path":"note.txt"},"name":"read_file","type":"tool_use"}]'
      }
    });

    expect(readAnthropicTextContent(content)).toBe(
      'I will inspect it. Authorization: Bearer secret-token\napi_key=secret-key\ncookie: session=abc123'
    );
    expect(extractAnthropicToolCalls(content)).toEqual([
      {
        id: 'toolu_1',
        name: 'read_file',
        input: { path: 'note.txt', apiKey: 'secret-key' }
      }
    ]);
  });
});
