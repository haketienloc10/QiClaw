import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchToolCall } from '../../src/agent/dispatcher.js';
import { defaultAgentSpec } from '../../src/agent/defaultAgentSpec.js';
import { runAgentTurn } from '../../src/agent/loop.js';
import { readonlyAgentSpec } from '../../src/agent/presets/readonlyAgentSpec.js';
import { createAgentRuntime } from '../../src/agent/runtime.js';
import { createInMemoryMetricsObserver } from '../../src/telemetry/metrics.js';
import {
  buildAnthropicMessagesRequest,
  createAnthropicProvider,
  extractAnthropicToolCalls,
  getAnthropicApiKey,
  normalizeAnthropicResponseMetadata,
  readAnthropicTextContent
} from '../../src/provider/anthropic.js';
import { createProvider } from '../../src/provider/factory.js';
import {
  buildOpenAIResponsesRequest,
  createOpenAIProvider,
  extractOpenAIToolCalls,
  getOpenAIApiKey,
  readOpenAITextContent,
  normalizeOpenAIResponseMetadata
} from '../../src/provider/openai.js';
import {
  normalizeProviderResponse,
  type ModelProvider,
  type ProviderResponse,
  type ToolCallRequest
} from '../../src/provider/model.js';
import { createTelemetryEvent, type TelemetryEvent } from '../../src/telemetry/observer.js';
import { editFileTool } from '../../src/tools/editFile.js';
import { getBuiltinToolNames, getBuiltinTools, getTool, hasTool, type Tool, type ToolContext } from '../../src/tools/registry.js';
import { readFileTool } from '../../src/tools/readFile.js';
import { searchTool } from '../../src/tools/search.js';
import * as shellToolModule from '../../src/tools/shell.js';
import { shellExecTool, shellReadonlyTool } from '../../src/tools/shell.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('telemetry typing', () => {
  it('requires payloads for events whose contracts need data', () => {
    // @ts-expect-error provider_called requires telemetry payload data
    createTelemetryEvent('provider_called');
    // @ts-expect-error provider_responded requires telemetry payload data
    createTelemetryEvent('provider_responded');
  });

  it('accepts payloads for required-data events', () => {
    const providerCalledEvent = createTelemetryEvent('provider_called', 'provider_decision', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 0,
      messageCount: 1,
      promptRawChars: 1,
      toolNames: [],
      messageSummaries: [],
      totalContentBlockCount: 0,
      hasSystemPrompt: false,
      promptRawPreviewRedacted: '{}'
    });
    const providerRespondedEvent = createTelemetryEvent('provider_responded', 'provider_decision', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 0,
      responseContentBlockCount: 0,
      toolCallCount: 0,
      hasTextOutput: false,
      durationMs: 0
    });

    expect(providerCalledEvent.data.messageCount).toBe(1);
    expect(providerRespondedEvent.data.toolCallCount).toBe(0);
  });

  it('narrows telemetry payloads from event.type without helper casts', () => {
    const event: TelemetryEvent = createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'json_tool',
      toolCallId: 'call-json-telemetry',
      isError: false,
      resultPreview: '{}',
      resultRawRedacted: {},
      durationMs: 0,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    });

    if (event.type !== 'tool_call_completed') {
      throw new Error('expected tool_call_completed event');
    }

    expect(event.data.toolName).toBe('json_tool');
    expect(event.data.resultRawRedacted).toEqual({});
  });
});

describe('tool registry', () => {
  it('registers the built-in tool names in a stable order', () => {
    expect(getBuiltinToolNames()).toEqual(['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec']);
  });

  it('supports tool lookup by name', () => {
    expect(hasTool('read_file')).toBe(true);
    expect(hasTool('edit_file')).toBe(true);
    expect(hasTool('search')).toBe(true);
    expect(hasTool('shell_readonly')).toBe(true);
    expect(hasTool('shell_exec')).toBe(true);
    expect(hasTool('missing_tool')).toBe(false);

    expect(getTool('missing_tool')).toBeUndefined();
  });

  it('returns tool contracts with handlers for each built-in tool', () => {
    const toolNames = getBuiltinToolNames();

    for (const name of toolNames) {
      const tool = getTool(name);

      expect(tool).toBeDefined();
      expect(tool?.name).toBe(name);
      expect(tool?.description).toBeTypeOf('string');
      expect(tool?.inputSchema).toBeDefined();
      expect(tool?.execute).toBeTypeOf('function');
    }
  });
});

describe('tool contract', () => {
  it('lets a tool return structured text output', async () => {
    const calls: Array<{ cwd: string; input: { value: string } }> = [];
    const context: ToolContext = {
      cwd: '/tmp/worktree'
    };

    const tool: Tool<{ value: string }> = {
      name: 'demo_tool',
      description: 'Returns the provided value',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value'],
        additionalProperties: false
      },
      async execute(input, runtimeContext) {
        calls.push({ cwd: runtimeContext.cwd, input });

        return {
          content: `value=${input.value}`,
          data: { echoedValue: input.value }
        };
      }
    };

    const result = await tool.execute({ value: 'ok' }, context);

    expect(calls).toEqual([
      {
        cwd: '/tmp/worktree',
        input: { value: 'ok' }
      }
    ]);
    expect(result).toEqual({
      content: 'value=ok',
      data: { echoedValue: 'ok' }
    });
  });
});

