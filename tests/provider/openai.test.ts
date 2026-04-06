import { describe, expect, it } from 'vitest';

import {
  buildOpenAIResponsesRequest,
  extractOpenAIToolCalls,
  normalizeOpenAIResponseMetadata,
  readOpenAITextContent
} from '../../src/provider/openai.js';
import { searchTool } from '../../src/tools/search.js';

describe('buildOpenAIResponsesRequest', () => {
  it('includes the matching function call before a retained tool result after pruning', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: 'Calling read_file',
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              input: { path: 'note.txt' }
            }
          ]
        },
        {
          role: 'tool',
          content: 'note contents',
          name: 'read_file',
          toolCallId: 'call_1'
        },
        {
          role: 'assistant',
          content: 'Done reading.'
        }
      ],
      availableTools: []
    });

    expect(request.instructions).toBeUndefined();
    expect(request.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'Calling read_file'
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"note.txt"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'note contents'
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Done reading.'
      }
    ]);
  });

  it('keeps system instructions stable and places recalled memory at the start of input', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'Base system prompt\n\nLoaded skills' },
        { role: 'user', content: 'Mem:\n- stable recalled fact' },
        { role: 'user', content: 'Inspect note.txt' },
        { role: 'assistant', content: 'I will inspect it.' }
      ],
      availableTools: []
    });

    expect(request.instructions).toBe('Base system prompt\n\nLoaded skills');
    expect(request.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Mem:\n- stable recalled fact'
          }
        ]
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Inspect note.txt'
          }
        ]
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'I will inspect it.'
      }
    ]);
  });

  it('advertises optional smart search inputs without strict OpenAI schema mode', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [],
      availableTools: [searchTool]
    });

    expect(request.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'search',
        parameters: expect.objectContaining({
          properties: expect.objectContaining({
            pattern: { type: 'string' },
            contextLines: { type: 'number' },
            maxMatches: { type: 'number' },
            maxFiles: { type: 'number' }
          }),
          required: ['pattern']
        }),
        strict: false
      })
    ]);
  });
});

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
        total_tokens: 100,
        prompt_tokens_details: {
          cached_tokens: 48
        }
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
        totalTokens: 100,
        cacheReadInputTokens: 48
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
          input_tokens: 80,
          output_tokens: 20,
          total_tokens: 100,
          prompt_tokens_details: {
            cached_tokens: 48
          }
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
