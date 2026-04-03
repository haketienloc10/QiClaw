import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = {
      stream: streamMock
    };
  }
}));

import {
  createAnthropicProvider,
  extractAnthropicToolCalls,
  normalizeAnthropicResponseMetadata,
  readAnthropicTextContent
} from '../../src/provider/anthropic.js';

describe('normalizeAnthropicResponseMetadata', () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

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
          input_tokens: 120,
          output_tokens: 24,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 10
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

  it('streams text deltas, tool calls, usage, and final response from the SDK stream', async () => {
    const events = new Map<string, Array<(...args: any[]) => void>>();
    const finalMessage = {
      id: 'msg_stream_1',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 12,
        output_tokens: 7
      },
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 'toolu_stream_1', name: 'read_file', input: { path: 'note.txt' } }
      ]
    };

    streamMock.mockReturnValue({
      on(event: string, handler: (...args: any[]) => void) {
        const registered = events.get(event) ?? [];
        registered.push(handler);
        events.set(event, registered);
        return this;
      },
      async finalMessage() {
        for (const handler of events.get('text') ?? []) {
          handler('Hello', 'Hello');
          handler(' world', 'Hello world');
        }

        for (const handler of events.get('streamEvent') ?? []) {
          handler({ type: 'content_block_stop', content_block: { type: 'tool_use', id: 'toolu_stream_1', name: 'read_file', input: { path: 'note.txt' } } });
          handler({ type: 'message_delta', usage: { output_tokens: 7 } });
        }

        return finalMessage;
      }
    });

    const provider = createAnthropicProvider({
      model: 'claude-sonnet-4-6',
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
      { type: 'tool_call', toolCall: { id: 'toolu_stream_1', name: 'read_file', input: { path: 'note.txt' } } },
      { type: 'usage', usage: { inputTokens: undefined, outputTokens: 7, totalTokens: undefined } },
      {
        type: 'completed',
        response: {
          message: {
            role: 'assistant',
            content: 'Hello world',
            toolCalls: [
              { id: 'toolu_stream_1', name: 'read_file', input: { path: 'note.txt' } }
            ]
          },
          toolCalls: [
            { id: 'toolu_stream_1', name: 'read_file', input: { path: 'note.txt' } }
          ],
          finish: { stopReason: 'end_turn' },
          usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
          responseMetrics: {
            contentBlockCount: 2,
            toolCallCount: 1,
            hasTextOutput: true,
            contentBlocksByType: { text: 1, tool_use: 1 }
          },
          debug: {
            providerUsageRawRedacted: { input_tokens: 12, output_tokens: 7 },
            providerStopDetails: { stop_reason: 'end_turn' },
            toolCallSummaries: [{ id: 'toolu_stream_1', name: 'read_file' }],
            responseContentBlocksByType: { text: 1, tool_use: 1 },
            responsePreviewRedacted:
              '[{"text":"Hello world","type":"text"},{"id":"toolu_stream_1","input":{"path":"note.txt"},"name":"read_file","type":"tool_use"}]'
          }
        }
      }
    ]);
  });
});