describe('provider normalization, provider, and dispatcher', () => {
  it('keeps assistant text in message.content while returning tool calls separately', () => {
    expect(
      normalizeProviderResponse({
        content: 'I will inspect the file first.',
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      })
    ).toEqual({
      message: {
        role: 'assistant',
        content: 'I will inspect the file first.',
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      toolCalls: [
        {
          id: 'call-read-1',
          name: 'read_file',
          input: { path: 'note.txt' }
        }
      ]
    } satisfies ProviderResponse);
  });

  it('uses an empty message.content only when the vendor returned no text', () => {
    expect(
      normalizeProviderResponse({
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      })
    ).toEqual({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      toolCalls: [
        {
          id: 'call-read-1',
          name: 'read_file',
          input: { path: 'note.txt' }
        }
      ]
    } satisfies ProviderResponse);
  });

  it('reads Anthropic API key from override first, then environment, and errors when missing', () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => getAnthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/i);
    expect(getAnthropicApiKey('anthropic-override-key')).toBe('anthropic-override-key');

    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';
    expect(getAnthropicApiKey()).toBe('anthropic-test-key');

    if (previous === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('reads OpenAI API key from override first, then environment, and errors when missing', () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    expect(() => getOpenAIApiKey()).toThrow(/OPENAI_API_KEY/i);
    expect(getOpenAIApiKey('openai-override-key')).toBe('openai-override-key');

    process.env.OPENAI_API_KEY = 'openai-test-key';
    expect(getOpenAIApiKey()).toBe('openai-test-key');

    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  });

  it('builds an Anthropic messages request from system, conversation, and tools', () => {
    const request = buildAnthropicMessagesRequest({
      model: 'claude-opus-4-6',
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Inspect note.txt' },
        { role: 'assistant', content: 'I will inspect it.' },
        {
          role: 'tool',
          name: 'read_file',
          toolCallId: 'toolu_123',
          content: 'note contents',
          isError: false
        }
      ],
      availableTools: getBuiltinTools()
    });

    expect(request.system).toBe('System prompt');
    expect(request.messages).toEqual([
      { role: 'user', content: 'Inspect note.txt' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: 'note contents',
            is_error: false
          }
        ]
      }
    ]);
    expect(request.tools?.map((tool) => tool.name)).toEqual(['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec']);
  });

  it('rejects Anthropic tool messages without a toolCallId', () => {
    expect(() => buildAnthropicMessagesRequest({
      model: 'claude-opus-4-6',
      messages: [
        { role: 'user', content: 'Inspect note.txt' },
        {
          role: 'tool',
          name: 'read_file',
          content: 'note contents',
          isError: false
        }
      ],
      availableTools: getBuiltinTools()
    })).toThrow(/Tool message for read_file is missing toolCallId\./);
  });

  it('extracts Anthropic text content and tool calls from mixed content blocks', () => {
    const text = readAnthropicTextContent([
      { type: 'text', text: 'I will inspect the file.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'note.txt' } },
      { type: 'text', text: ' Then I will summarize it.' }
    ]);

    const toolCalls = extractAnthropicToolCalls([
      { type: 'text', text: 'ignore me' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'note.txt' } }
    ]);

    expect(text).toBe('I will inspect the file. Then I will summarize it.');
    expect(toolCalls).toEqual([
      {
        id: 'toolu_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      }
    ]);
  });

  it('includes prior Anthropic tool_use blocks before tool_result messages', () => {
    const request = buildAnthropicMessagesRequest({
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Inspect note.txt' },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [
            {
              id: 'toolu_123',
              name: 'read_file',
              input: { path: 'note.txt' }
            }
          ]
        } as any,
        {
          role: 'tool',
          name: 'read_file',
          toolCallId: 'toolu_123',
          content: 'note contents',
          isError: false
        }
      ],
      availableTools: getBuiltinTools()
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'Inspect note.txt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'toolu_123', name: 'read_file', input: { path: 'note.txt' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: 'note contents',
            is_error: false
          }
        ]
      }
    ]);
  });

  it('builds an OpenAI responses request from system, conversation, and tools', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Inspect note.txt' },
        { role: 'assistant', content: 'I will inspect it.' },
        {
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call_123',
          content: 'note contents',
          isError: true
        }
      ],
      availableTools: getBuiltinTools()
    });

    expect(request.instructions).toBe('System prompt');
    expect(request.input).toEqual([
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
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'note contents'
      }
    ]);
    expect(request.tools).toHaveLength(5);
    expect(request.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
      strict: false
    });
  });

  it('does not mark OpenAI tools with optional properties as strict schemas', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Run ls' }],
      availableTools: [shellExecTool]
    });

    expect(request.tools).toEqual([
      {
        type: 'function',
        name: 'shell_exec',
        description: 'Run a single program with optional arguments inside the current working directory.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            args: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['command'],
          additionalProperties: false
        },
        strict: false
      }
    ]);
  });

  it('includes prior OpenAI function_call items before function_call_output messages', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Inspect note.txt' },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [
            {
              id: 'call_123',
              name: 'read_file',
              input: { path: 'note.txt' }
            }
          ]
        } as any,
        {
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call_123',
          content: 'note contents',
          isError: false
        }
      ],
      availableTools: getBuiltinTools()
    });

    expect(request.input).toEqual([
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
      },
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'read_file',
        arguments: '{"path":"note.txt"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'note contents'
      }
    ]);
  });

  it('rejects OpenAI tool messages without a toolCallId', () => {
    expect(() => buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [
        { role: 'user', content: 'Inspect note.txt' },
        {
          role: 'tool',
          name: 'read_file',
          content: 'note contents',
          isError: false
        }
      ],
      availableTools: getBuiltinTools()
    })).toThrow(/Tool message for read_file is missing toolCallId\./);
  });

  it('extracts OpenAI text content and tool calls from responses output items', () => {
    const text = readOpenAITextContent([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'I will inspect the file.', annotations: [] },
          { type: 'output_text', text: ' Then I will summarize it.', annotations: [] }
        ]
      }
    ]);

    const toolCalls = extractOpenAIToolCalls([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"note.txt"}'
      },
      {
        type: 'function_call',
        call_id: 'call_2',
        name: 'search',
        arguments: '{"pattern":"needle"}'
      }
    ]);

    expect(text).toBe('I will inspect the file. Then I will summarize it.');
    expect(toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      },
      {
        id: 'call_2',
        name: 'search',
        input: { pattern: 'needle' }
      }
    ]);
  });

  it('rejects invalid OpenAI function_call.arguments JSON', () => {
    expect(() => extractOpenAIToolCalls([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"note.txt"'
      }
    ])).toThrow(/OpenAI function_call arguments for read_file must be valid JSON\./);
  });

  it('rejects OpenAI function_call.arguments JSON that does not parse to an object', () => {
    expect(() => extractOpenAIToolCalls([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '[]'
      }
    ])).toThrow(/OpenAI function_call arguments for read_file must parse to a non-null object\./);
  });

  it('creates the requested provider implementation from the provider factory', () => {
    const anthropicProvider = createProvider({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      baseUrl: 'https://anthropic.example/v1',
      apiKey: 'anthropic-cli-key'
    });
    const openaiProvider = createProvider({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://openai.example/v1',
      apiKey: 'openai-cli-key'
    });

    expect(anthropicProvider.name).toBe('anthropic');
    expect(anthropicProvider.model).toBe('claude-opus-4-6');
    expect(openaiProvider.name).toBe('openai');
    expect(openaiProvider.model).toBe('gpt-4.1');
  });

  it('dispatches a successful tool call into a normalized tool result message', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-success-'));
    await writeFile(join(workspace, 'note.txt'), 'hello dispatcher', 'utf8');

    const toolCall: ToolCallRequest = {
      id: 'call-read-1',
      name: 'read_file',
      input: { path: 'note.txt' }
    };

    await expect(dispatchToolCall(toolCall, { cwd: workspace })).resolves.toEqual({
      role: 'tool',
      name: 'read_file',
      toolCallId: 'call-read-1',
      content: 'hello dispatcher',
      isError: false
    });
  });

  it('returns a tool error when dispatcher input fails schema validation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-invalid-input-'));

    await expect(
      dispatchToolCall(
        {
          id: 'call-read-invalid',
          name: 'read_file',
          input: { path: 'note.txt', extra: true }
        },
        { cwd: workspace }
      )
    ).resolves.toEqual({
      role: 'tool',
      name: 'read_file',
      toolCallId: 'call-read-invalid',
      content: expect.stringMatching(/unexpected property/i),
      isError: true
    });
  });

  it('serializes structured tool results into tool messages', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-structured-result-'));
    const toolCall: ToolCallRequest = {
      id: 'call-shell-structured',
      name: 'shell_exec',
      input: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("out"); process.stderr.write("err");']
      }
    };

    await expect(dispatchToolCall(toolCall, { cwd: workspace })).resolves.toEqual({
      role: 'tool',
      name: 'shell_exec',
      toolCallId: 'call-shell-structured',
      content: JSON.stringify({
        content: 'outerr',
        data: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
          stdout: 'out',
          stderr: 'err',
          exitCode: 0
        }
      }),
      isError: false
    });
  });

  it('normalizes missing tools as dispatcher errors instead of throwing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-missing-tool-'));

    await expect(
      dispatchToolCall(
        {
          id: 'call-missing-1',
          name: 'missing_tool',
          input: {}
        },
        { cwd: workspace }
      )
    ).resolves.toEqual({
      role: 'tool',
      name: 'missing_tool',
      toolCallId: 'call-missing-1',
      content: 'Tool not found: missing_tool',
      isError: true
    });
  });

  it('normalizes tool execution failures into tool error messages', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-tool-error-'));

    await expect(
      dispatchToolCall(
        {
          id: 'call-read-missing-file',
          name: 'read_file',
          input: { path: 'missing.txt' }
        },
        { cwd: workspace }
      )
    ).resolves.toEqual({
      role: 'tool',
      name: 'read_file',
      toolCallId: 'call-read-missing-file',
      content: expect.stringMatching(/missing\.txt/i),
      isError: true
    });
  });
});

