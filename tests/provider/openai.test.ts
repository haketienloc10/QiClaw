import { beforeEach, describe, expect, it, vi } from 'vitest';

const responsesCreateMock = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    responses = {
      create: responsesCreateMock
    };
  }
}));

import {
  createOpenAIProvider,
  extractOpenAIToolCalls,
  normalizeOpenAIResponseMetadata,
  readOpenAITextContent
} from '../../src/provider/openai.js';

describe('normalizeOpenAIResponseMetadata', () => {
  beforeEach(() => {
    responsesCreateMock.mockReset();
  });

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
          input_tokens: 80,
          output_tokens: 20,
          total_tokens: 100
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

  it('streams response deltas, tool calls, usage, and final response from the Responses API stream', async () => {
    const finalResponse = {
      id: 'resp_stream_1',
      model: 'gpt-4.1',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }]
        },
        {
          type: 'function_call',
          call_id: 'call_stream_1',
          name: 'read_file',
          arguments: '{"path":"note.txt"}'
        }
      ],
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        total_tokens: 13
      },
      incomplete_details: null
    };

    responsesCreateMock.mockResolvedValue((async function* () {
      yield { type: 'response.output_text.delta', delta: 'Hello' };
      yield { type: 'response.output_text.delta', delta: ' world' };
      yield {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_stream_1',
          name: 'read_file',
          arguments: '{"path":"note.txt"}'
        }
      };
      yield {
        type: 'response.completed',
        response: finalResponse
      };
    })());

    const provider = createOpenAIProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key'
    });

    const received: unknown[] = [];
    const response = await provider.generateStream?.({
      messages: [{ role: 'user', content: 'Hello' }],
      availableTools: [
        {
          name: 'read_file',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          async execute() {
            return { content: 'ok' };
          }
        }
      ]
    }, (event) => {
      received.push(event);
    });

    expect(response).toBeDefined();
    expect(received).toEqual([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'tool_call', toolCall: { id: 'call_stream_1', name: 'read_file', input: { path: 'note.txt' } } },
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } },
      {
        type: 'completed',
        response: {
          message: {
            role: 'assistant',
            content: 'Hello world',
            toolCalls: [
              { id: 'call_stream_1', name: 'read_file', input: { path: 'note.txt' } }
            ]
          },
          toolCalls: [
            { id: 'call_stream_1', name: 'read_file', input: { path: 'note.txt' } }
          ],
          finish: { stopReason: undefined },
          usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          responseMetrics: {
            contentBlockCount: 2,
            toolCallCount: 1,
            hasTextOutput: true,
            contentBlocksByType: { message: 1, function_call: 1, output_text: 1 }
          },
          debug: {
            providerUsageRawRedacted: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
            providerStopDetails: undefined,
            toolCallSummaries: [{ id: 'call_stream_1', name: 'read_file' }],
            responseContentBlocksByType: { message: 1, function_call: 1, output_text: 1 },
            responsePreviewRedacted:
              '[{"content":[{"text":"Hello world","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{\\"path\\":\\"note.txt\\"}","call_id":"call_stream_1","name":"read_file","type":"function_call"}]'
          }
        }
      }
    ]);
  });
});
