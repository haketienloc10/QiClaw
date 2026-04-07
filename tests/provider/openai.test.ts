import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenAIResponsesRequest,
  createOpenAIProvider,
  extractOpenAIToolCalls,
  normalizeOpenAIResponseMetadata,
  readOpenAITextContent,
  toOpenAINormalizedEventsFromResponse
} from '../../src/provider/openai.js';
import { collectProviderStream, type NormalizedEvent } from '../../src/provider/model.js';
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

    expect(request.tools).toHaveLength(1);
    expect(request.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'search',
      parameters: {
        properties: {
          pattern: { type: 'string' },
          maxMatches: { type: 'number' },
          query: { type: 'string' },
          maxResults: { type: 'number' },
          includeContext: { type: 'boolean' }
        },
        required: []
      },
      strict: false
    });
  });

  it('builds the same OpenAI request payload for stream and non-stream modes except the stream flag', () => {
    const base = {
      model: 'gpt-4.1',
      messages: [
        { role: 'system' as const, content: 'System prompt' },
        { role: 'user' as const, content: 'Inspect note.txt' }
      ],
      availableTools: [searchTool]
    };

    const nonStream = buildOpenAIResponsesRequest(base);
    const stream = buildOpenAIResponsesRequest({ ...base, stream: true });

    expect(stream).toEqual({
      ...nonStream,
      stream: true
    });
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

describe('toOpenAINormalizedEventsFromResponse', () => {
  it('converts final OpenAI response payload into normalized events', () => {
    const response = {
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'completed',
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 48 }
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"note.txt"}'
        }
      ]
    };

    expect(toOpenAINormalizedEventsFromResponse(response)).toEqual([
      { type: 'start', provider: 'openai', model: 'gpt-4.1-mini' },
      { type: 'text_delta', text: 'Hello world' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'note.txt' } },
      {
        type: 'finish',
        finish: { stopReason: undefined },
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cacheReadInputTokens: 48 },
        responseMetrics: {
          contentBlockCount: 2,
          toolCallCount: 1,
          hasTextOutput: true,
          contentBlocksByType: { message: 1, function_call: 1, output_text: 1 }
        },
        debug: {
          providerUsageRawRedacted: {
            input_tokens: 80,
            output_tokens: 20,
            total_tokens: 100,
            prompt_tokens_details: { cached_tokens: 48 }
          },
          providerStopDetails: undefined,
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responseContentBlocksByType: { message: 1, function_call: 1, output_text: 1 },
          responsePreviewRedacted: expect.any(String)
        }
      }
    ]);
  });
});