describe('agent loop', () => {
  it('runs a tool loop until the provider returns a final answer', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-success-'));
    await writeFile(join(workspace, 'note.txt'), 'agent note', 'utf8');

    const calls: Array<{ messages: string[]; availableToolNames: string[] }> = [];
    const provider = createScriptedProviderWithMetadata([
      {
        message: { role: 'assistant', content: 'I will read the file first.' },
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'The note says: agent note' },
        toolCalls: []
      }
    ], calls);

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Read note.txt and summarize it.',
      cwd: workspace,
      maxToolRounds: 3
    });

    expect(result.stopReason).toBe('completed');
    expect(result.finalAnswer).toBe('The note says: agent note');
    expect(result.toolRoundsUsed).toBe(1);
    expect(result.verification.isVerified).toBe(true);
    expect(result.history).toEqual([
      { role: 'user', content: 'Read note.txt and summarize it.' },
      { role: 'assistant', content: 'I will read the file first.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-read-1',
        content: 'agent note',
        isError: false
      },
      { role: 'assistant', content: 'The note says: agent note' }
    ]);
    expect(calls).toEqual([
      {
        messages: ['system:You are helpful.', 'user:Read note.txt and summarize it.'],
        availableToolNames: ['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec']
      },
      {
        messages: [
          'system:You are helpful.',
          'user:Read note.txt and summarize it.',
          'assistant:I will read the file first.',
          'tool:agent note'
        ],
        availableToolNames: ['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec']
      }
    ]);
  });

  it('preserves user -> assistant tool call -> tool result -> assistant final answer order', async () => {
    const provider = createScriptedProvider([
      {
        message: {
          role: 'assistant',
          content: 'I will inspect package.json.',
          toolCalls: [
            {
              id: 'tool_read_1',
              name: 'Read',
              input: { file_path: '/tmp/package.json' }
            }
          ]
        },
        toolCalls: [
          {
            id: 'tool_read_1',
            name: 'Read',
            input: { file_path: '/tmp/package.json' }
          }
        ]
      },
      {
        message: {
          role: 'assistant',
          content: 'package.json shows version 1.2.3.'
        },
        toolCalls: []
      }
    ]);

    const result = await runAgentTurn({
      provider,
      availableTools: [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: { type: 'string' }
            },
            required: ['file_path'],
            additionalProperties: false
          },
          async execute() {
            return { content: '{"version":"1.2.3"}' };
          }
        }
      ],
      baseSystemPrompt: 'Base system prompt',
      userInput: 'show me the package version',
      cwd: '/tmp',
      maxToolRounds: 2
    });

    expect(result.history).toEqual([
      { role: 'user', content: 'show me the package version' },
      {
        role: 'assistant',
        content: 'I will inspect package.json.',
        toolCalls: [
          {
            id: 'tool_read_1',
            name: 'Read',
            input: { file_path: '/tmp/package.json' }
          }
        ]
      },
      {
        role: 'tool',
        name: 'Read',
        toolCallId: 'tool_read_1',
        content: '{"version":"1.2.3"}',
        isError: false
      },
      { role: 'assistant', content: 'package.json shows version 1.2.3.' }
    ]);
    expect(result.history.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('includes prompt assembly context when optional prompt inputs are provided', async () => {
    const seenRequests: string[][] = [];
    const provider = createScriptedProvider(
      [
        {
          message: { role: 'assistant', content: 'Done.' },
          toolCalls: []
        }
      ],
      seenRequests
    );

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'Base prompt',
      userInput: 'Answer briefly.',
      cwd: '/tmp/runtime',
      maxToolRounds: 1,
      memoryText: 'Memory: user prefers concise answers',
      skillsText: 'Skills: concise_response',
      historySummary: 'Summary: prior attempt failed',
      history: [{ role: 'assistant', content: 'Earlier answer.' }]
    });

    expect(result.history).toEqual([
      { role: 'assistant', content: 'Earlier answer.' },
      { role: 'user', content: 'Answer briefly.' },
      { role: 'assistant', content: 'Done.' }
    ]);
    expect(seenRequests).toEqual([
      [
        'system:Base prompt\n\nSkills: concise_response\n\nSummary: prior attempt failed',
        'user:Memory: user prefers concise answers',
        'assistant:Earlier answer.',
        'user:Answer briefly.'
      ]
    ]);
  });

  it('accepts AgentSpec completion metadata without changing the current loop happy path', async () => {
    const calls: string[][] = [];
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'Done.' },
        toolCalls: []
      }
    ], calls);

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'Spec prompt',
      userInput: 'Answer briefly.',
      cwd: '/tmp/runtime',
      maxToolRounds: defaultAgentSpec.completion.maxToolRounds,
      agentSpec: defaultAgentSpec
    });

    expect(result.doneCriteria.completionMode).toBe(defaultAgentSpec.completion.completionMode);
    expect(result.doneCriteria.doneCriteriaShape).toBe(defaultAgentSpec.completion.doneCriteriaShape);
    expect(result.doneCriteria.evidenceRequirement).toBe(defaultAgentSpec.completion.evidenceRequirement);
    expect(result.doneCriteria.stopVsDoneDistinction).toBe(defaultAgentSpec.completion.stopVsDoneDistinction);
    expect(calls).toEqual([['system:Spec prompt', 'user:Answer briefly.']]);
    expect(result.verification.isVerified).toBe(false);
    expect(result.verification.finalAnswerIsSubstantive).toBe(false);
  });

  it('blocks a non-allowed tool before dispatcher lookup and does not count the error as inspection evidence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-missing-tool-'));
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will call a tool.' },
        toolCalls: [
          {
            id: 'call-missing-1',
            name: 'missing_tool',
            input: {}
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'The tool failed because it does not exist.' },
        toolCalls: []
      }
    ]);

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Check the repo and explain what happened.',
      cwd: workspace,
      maxToolRounds: 2
    });

    expect(result.stopReason).toBe('completed');
    expect(result.history).toEqual([
      { role: 'user', content: 'Check the repo and explain what happened.' },
      { role: 'assistant', content: 'I will call a tool.' },
      {
        role: 'tool',
        name: 'missing_tool',
        toolCallId: 'call-missing-1',
        content: 'Tool not allowed for this turn: missing_tool',
        isError: true
      },
      { role: 'assistant', content: 'The tool failed because it does not exist.' }
    ]);
    expect(result.verification.isVerified).toBe(false);
    expect(result.verification.toolMessagesCount).toBe(0);
  });

  it('returns a deterministic max-rounds stop result when the provider keeps requesting tools', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-max-rounds-'));
    await writeFile(join(workspace, 'note.txt'), 'agent note', 'utf8');

    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'Round 1' },
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Round 2' },
        toolCalls: [
          {
            id: 'call-read-2',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      }
    ]);

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Read note.txt carefully.',
      cwd: workspace,
      maxToolRounds: 1
    });

    expect(result.stopReason).toBe('max_tool_rounds_reached');
    expect(result.finalAnswer).toBe('Round 1');
    expect(result.toolRoundsUsed).toBe(1);
    expect(result.verification).toEqual({
      isVerified: false,
      finalAnswerIsNonEmpty: false,
      finalAnswerIsSubstantive: true,
      toolEvidenceSatisfied: true,
      noUnresolvedToolErrors: true,
      toolMessagesCount: 1,
      checks: [
        {
          name: 'turn_completed',
          passed: false,
          details: 'Agent turn stopped before the provider produced a final post-tool answer.'
        },
        {
          name: 'final_answer_non_empty',
          passed: false,
          details: 'Final answer is not accepted because the turn stopped before completion.'
        },
        {
          name: 'tool_evidence',
          passed: true,
          details: 'Observed 1 tool message(s) for an inspection-style goal.'
        },
        {
          name: 'final_answer_substantive',
          passed: true,
          details: 'Substantive final answer not required for this goal.'
        },
        {
          name: 'no_unresolved_tool_errors',
          passed: true,
          details: 'Tool-error consistency check not required for this goal.'
        }
      ]
    });
  });

  it('enforces the available tool allow-list for execution, not just provider metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-allow-list-'));
    await writeFile(join(workspace, 'note.txt'), 'agent note', 'utf8');

    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will read the file.' },
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'I was not allowed to use that tool.' },
        toolCalls: []
      }
    ]);

    const result = await runAgentTurn({
      provider,
      availableTools: [searchTool],
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Read note.txt and explain it.',
      cwd: workspace,
      maxToolRounds: 2
    });

    expect(result.history).toEqual([
      { role: 'user', content: 'Read note.txt and explain it.' },
      { role: 'assistant', content: 'I will read the file.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-read-1',
        content: 'Tool not allowed for this turn: read_file',
        isError: true
      },
      { role: 'assistant', content: 'I was not allowed to use that tool.' }
    ]);
    expect(result.verification.isVerified).toBe(false);
    expect(result.verification.toolMessagesCount).toBe(0);
  });

  it('executes the exact tool instance provided in availableTools', async () => {
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will use the custom read tool.' },
        toolCalls: [
          {
            id: 'call-read-1',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Done with custom tool.' },
        toolCalls: []
      }
    ]);

    const customReadTool: Tool<{ path: string }> = {
      name: 'read_file',
      description: 'Custom test read tool',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      },
      async execute(input) {
        return {
          content: `custom:${input.path}`
        };
      }
    };

    const result = await runAgentTurn({
      provider,
      availableTools: [customReadTool],
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Read note.txt and explain it.',
      cwd: '/tmp/custom-tool-runtime',
      maxToolRounds: 2
    });

    expect(result.history).toEqual([
      { role: 'user', content: 'Read note.txt and explain it.' },
      { role: 'assistant', content: 'I will use the custom read tool.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-read-1',
        content: 'custom:note.txt',
        isError: false
      },
      { role: 'assistant', content: 'Done with custom tool.' }
    ]);
  });

  it('creates a runtime with the selected anthropic provider, builtin tools, cwd, observer, and AgentSpec defaults', async () => {
    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://anthropic.example/v1',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-compose'
    });

    expect(runtime.cwd).toBe('/tmp/runtime-compose');
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec']);
    expect(runtime.provider.name).toBe('anthropic');
    expect(runtime.provider.model).toBe('claude-sonnet-4-20250514');
    expect(runtime.observer.record).toBeTypeOf('function');
    expect(runtime.agentSpec).toEqual(defaultAgentSpec);
    expect(runtime.systemPrompt).toContain('Identity:');
    expect(runtime.systemPrompt).toContain(defaultAgentSpec.identity.purpose);
    expect(runtime.maxToolRounds).toBe(defaultAgentSpec.completion.maxToolRounds);
  });

  it('creates a runtime with the selected openai provider and requested model', async () => {
    const runtime = createAgentRuntime({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://openai.example/v1',
      apiKey: 'openai-runtime-key',
      cwd: '/tmp/runtime-openai'
    });

    expect(runtime.cwd).toBe('/tmp/runtime-openai');
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec']);
    expect(runtime.provider.name).toBe('openai');
    expect(runtime.provider.model).toBe('gpt-4.1');
    expect(runtime.observer.record).toBeTypeOf('function');
    expect(runtime.maxToolRounds).toBe(10);
  });

  it('creates a runtime from the readonly built-in AgentSpec preset', async () => {
    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-readonly',
      agentSpecName: 'readonly'
    });

    expect(runtime.cwd).toBe('/tmp/runtime-readonly');
    expect(runtime.agentSpec).toEqual(readonlyAgentSpec);
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'search', 'shell_readonly']);
    expect(runtime.maxToolRounds).toBe(readonlyAgentSpec.completion.maxToolRounds);
    expect(runtime.systemPrompt).toContain(readonlyAgentSpec.identity.purpose);
  });

  it('records deterministic telemetry events while a turn runs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-telemetry-'));
    await writeFile(join(workspace, 'note.txt'), 'agent note', 'utf8');

    const observedEvents: TelemetryEvent[] = [];
    const metrics = createInMemoryMetricsObserver();
    const provider = createScriptedProvider([
      normalizeProviderResponse({
        content: 'I will read the file first.',
        toolCalls: [
          {
            id: 'call-read-telemetry',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ],
        finish: {
          stopReason: 'tool_use'
        },
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19
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
            input_tokens: 12,
            output_tokens: 7
          },
          providerStopDetails: {
            stop_reason: 'tool_use'
          },
          toolCallSummaries: [
            {
              id: 'call-read-telemetry',
              name: 'read_file'
            }
          ],
          responseContentBlocksByType: {
            text: 1,
            tool_use: 1
          },
          responsePreviewRedacted: '[{"type":"text","text":"I will read the file first."},{"type":"tool_use","name":"read_file"}]'
        }
      }),
      normalizeProviderResponse({
        content: 'The note says: agent note',
        toolCalls: [],
        finish: {
          stopReason: 'end_turn'
        },
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25
        },
        responseMetrics: {
          contentBlockCount: 1,
          toolCallCount: 0,
          hasTextOutput: true,
          contentBlocksByType: {
            text: 1
          }
        },
        debug: {
          providerUsageRawRedacted: {
            input_tokens: 20,
            output_tokens: 5
          },
          providerStopDetails: {
            stop_reason: 'end_turn'
          },
          toolCallSummaries: [],
          responseContentBlocksByType: {
            text: 1
          },
          responsePreviewRedacted: '[{"type":"text","text":"The note says: agent note"}]'
        }
      })
    ]);

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Read note.txt and summarize it.',
      cwd: workspace,
      maxToolRounds: 3,
      observer: {
        record(event) {
          observedEvents.push(event);
          metrics.record(event);
        }
      }
    });

    expect(result.finalAnswer).toBe('The note says: agent note');
    expect(observedEvents.map((event) => event.type)).toEqual([
      'user_input_received',
      'turn_started',
      'prompt_size_summary',
      'provider_called',
      'provider_responded',
      'tool_call_started',
      'tool_call_completed',
      'tool_batch_summary',
      'prompt_size_summary',
      'provider_called',
      'provider_responded',
      'verification_completed',
      'completion_check',
      'turn_completed',
      'turn_summary'
    ]);
    expect(observedEvents[0]).toMatchObject({
      type: 'user_input_received',
      stage: 'input_received',
      data: {
        userInput: 'Read note.txt and summarize it.',
        userInputChars: 'Read note.txt and summarize it.'.length,
        providerRound: 0,
        toolRound: 0,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[1]).toMatchObject({
      type: 'turn_started',
      stage: 'input_received',
      data: {
        cwd: workspace,
        maxToolRounds: 3,
        toolNames: ['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec'],
        userInput: 'Read note.txt and summarize it.',
        providerRound: 0,
        toolRound: 0,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[2]).toMatchObject({
      type: 'prompt_size_summary',
      stage: 'provider_decision',
      data: {
        messageCount: 2,
        promptRawChars: JSON.stringify([
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Read note.txt and summarize it.' }
        ]).length,
        toolMessagesCount: 0,
        assistantToolCallsCount: 0,
        systemMessageChars: JSON.stringify({ role: 'system', content: 'You are helpful.' }).length,
        userMessageChars: JSON.stringify({ role: 'user', content: 'Read note.txt and summarize it.' }).length,
        assistantTextChars: 0,
        assistantToolCallChars: 0,
        toolResultChars: 0,
        promptGrowthSinceLastProviderCallChars: undefined,
        toolResultContributionSinceLastProviderCallChars: undefined,
        providerRound: 1,
        toolRound: 0,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[3]).toMatchObject({
      type: 'provider_called',
      stage: 'provider_decision',
      data: {
        messageCount: 2,
        promptRawChars: JSON.stringify([
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Read note.txt and summarize it.' }
        ]).length,
        toolNames: ['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec'],
        messageSummaries: [
          {
            role: 'system',
            rawChars: JSON.stringify({ role: 'system', content: 'You are helpful.' }).length,
            contentBlockCount: 1,
            messageSource: 'system'
          },
          {
            role: 'user',
            rawChars: JSON.stringify({ role: 'user', content: 'Read note.txt and summarize it.' }).length,
            contentBlockCount: 1,
            messageSource: 'user'
          }
        ],
        totalContentBlockCount: 2,
        hasSystemPrompt: true,
        promptRawPreviewRedacted: '{"messages":[{"content":"You are helpful.","role":"system"},{"content":"Read note.txt and summarize it.","role":"user"}]}',
        providerRound: 1,
        toolRound: 0,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[3]?.data).not.toHaveProperty('providerName');
    expect(observedEvents[3]?.data).not.toHaveProperty('providerModel');
    expect(observedEvents[3]?.data).not.toHaveProperty('promptPreview');
    expect(observedEvents[3]?.data).not.toHaveProperty('contentBlockCount');
    expect(observedEvents[4]).toMatchObject({
      type: 'provider_responded',
      stage: 'provider_decision',
      data: {
        stopReason: 'tool_use',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19
        },
        responseContentBlockCount: 2,
        toolCallCount: 1,
        hasTextOutput: true,
        responseContentBlocksByType: {
          text: 1,
          tool_use: 1
        },
        toolCallSummaries: [
          {
            id: 'call-read-telemetry',
            name: 'read_file'
          }
        ],
        providerUsageRawRedacted: {
          input_tokens: 12,
          output_tokens: 7
        },
        providerStopDetails: {
          stop_reason: 'tool_use'
        },
        responsePreviewRedacted: '[{"type":"text","text":"I will read the file first."},{"type":"tool_use","name":"read_file"}]',
        durationMs: expect.any(Number),
        providerRound: 1,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[4]?.data).not.toHaveProperty('assistantContentLength');
    expect(observedEvents[4]?.data).not.toHaveProperty('finish');
    expect(observedEvents[4]?.data).not.toHaveProperty('responseMetrics');
    expect(observedEvents[4]?.data).not.toHaveProperty('debug');
    expect(observedEvents[5]).toMatchObject({
      type: 'tool_call_started',
      stage: 'tool_execution',
      data: {
        toolName: 'read_file',
        toolCallId: 'call-read-telemetry',
        inputPreview: '{"path":"note.txt"}',
        inputRawRedacted: {
          path: 'note.txt'
        },
        providerRound: 1,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[6]).toMatchObject({
      type: 'tool_call_completed',
      stage: 'tool_execution',
      data: {
        toolName: 'read_file',
        toolCallId: 'call-read-telemetry',
        isError: false,
        resultPreview: '{"content":"agent note"}',
        resultRawRedacted: {
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-read-telemetry',
          content: 'agent note',
          isError: false
        },
        durationMs: expect.any(Number),
        resultSizeChars: expect.any(Number),
        resultSizeBucket: 'small',
        providerRound: 1,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[7]).toMatchObject({
      type: 'tool_batch_summary',
      stage: 'tool_execution',
      data: {
        toolCallsTotal: 1,
        toolCallsByName: {
          read_file: 1
        },
        batchSource: 'single_provider_response',
        batchIndexWithinTurn: 1,
        providerResponseToolCallCount: 1,
        providerResponseHadTextOutput: true,
        toolCallIds: ['call-read-telemetry'],
        resultSizeCharsTotal: expect.any(Number),
        resultSizeCharsMax: expect.any(Number),
        errorCount: 0,
        duplicateToolNameCount: 0,
        sameToolNameRepeated: false,
        providerRound: 1,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[8]).toMatchObject({
      type: 'prompt_size_summary',
      stage: 'provider_decision',
      data: {
        messageCount: 4,
        toolMessagesCount: 1,
        assistantToolCallsCount: 1,
        systemMessageChars: JSON.stringify({ role: 'system', content: 'You are helpful.' }).length,
        userMessageChars: JSON.stringify({ role: 'user', content: 'Read note.txt and summarize it.' }).length,
        assistantTextChars: 0,
        assistantToolCallChars: JSON.stringify({
          role: 'assistant',
          content: 'I will read the file first.',
          toolCalls: [
            {
              id: 'call-read-telemetry',
              name: 'read_file',
              input: { path: 'note.txt' }
            }
          ]
        }).length,
        toolResultChars: JSON.stringify({
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-read-telemetry',
          content: 'agent note',
          isError: false
        }).length,
        promptGrowthSinceLastProviderCallChars: expect.any(Number),
        toolResultContributionSinceLastProviderCallChars: JSON.stringify({
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-read-telemetry',
          content: 'agent note',
          isError: false
        }).length,
        providerRound: 2,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[9]).toMatchObject({
      type: 'provider_called',
      stage: 'provider_decision',
      data: {
        messageCount: 4,
        promptRawChars: JSON.stringify([
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Read note.txt and summarize it.' },
          {
            role: 'assistant',
            content: 'I will read the file first.',
            toolCalls: [
              {
                id: 'call-read-telemetry',
                name: 'read_file',
                input: { path: 'note.txt' }
              }
            ]
          },
          {
            role: 'tool',
            name: 'read_file',
            toolCallId: 'call-read-telemetry',
            content: 'agent note',
            isError: false
          }
        ]).length,
        toolNames: ['read_file', 'edit_file', 'search', 'shell_readonly', 'shell_exec'],
        messageSummaries: [
          {
            role: 'system',
            rawChars: JSON.stringify({ role: 'system', content: 'You are helpful.' }).length,
            contentBlockCount: 1,
            messageSource: 'system'
          },
          {
            role: 'user',
            rawChars: JSON.stringify({ role: 'user', content: 'Read note.txt and summarize it.' }).length,
            contentBlockCount: 1,
            messageSource: 'user'
          },
          {
            role: 'assistant',
            rawChars: JSON.stringify({
              role: 'assistant',
              content: 'I will read the file first.',
              toolCalls: [
                {
                  id: 'call-read-telemetry',
                  name: 'read_file',
                  input: { path: 'note.txt' }
                }
              ]
            }).length,
            contentBlockCount: 2,
            messageSource: 'assistant_tool_call',
            toolCallCount: 1
          },
          {
            role: 'tool',
            rawChars: JSON.stringify({
              role: 'tool',
              name: 'read_file',
              toolCallId: 'call-read-telemetry',
              content: 'agent note',
              isError: false
            }).length,
            contentBlockCount: 1,
            messageSource: 'tool_result',
            toolName: 'read_file',
            toolCallId: 'call-read-telemetry',
            isError: false
          }
        ],
        totalContentBlockCount: 5,
        hasSystemPrompt: true,
        promptRawPreviewRedacted:
          '{"messages":[{"content":"You are helpful.","role":"system"},{"content":"Read note.txt and summarize it.","role":"user"},{"content":"I will read the file first.","role":"assistant","toolCalls":[{"id":"call-read-telemetry","input":{"path":"note.txt"},"name":"read_file"}]},{"content":"agent note","isError":false,"name":"read_file","role":"tool","toolCallId":"call-read-telemetry"}]}',
        providerRound: 2,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[9]?.data).not.toHaveProperty('providerName');
    expect(observedEvents[9]?.data).not.toHaveProperty('providerModel');
    expect(observedEvents[9]?.data).not.toHaveProperty('promptPreview');
    expect(observedEvents[9]?.data).not.toHaveProperty('contentBlockCount');
    expect(observedEvents[10]).toMatchObject({
      type: 'provider_responded',
      stage: 'provider_decision',
      data: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25
        },
        responseContentBlockCount: 1,
        toolCallCount: 0,
        hasTextOutput: true,
        responseContentBlocksByType: {
          text: 1
        },
        toolCallSummaries: [],
        providerUsageRawRedacted: {
          input_tokens: 20,
          output_tokens: 5
        },
        providerStopDetails: {
          stop_reason: 'end_turn'
        },
        responsePreviewRedacted: '[{"type":"text","text":"The note says: agent note"}]',
        durationMs: expect.any(Number),
        providerRound: 2,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[10]?.data).not.toHaveProperty('assistantContentLength');
    expect(observedEvents[10]?.data).not.toHaveProperty('finish');
    expect(observedEvents[10]?.data).not.toHaveProperty('responseMetrics');
    expect(observedEvents[10]?.data).not.toHaveProperty('debug');
    expect(observedEvents[11]).toMatchObject({
      type: 'verification_completed',
      stage: 'completion_check',
      data: {
        isVerified: true,
        toolMessagesCount: 1,
        providerRound: 2,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[12]).toMatchObject({
      type: 'completion_check',
      stage: 'completion_check',
      data: {
        hasFinalText: true,
        hasToolErrors: false,
        maxToolRoundsReached: false,
        stoppedNormally: true,
        providerRound: 2,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[13]).toMatchObject({
      type: 'turn_completed',
      stage: 'completion_check',
      data: {
        stopReason: 'completed',
        toolRoundsUsed: 1,
        isVerified: true,
        durationMs: expect.any(Number),
        providerRound: 2,
        toolRound: 1,
        turnId: expect.any(String)
      }
    });
    expect(observedEvents[14]).toMatchObject({
      type: 'turn_summary',
      stage: 'completion_check',
      data: {
        providerRounds: 2,
        toolRoundsUsed: 1,
        toolCallsTotal: 1,
        toolCallsByName: {
          read_file: 1
        },
        inputTokensTotal: 32,
        outputTokensTotal: 12,
        promptCharsMax: JSON.stringify([
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Read note.txt and summarize it.' },
          {
            role: 'assistant',
            content: 'I will read the file first.',
            toolCalls: [
              {
                id: 'call-read-telemetry',
                name: 'read_file',
                input: { path: 'note.txt' }
              }
            ]
          },
          {
            role: 'tool',
            name: 'read_file',
            toolCallId: 'call-read-telemetry',
            content: 'agent note',
            isError: false
          }
        ]).length,
        toolResultCharsInFinalPrompt: JSON.stringify({
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-read-telemetry',
          content: 'agent note',
          isError: false
        }).length,
        assistantToolCallCharsInFinalPrompt: JSON.stringify({
          role: 'assistant',
          content: 'I will read the file first.',
          toolCalls: [
            {
              id: 'call-read-telemetry',
              name: 'read_file',
              input: { path: 'note.txt' }
            }
          ]
        }).length,
        toolResultPromptGrowthCharsTotal: JSON.stringify({
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-read-telemetry',
          content: 'agent note',
          isError: false
        }).length,
        toolResultCharsAddedAcrossTurn: JSON.stringify({
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-read-telemetry',
          content: 'agent note',
          isError: false
        }).length,
        turnCompleted: true,
        stopReason: 'completed',
        turnId: expect.any(String)
      }
    });
    expect(metrics.snapshot()).toEqual({
      turnsStarted: 1,
      turnsCompleted: 1,
      turnsFailed: 0,
      totalToolCallsCompleted: 1,
      lastTurnDurationMs: expect.any(Number)
    });
  });

  it('builds tool input previews from redacted values before recording telemetry', async () => {
    const observedEvents: TelemetryEvent[] = [];
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will call the auth tool.' },
        toolCalls: [
          {
            id: 'call-input-telemetry',
            name: 'auth_tool',
            input: {
              apiKey: 'super-secret-key',
              nested: {
                password: 'p@ssw0rd'
              },
              query: 'show status'
            }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Done.' },
        toolCalls: []
      }
    ]);

    const authTool: Tool<{ apiKey: string; nested: { password: string }; query: string }> = {
      name: 'auth_tool',
      description: 'Consumes auth-flavored inputs',
      inputSchema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string' },
          nested: {
            type: 'object',
            properties: {
              password: { type: 'string' }
            },
            required: ['password'],
            additionalProperties: false
          },
          query: { type: 'string' }
        },
        required: ['apiKey', 'nested', 'query'],
        additionalProperties: false
      },
      async execute() {
        return {
          content: 'ok'
        };
      }
    };

    await runAgentTurn({
      provider,
      availableTools: [authTool],
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Run the tool.',
      cwd: '/tmp/input-telemetry-runtime',
      maxToolRounds: 2,
      observer: {
        record(event) {
          observedEvents.push(event);
        }
      }
    });

    const toolCallStartedEvent = observedEvents.find((event) => event.type === 'tool_call_started');

    expect(toolCallStartedEvent?.type).toBe('tool_call_started');
    if (!toolCallStartedEvent || toolCallStartedEvent.type !== 'tool_call_started') {
      throw new Error('expected tool_call_started event');
    }
    expect(toolCallStartedEvent).toMatchObject({
      type: 'tool_call_started',
      data: {
        toolName: 'auth_tool',
        toolCallId: 'call-input-telemetry',
        inputPreview: '{"apiKey":"[REDACTED]","nested":{"password":"[REDACTED]"},"query":"show status"}'
      }
    });
    expect(toolCallStartedEvent.data.inputRawRedacted).toEqual({
      apiKey: '[REDACTED]',
      nested: {
        password: '[REDACTED]'
      },
      query: 'show status'
    });
  });

  it('builds tool result previews from redacted JSON string values before recording telemetry', async () => {
    const observedEvents: TelemetryEvent[] = [];
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will call the token tool.' },
        toolCalls: [
          {
            id: 'call-json-telemetry',
            name: 'json_tool',
            input: { query: 'show token' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Done.' },
        toolCalls: []
      }
    ]);

    const jsonTool: Tool<{ query: string }> = {
      name: 'json_tool',
      description: 'Returns JSON as a string',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query'],
        additionalProperties: false
      },
      async execute(input) {
        return {
          content: JSON.stringify({
            token: 'secret-token-value',
            nested: {
              authorization: 'Bearer abc'
            },
            query: input.query
          })
        };
      }
    };

    await runAgentTurn({
      provider,
      availableTools: [jsonTool],
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Run the tool.',
      cwd: '/tmp/json-telemetry-runtime',
      maxToolRounds: 2,
      observer: {
        record(event) {
          observedEvents.push(event);
        }
      }
    });

    const toolCallCompletedEvent = observedEvents.find((event) => event.type === 'tool_call_completed');

    expect(toolCallCompletedEvent?.type).toBe('tool_call_completed');
    if (!toolCallCompletedEvent || toolCallCompletedEvent.type !== 'tool_call_completed') {
      throw new Error('expected tool_call_completed event');
    }
    expect(toolCallCompletedEvent).toMatchObject({
      type: 'tool_call_completed',
      data: {
        toolName: 'json_tool',
        toolCallId: 'call-json-telemetry',
        isError: false,
        resultPreview: '{"content":{"nested":{"authorization":"[REDACTED]"},"query":"show token","token":"[REDACTED]"}}'
      }
    });
    expect(toolCallCompletedEvent.data.resultRawRedacted).toEqual({
      role: 'tool',
      name: 'json_tool',
      toolCallId: 'call-json-telemetry',
      content: {
        token: '[REDACTED]',
        nested: {
          authorization: '[REDACTED]'
        },
        query: 'show token'
      },
      isError: false
    });
  });

  it('records a stopped telemetry event instead of completed when max tool rounds are reached', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-telemetry-stop-'));
    await writeFile(join(workspace, 'note.txt'), 'agent note', 'utf8');

    const observedEvents: TelemetryEvent[] = [];
    const metrics = createInMemoryMetricsObserver();
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'Round 1' },
        toolCalls: [
          {
            id: 'call-read-stop',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Round 2' },
        toolCalls: [
          {
            id: 'call-read-stop-2',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      }
    ]);

    const result = await runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Read note.txt carefully.',
      cwd: workspace,
      maxToolRounds: 1,
      observer: {
        record(event) {
          observedEvents.push(event);
          metrics.record(event);
        }
      }
    });

    expect(result.stopReason).toBe('max_tool_rounds_reached');
    const turnStoppedEvent = observedEvents.find((event) => event.type === 'turn_stopped');
    expect(turnStoppedEvent).toMatchObject({
      type: 'turn_stopped',
      data: {
        stopReason: 'max_tool_rounds_reached',
        toolRoundsUsed: 1,
        isVerified: false
      }
    });
    expect(observedEvents.at(-1)?.type).toBe('turn_summary');
    expect(metrics.snapshot()).toEqual({
      turnsStarted: 1,
      turnsCompleted: 0,
      turnsFailed: 0,
      totalToolCallsCompleted: 1,
      lastTurnDurationMs: 0
    });
  });

  it('records batch-level diagnostics for multi-call tool responses', async () => {
    const observedEvents: TelemetryEvent[] = [];
    const provider = createScriptedProvider([
      {
        message: {
          role: 'assistant',
          content: 'I will inspect two files.'
        },
        toolCalls: [
          {
            id: 'call-read-a',
            name: 'read_file',
            input: { path: 'A.txt' }
          },
          {
            id: 'call-read-b',
            name: 'read_file',
            input: { path: 'B.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Done.' },
        toolCalls: []
      }
    ]);

    const readTool: Tool<{ path: string }> = {
      name: 'read_file',
      description: 'Reads a fake file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path'],
        additionalProperties: false
      },
      async execute(input) {
        return {
          content: input.path === 'A.txt' ? 'A'.repeat(120) : 'ok'
        };
      }
    };

    await runAgentTurn({
      provider,
      availableTools: [readTool],
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Inspect both files.',
      cwd: '/tmp/multi-tool-batch',
      maxToolRounds: 2,
      observer: {
        record(event) {
          observedEvents.push(event);
        }
      }
    });

    const batchSummaryEvent = observedEvents.find((event) => event.type === 'tool_batch_summary');
    const completedEvents = observedEvents.filter((event) => event.type === 'tool_call_completed');

    expect(completedEvents).toHaveLength(2);
    expect(batchSummaryEvent).toMatchObject({
      type: 'tool_batch_summary',
      stage: 'tool_execution',
      data: {
        toolCallsTotal: 2,
        toolCallsByName: { read_file: 2 },
        batchSource: 'single_provider_response',
        batchIndexWithinTurn: 1,
        providerResponseToolCallCount: 2,
        providerResponseHadTextOutput: true,
        toolCallIds: ['call-read-a', 'call-read-b'],
        duplicateToolNameCount: 1,
        sameToolNameRepeated: true,
        batchLengthHint: 'multi_call_batch',
        largeResultHint: 'single_result_large',
        oversizedToolCallIds: ['call-read-a']
      }
    });
  });

  it('records a failed telemetry event when provider.generate throws', async () => {
    const observedEvents: TelemetryEvent[] = [];
    const metrics = createInMemoryMetricsObserver();
    const provider: ModelProvider = {
      name: 'failing',
      model: 'test-model',
      async generate() {
        throw new Error('provider boom');
      }
    };

    await expect(
      runAgentTurn({
        provider,
        availableTools: getBuiltinTools(),
        baseSystemPrompt: 'You are helpful.',
        userInput: 'Answer briefly.',
        cwd: '/tmp/runtime-failing',
        maxToolRounds: 1,
        observer: {
          record(event) {
            observedEvents.push(event);
            metrics.record(event);
          }
        }
      })
    ).rejects.toThrow('provider boom');

    expect(observedEvents.map((event) => event.type)).toEqual([
      'user_input_received',
      'turn_started',
      'prompt_size_summary',
      'provider_called',
      'turn_failed'
    ]);
    expect(observedEvents[4]).toMatchObject({
      type: 'turn_failed',
      stage: 'completion_check',
      data: {
        message: 'provider boom'
      }
    });
    expect(metrics.snapshot()).toEqual({
      turnsStarted: 1,
      turnsCompleted: 0,
      turnsFailed: 1,
      totalToolCallsCompleted: 0,
      lastTurnDurationMs: expect.any(Number)
    });
  });

  it('times out when provider.generate never resolves', async () => {
    vi.useFakeTimers();

    const provider: ModelProvider = {
      name: 'hanging',
      model: 'test-model',
      async generate() {
        return await new Promise<ProviderResponse>(() => undefined);
      }
    };

    const turnPromise = runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Answer briefly.',
      cwd: '/tmp/runtime-timeout',
      maxToolRounds: 1
    });
    const expectation = expect(turnPromise).rejects.toThrow(/provider.*timeout/i);

    await vi.advanceTimersByTimeAsync(120_000);

    await expectation;
  });

  it('uses provider timeout from environment when configured', async () => {
    vi.useFakeTimers();
    process.env.QICLAW_PROVIDER_TIMEOUT_MS = '10';

    const provider: ModelProvider = {
      name: 'hanging',
      model: 'test-model',
      async generate() {
        return await new Promise<ProviderResponse>(() => undefined);
      }
    };

    const turnPromise = runAgentTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Answer briefly.',
      cwd: '/tmp/runtime-timeout-env',
      maxToolRounds: 1
    });
    const expectation = expect(turnPromise).rejects.toThrow(/timeout after 10ms/i);

    await vi.advanceTimersByTimeAsync(10);

    await expectation;
    delete process.env.QICLAW_PROVIDER_TIMEOUT_MS;
  });

  it('marks openai incomplete responses in metadata', () => {
    const metadata = normalizeOpenAIResponseMetadata({
      id: 'resp-incomplete',
      model: 'gpt-test',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: []
    });

    expect(metadata.finish.stopReason).toBe('max_output_tokens');
    expect(metadata.responseMetrics.hasTextOutput).toBe(false);
    expect(metadata.responseMetrics.toolCallCount).toBe(0);
  });

  it('marks anthropic empty responses in metadata', () => {
    const metadata = normalizeAnthropicResponseMetadata({
      id: 'msg-empty',
      model: 'claude-test',
      stop_reason: 'end_turn',
      content: []
    });

    expect(metadata.finish.stopReason).toBe('end_turn');
    expect(metadata.responseMetrics.hasTextOutput).toBe(false);
    expect(metadata.responseMetrics.toolCallCount).toBe(0);
  });
});

describe('built-in tool behavior', () => {
  it('keeps read_file inside the workspace root', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'tool-parent-'));
    const workspace = join(parentDir, 'workspace');
    const allowedPath = join(workspace, 'allowed.txt');
    const outsidePath = join(parentDir, 'outside.txt');

    await mkdir(workspace, { recursive: true });
    await writeFile(allowedPath, 'inside', 'utf8');
    await writeFile(outsidePath, 'outside', 'utf8');

    await expect(readFileTool.execute({ path: 'allowed.txt' }, { cwd: workspace })).resolves.toEqual({
      content: 'inside'
    });

    await expect(readFileTool.execute({ path: '../outside.txt' }, { cwd: workspace })).rejects.toThrow(
      /workspace/i
    );
    await expect(readFileTool.execute({ path: outsidePath }, { cwd: workspace })).rejects.toThrow(/workspace/i);
  });

  it('truncates oversized read_file output with a marker', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-read-truncate-'));
    const filePath = join(workspace, 'large.txt');

    await writeFile(filePath, 'a'.repeat(40_000), 'utf8');

    const result = await readFileTool.execute({ path: 'large.txt' }, { cwd: workspace });

    expect(result.content.length).toBeLessThan(34_000);
    expect(result.content).toMatch(/truncated/i);
  });

  it('keeps edit_file inside the workspace root and replaces only the first match', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-workspace-'));
    const editablePath = join(workspace, 'editable.txt');
    const outsidePath = join(tmpdir(), `outside-edit-${Date.now()}.txt`);

    await writeFile(editablePath, 'alpha\nalpha\n', 'utf8');
    await writeFile(outsidePath, 'blocked', 'utf8');

    await editFileTool.execute(
      {
        path: 'editable.txt',
        oldText: 'alpha',
        newText: 'beta'
      },
      { cwd: workspace }
    );

    await expect(readFile(editablePath, 'utf8')).resolves.toBe('beta\nalpha\n');
    await expect(editFileTool.execute({ path: outsidePath, oldText: 'blocked', newText: 'open' }, { cwd: workspace }))
      .rejects.toThrow(/workspace/i);
  });

  it('skips obvious irrelevant directories while searching and returns structured context snippets', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-search-'));
    const srcDir = join(workspace, 'src');
    const nodeModulesDir = join(workspace, 'node_modules');
    const gitDir = join(workspace, '.git');
    const distDir = join(workspace, 'dist');
    const worktreesDir = join(workspace, '.worktrees');
    const matchPath = join(srcDir, 'match.txt');

    await mkdir(srcDir, { recursive: true });
    await mkdir(nodeModulesDir, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(worktreesDir, { recursive: true });

    await writeFile(matchPath, 'alpha\nbeta\nneedle here\ngamma\ndelta', 'utf8');
    await writeFile(join(nodeModulesDir, 'ignored.txt'), 'needle in dependency', 'utf8');
    await writeFile(join(gitDir, 'ignored.txt'), 'needle in git dir', 'utf8');
    await writeFile(join(distDir, 'ignored.txt'), 'needle in build output', 'utf8');
    await writeFile(join(worktreesDir, 'ignored.txt'), 'needle in nested worktree', 'utf8');

    const result = await searchTool.execute({ pattern: 'needle' }, { cwd: workspace });
    const data = result.data as {
      totalMatches: number;
      totalFiles: number;
      returnedMatches: number;
      returnedFiles: number;
      files: Array<{
        path: string;
        relativePath: string;
        snippets: Array<{
          startLine: number;
          endLine: number;
          matches: Array<{ lineNumber: number; line: string }>;
          lines: Array<{ lineNumber: number; text: string; isMatch: boolean }>;
        }>;
      }>;
    };

    expect(result.content).toContain('Found 1 match in 1 file');
    expect(result.content).toContain(matchPath);
    expect(result.content).not.toContain('ignored.txt');
    expect(data).toMatchObject({
      totalMatches: 1,
      totalFiles: 1,
      returnedMatches: 1,
      returnedFiles: 1
    });
    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({ path: matchPath, relativePath: 'src/match.txt' });
    expect(data.files[0]!.snippets).toEqual([
      {
        startLine: 1,
        endLine: 5,
        matches: [{ lineNumber: 3, line: 'needle here' }],
        lines: [
          { lineNumber: 1, text: 'alpha', isMatch: false },
          { lineNumber: 2, text: 'beta', isMatch: false },
          { lineNumber: 3, text: 'needle here', isMatch: true },
          { lineNumber: 4, text: 'gamma', isMatch: false },
          { lineNumber: 5, text: 'delta', isMatch: false }
        ]
      }
    ]);
  });

  it('merges overlapping search contexts within the same file to avoid duplicate snippets', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-search-overlap-'));
    const filePath = join(workspace, 'match.txt');

    await writeFile(filePath, 'line 1\nneedle first\nline 3\nneedle second\nline 5\nline 6', 'utf8');

    const result = await searchTool.execute({ pattern: 'needle' }, { cwd: workspace });
    const data = result.data as {
      files: Array<{
        snippets: Array<{
          startLine: number;
          endLine: number;
          matches: Array<{ lineNumber: number; line: string }>;
          lines: Array<{ lineNumber: number; text: string; isMatch: boolean }>;
        }>;
      }>;
    };

    expect(result.content).toContain(filePath);
    expect(data.files[0]!.snippets).toHaveLength(1);
    expect(data.files[0]!.snippets[0]).toMatchObject({
      startLine: 1,
      endLine: 6,
      matches: [
        { lineNumber: 2, line: 'needle first' },
        { lineNumber: 4, line: 'needle second' }
      ]
    });
    expect(data.files[0]!.snippets[0]!.lines.map((line) => line.lineNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('falls back to grep when rg is unavailable and truncates oversized search output', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-search-fallback-'));
    const filePath = join(workspace, 'match.txt');

    await writeFile(
      filePath,
      Array.from({ length: 400 }, (_, index) => `needle line ${index + 1} ${'x'.repeat(20)}`).join('\n'),
      'utf8'
    );

    const shellSpy = vi.spyOn(shellToolModule.shellReadonlyTool, 'execute')
      .mockRejectedValueOnce(new Error('Command failed: rg\nExit code: ENOENT'))
      .mockResolvedValueOnce({
        content: Array.from({ length: 400 }, (_, index) => `${filePath}:${index + 1}:needle line ${index + 1} ${'x'.repeat(20)}`).join('\n')
      });

    const result = await searchTool.execute({ pattern: 'needle', maxMatches: 50 }, { cwd: workspace });
    const data = result.data as {
      totalMatches: number;
      returnedMatches: number;
      truncated: boolean;
      truncationReason?: string;
    };

    expect(shellSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'rg' }), { cwd: workspace });
    expect(shellSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'grep' }), { cwd: workspace });
    expect(result.content).toContain(filePath);
    expect(result.content).toMatch(/truncated|showing/i);
    expect(result.content.length).toBeLessThan(20_000);
    expect(data).toMatchObject({
      totalMatches: 400,
      returnedMatches: 50,
      truncated: true,
      truncationReason: 'maxMatches'
    });
  });

  it('supports partial line reads in read_file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-read-partial-'));
    const filePath = join(workspace, 'match.txt');
    const fileContent = Array.from({ length: 10 }, (_, index) => index === 4 ? 'needle here' : `line ${index + 1}`).join('\n');

    await writeFile(filePath, fileContent, 'utf8');

    const result = await readFileTool.execute({ path: 'match.txt', startLine: 4, endLine: 6 } as never, { cwd: workspace });

    expect(result.content).toBe(['4: line 4', '5: needle here', '6: line 6'].join('\n'));
  });

  it('returns a compact structured result when search finds no matches', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-search-empty-'));

    vi.spyOn(shellToolModule.shellReadonlyTool, 'execute').mockResolvedValueOnce({
      content: ''
    });

    const result = await searchTool.execute({ pattern: 'needle' }, { cwd: workspace });
    const data = result.data as {
      totalMatches: number;
      totalFiles: number;
      returnedMatches: number;
      returnedFiles: number;
      truncated: boolean;
      files: unknown[];
    };

    expect(result.content).toMatch(/no matches/i);
    expect(data).toEqual({
      pattern: 'needle',
      totalMatches: 0,
      totalFiles: 0,
      returnedMatches: 0,
      returnedFiles: 0,
      truncated: false,
      files: []
    });
  });

  it('wraps shell exec failures with command, exit code, stdout, and stderr', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-shell-'));

    await expect(
      shellExecTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/exit code:\s*7/i);

    await expect(
      shellExecTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/stdout:\s*out[\s\S]*stderr:\s*err/i);
  });

  it('returns structured data for shell exec success', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-shell-success-'));

    await expect(
      shellExecTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err");']
        },
        { cwd: workspace }
      )
    ).resolves.toEqual({
      content: 'outerr',
      data: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("out"); process.stderr.write("err");'],
        stdout: 'out',
        stderr: 'err',
        exitCode: 0
      }
    });
  });

  it('rejects disallowed readonly shell commands before execution', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-shell-readonly-'));

    await expect(
      shellReadonlyTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out")']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/readonly shell command is not allowed/i);
  });
});

function createScriptedProvider(responses: ProviderResponse[], calls?: string[][]): ModelProvider {
  let index = 0;

  return {
    name: 'scripted',
    model: 'test-model',
    async generate(request) {
      calls?.push(request.messages.map((message) => `${message.role}:${message.content}`));

      const response = responses[index];

      if (!response) {
        throw new Error(`Unexpected provider.generate call at index ${index}`);
      }

      index += 1;
      return response;
    }
  };
}

function createScriptedProviderWithMetadata(
  responses: ProviderResponse[],
  calls: Array<{ messages: string[]; availableToolNames: string[] }>
): ModelProvider {
  let index = 0;

  return {
    name: 'scripted',
    model: 'test-model',
    async generate(request) {
      calls.push({
        messages: request.messages.map((message) => `${message.role}:${message.content}`),
        availableToolNames: request.availableTools.map((tool) => tool.name)
      });

      const response = responses[index];

      if (!response) {
        throw new Error(`Unexpected provider.generate call at index ${index}`);
      }

      index += 1;
      return response;
    }
  };
}
