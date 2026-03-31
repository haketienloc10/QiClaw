import { describe, expect, it } from 'vitest';

import {
  extractOpenAIToolCalls,
  normalizeOpenAIResponseMetadata,
  readOpenAITextContent
} from '../../src/provider/openai.js';

describe('normalizeOpenAIResponseMetadata', () => {
  it('normalizes finish, usage, response metrics, and debug metadata for Task 3', () => {
    const output = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'I will inspect it. Authorization: Bearer secret-token\napi_key=secret-key\ncookie: session=abc123'
          }
        ]
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"note.txt","authorization":"Bearer secret"}'
      }
    ];

    expect(normalizeOpenAIResponseMetadata({
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'incomplete',
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100
      },
      output,
      incomplete_details: {
        reason: 'max_output_tokens'
      }
    })).toEqual({
      finish: {
        stopReason: 'max_output_tokens'
      },
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100
      },
      responseMetrics: {
        contentBlockCount: 2,
        toolCallCount: 1,
        hasTextOutput: true,
        contentBlocksByType: {
          message: 1,
          function_call: 1,
          output_text: 1
        }
      },
      debug: {
        providerUsageRawRedacted: {
          input_tokens: '[REDACTED]',
          output_tokens: '[REDACTED]',
          total_tokens: '[REDACTED]'
        },
        providerStopDetails: {
          incomplete_details: {
            reason: 'max_output_tokens'
          }
        },
        toolCallSummaries: [
          {
            id: 'call_1',
            name: 'read_file'
          }
        ],
        responseContentBlocksByType: {
          message: 1,
          function_call: 1,
          output_text: 1
        },
        responsePreviewRedacted:
          '[{"content":[{"text":"I will inspect it. Authorization: [REDACTED]\\napi_key=[REDACTED]\\ncookie: [REDACTED]","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{\\"path\\":\\"note.txt\\",\\"authorization\\":\\"[REDACTED]\\"}","call_id":"call_1","name":"read_file","type":"function_call"}]'
      }
    });

    expect(readOpenAITextContent(output)).toBe(
      'I will inspect it. Authorization: Bearer secret-token\napi_key=secret-key\ncookie: session=abc123'
    );
    expect(extractOpenAIToolCalls(output)).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt', authorization: 'Bearer secret' }
      }
    ]);
  });
});