describe('createOpenAIProvider', () => {
  it('emits tool_call before finish when function call output item is done', async () => {
    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"note.txt"}'
              }
            };
            yield {
              type: 'response.completed',
              response: {
                id: 'resp_123',
                model: 'gpt-4.1-mini',
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'read_file',
                    arguments: '{"path":"note.txt"}'
                  }
                ]
              }
            };
          })())
        }
      }) as unknown as OpenAI
    });

    const events: unknown[] = [];
    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'Inspect note.txt' }],
      availableTools: []
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'start', provider: 'openai', model: 'gpt-4.1-mini' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'note.txt' } },
      {
        type: 'finish',
        finish: { stopReason: undefined },
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          cacheReadInputTokens: undefined
        },
        responseMetrics: {
          contentBlockCount: 1,
          toolCallCount: 1,
          hasTextOutput: false,
          contentBlocksByType: { function_call: 1 }
        },
        debug: {
          providerUsageRawRedacted: undefined,
          providerStopDetails: undefined,
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responseContentBlocksByType: { function_call: 1 },
          responsePreviewRedacted: expect.any(String)
        }
      }
    ]);
  });

  it('fails when completed response disagrees with an early emitted tool call', async () => {
    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"note-a.txt"}'
              }
            };
            yield {
              type: 'response.completed',
              response: {
                id: 'resp_123',
                model: 'gpt-4.1-mini',
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'read_file',
                    arguments: '{"path":"note-b.txt"}'
                  }
                ]
              }
            };
          })())
        }
      }) as unknown as OpenAI
    });

    await expect(async () => {
      for await (const _event of provider.stream({
        messages: [{ role: 'user', content: 'Inspect note.txt' }],
        availableTools: []
      })) {
      }
    }).rejects.toThrow('OpenAI stream completed with mismatched tool_call for call_id call_1.');
  });

  it('ignores lifecycle events needed for REPL stream mode', async () => {
    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.queued' };
            yield { type: 'response.in_progress', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield { type: 'response.output_text.delta', delta: 'Hello world' };
            yield { type: 'response.output_text.done', text: 'Hello world' };
            yield {
              type: 'response.completed',
              response: {
                id: 'resp_123',
                model: 'gpt-4.1-mini',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Hello world' }]
                  }
                ]
              }
            };
          })())
        }
      }) as unknown as OpenAI
    });

    const events: unknown[] = [];
    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'Inspect note.txt' }],
      availableTools: []
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'start', provider: 'openai', model: 'gpt-4.1-mini' });
    expect(events[1]).toEqual({ type: 'text_delta', text: 'Hello world' });
    expect((events[2] as { type: string }).type).toBe('finish');
  });

  it('fails on unknown OpenAI response stream event types', async () => {
    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield { type: 'response.weird_event' };
          })())
        }
      }) as unknown as OpenAI
    });

    await expect(async () => {
      for await (const _event of provider.stream({
        messages: [{ role: 'user', content: 'Inspect note.txt' }],
        availableTools: []
      })) {
      }
    }).rejects.toThrow('Unsupported OpenAI response stream event: response.weird_event');
  });

  it('fails when OpenAI tool arguments are invalid JSON in the final response', () => {
    expect(() => toOpenAINormalizedEventsFromResponse({
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{bad json}'
        }
      ]
    })).toThrow('OpenAI function_call arguments for read_file must be valid JSON.');
  });

  it('emits start from completed response when response.created is missing', async () => {
    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield {
              type: 'response.completed',
              response: {
                id: 'resp_123',
                model: 'gpt-4.1-mini',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Hello world' }]
                  }
                ]
              }
            };
          })())
        }
      }) as unknown as OpenAI
    });

    const events: unknown[] = [];
    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'Inspect note.txt' }],
      availableTools: []
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'start', provider: 'openai', model: 'gpt-4.1-mini' });
    expect((events[1] as { type: string }).type).toBe('finish');
  });

  it('falls back to tool_call from completed response when no early tool_call event exists', async () => {
    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield {
              type: 'response.completed',
              response: {
                id: 'resp_123',
                model: 'gpt-4.1-mini',
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'read_file',
                    arguments: '{"path":"note.txt"}'
                  }
                ]
              }
            };
          })())
        }
      }) as unknown as OpenAI
    });

    const events: unknown[] = [];
    for await (const event of provider.stream({
      messages: [{ role: 'user', content: 'Inspect note.txt' }],
      availableTools: []
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'start', provider: 'openai', model: 'gpt-4.1-mini' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'note.txt' } },
      {
        type: 'finish',
        finish: { stopReason: undefined },
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          cacheReadInputTokens: undefined
        },
        responseMetrics: {
          contentBlockCount: 1,
          toolCallCount: 1,
          hasTextOutput: false,
          contentBlocksByType: { function_call: 1 }
        },
        debug: {
          providerUsageRawRedacted: undefined,
          providerStopDetails: undefined,
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responseContentBlocksByType: { function_call: 1 },
          responsePreviewRedacted: expect.any(String)
        }
      }
    ]);
  });

  it('keeps generate and stream in semantic parity for the same request', async () => {
    const finalResponse = {
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'completed',
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 48 }
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"note.txt"}'
        }
      ]
    };

    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield { type: 'response.output_text.delta', delta: 'Hello world' };
            yield {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_1',
              output_index: 1,
              call_id: 'call_1',
              name: 'read_file',
              arguments: '{"path":"note.txt"}'
            };
            yield { type: 'response.completed', response: finalResponse };
          })())
        }
      }) as unknown as OpenAI
    });

    const request = {
      messages: [{ role: 'user' as const, content: 'Inspect note.txt' }],
      availableTools: []
    };
    const collected = await collectProviderStream(provider.stream(request));
    const generated = await provider.generate(request);

    expect(collected).toEqual(generated);
  });
});

describe('collectProviderStream', () => {
  it('fails when text arrives before start', async () => {
    const stream = (async function* () {
      yield { type: 'text_delta', text: 'Hello' } as const;
      yield { type: 'finish', finish: { stopReason: 'stop' } } as const;
    })();

    await expect(collectProviderStream(stream)).rejects.toThrow(
      'Provider stream emitted text_delta before start event.'
    );
  });

  it('fails when stream finishes without a start event', async () => {
    const stream = (async function* () {
      yield { type: 'finish', finish: { stopReason: 'stop' } } as const;
    })();

    await expect(collectProviderStream(stream)).rejects.toThrow(
      'Provider stream ended without a start event.'
    );
  });

  it('fails when a tool call arrives before start', async () => {
    const stream = (async function* () {
      yield {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      } as const;
      yield { type: 'finish', finish: { stopReason: 'stop' } } as const;
    })();

    await expect(collectProviderStream(stream)).rejects.toThrow(
      'Provider stream emitted tool_call before start event.'
    );
  });

  it('fails when an event appears after finish', async () => {
    const stream = (async function* () {
      yield { type: 'start', provider: 'openai', model: 'gpt-4.1' } as const;
      yield { type: 'finish', finish: { stopReason: 'stop' } } as const;
      yield { type: 'text_delta', text: 'late' } as const;
    })();

    await expect(collectProviderStream(stream)).rejects.toThrow(
      'Provider stream emitted events after terminal event.'
    );
  });

  it('fails when start is emitted twice', async () => {
    const stream = (async function* () {
      yield { type: 'start', provider: 'openai', model: 'gpt-4.1' } as const;
      yield { type: 'start', provider: 'openai', model: 'gpt-4.1' } as const;
      yield { type: 'finish', finish: { stopReason: 'stop' } } as const;
    })();

    await expect(collectProviderStream(stream)).rejects.toThrow(
      'Provider stream emitted more than one start event.'
    );
  });

  it('assembles provider response from normalized events', async () => {
    const stream = (async function* (): AsyncIterable<NormalizedEvent> {
      yield { type: 'start', provider: 'openai', model: 'gpt-4.1' } as const;
      yield { type: 'text_delta', text: 'Hello' } as const;
      yield { type: 'text_delta', text: ' world' } as const;
      yield {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      } as const;
      yield {
        type: 'finish',
        finish: { stopReason: 'stop' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        responseMetrics: {
          contentBlockCount: 3,
          toolCallCount: 1,
          hasTextOutput: true,
          contentBlocksByType: { message: 1, function_call: 1, output_text: 2 }
        },
        debug: {
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responseContentBlocksByType: { message: 1, function_call: 1, output_text: 2 },
          responsePreviewRedacted: '[redacted]'
        }
      } as const;
    })();

    await expect(collectProviderStream(stream)).resolves.toEqual({
      message: {
        role: 'assistant',
        content: 'Hello world',
        toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'note.txt' } }]
      },
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'note.txt' } }],
      finish: { stopReason: 'stop' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      responseMetrics: {
        contentBlockCount: 3,
        toolCallCount: 1,
        hasTextOutput: true,
        contentBlocksByType: { message: 1, function_call: 1, output_text: 2 }
      },
      debug: {
        toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
        responseContentBlocksByType: { message: 1, function_call: 1, output_text: 2 },
        responsePreviewRedacted: '[redacted]'
      }
    });
  });

  it('overrides responseMetrics toolCallCount with deduped streamed tool calls', async () => {
    const stream = (async function* () {
      yield { type: 'start', provider: 'openai', model: 'gpt-4.1' } as const;
      yield {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      } as const;
      yield {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      } as const;
      yield {
        type: 'finish',
        finish: { stopReason: 'tool_use' },
        responseMetrics: {
          contentBlockCount: 1,
          toolCallCount: 2,
          hasTextOutput: false,
          contentBlocksByType: { function_call: 2 }
        }
      } as const;
    })();

    await expect(collectProviderStream(stream)).resolves.toMatchObject({
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'note.txt' } }],
      responseMetrics: {
        contentBlockCount: 1,
        toolCallCount: 1,
        hasTextOutput: false,
        contentBlocksByType: { function_call: 2 }
      }
    });
  });
});
