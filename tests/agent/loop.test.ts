import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dispatchToolCall } from '../../src/agent/dispatcher.js';
import { runAgentTurn } from '../../src/agent/loop.js';
import { createAgentRuntime } from '../../src/agent/runtime.js';
import { createInMemoryMetricsObserver } from '../../src/telemetry/metrics.js';
import {
  buildAnthropicMessagesRequest,
  createAnthropicProvider,
  extractAnthropicToolCalls,
  getAnthropicApiKey,
  readAnthropicTextContent
} from '../../src/provider/anthropic.js';
import { createProvider } from '../../src/provider/factory.js';
import {
  buildOpenAIResponsesRequest,
  createOpenAIProvider,
  extractOpenAIToolCalls,
  getOpenAIApiKey,
  readOpenAITextContent
} from '../../src/provider/openai.js';
import {
  normalizeProviderResponse,
  type ModelProvider,
  type ProviderResponse,
  type ToolCallRequest
} from '../../src/provider/model.js';
import type { TelemetryEvent } from '../../src/telemetry/observer.js';
import { editFileTool } from '../../src/tools/editFile.js';
import { getBuiltinToolNames, getBuiltinTools, getTool, hasTool, type Tool, type ToolContext } from '../../src/tools/registry.js';
import { readFileTool } from '../../src/tools/readFile.js';
import { searchTool } from '../../src/tools/search.js';
import { shellTool } from '../../src/tools/shell.js';

describe('tool registry', () => {
  it('registers the built-in tool names in a stable order', () => {
    expect(getBuiltinToolNames()).toEqual(['read_file', 'edit_file', 'search', 'shell']);
  });

  it('supports tool lookup by name', () => {
    expect(hasTool('read_file')).toBe(true);
    expect(hasTool('edit_file')).toBe(true);
    expect(hasTool('search')).toBe(true);
    expect(hasTool('shell')).toBe(true);
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
          content: `value=${input.value}`
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
      content: 'value=ok'
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
    expect(request.tools?.map((tool) => tool.name)).toEqual(['read_file', 'edit_file', 'search', 'shell']);
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
    expect(request.tools).toHaveLength(4);
    expect(request.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
      strict: true
    });
  });

  it('does not mark OpenAI tools with optional properties as strict schemas', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Run ls' }],
      availableTools: [shellTool]
    });

    expect(request.tools).toEqual([
      {
        type: 'function',
        name: 'shell',
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
        availableToolNames: ['read_file', 'edit_file', 'search', 'shell']
      },
      {
        messages: [
          'system:You are helpful.',
          'user:Read note.txt and summarize it.',
          'assistant:I will read the file first.',
          'tool:agent note'
        ],
        availableToolNames: ['read_file', 'edit_file', 'search', 'shell']
      }
    ]);
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
        'system:Base prompt\n\nMemory: user prefers concise answers\n\nSkills: concise_response\n\nSummary: prior attempt failed',
        'assistant:Earlier answer.',
        'user:Answer briefly.'
      ]
    ]);
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
      toolEvidenceSatisfied: true,
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

  it('creates a runtime with the selected anthropic provider, builtin tools, cwd, and observer', async () => {
    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://anthropic.example/v1',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-compose'
    });

    expect(runtime.cwd).toBe('/tmp/runtime-compose');
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'edit_file', 'search', 'shell']);
    expect(runtime.provider.name).toBe('anthropic');
    expect(runtime.provider.model).toBe('claude-sonnet-4-20250514');
    expect(runtime.observer.record).toBeTypeOf('function');
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
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'edit_file', 'search', 'shell']);
    expect(runtime.provider.name).toBe('openai');
    expect(runtime.provider.model).toBe('gpt-4.1');
    expect(runtime.observer.record).toBeTypeOf('function');
  });

  it('records deterministic telemetry events while a turn runs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-telemetry-'));
    await writeFile(join(workspace, 'note.txt'), 'agent note', 'utf8');

    const observedEvents: TelemetryEvent[] = [];
    const metrics = createInMemoryMetricsObserver();
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will read the file first.' },
        toolCalls: [
          {
            id: 'call-read-telemetry',
            name: 'read_file',
            input: { path: 'note.txt' }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'The note says: agent note' },
        toolCalls: []
      }
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
      'turn_started',
      'provider_called',
      'provider_responded',
      'tool_call_started',
      'tool_call_completed',
      'provider_called',
      'provider_responded',
      'verification_completed',
      'turn_completed'
    ]);
    expect(observedEvents[0]).toMatchObject({
      type: 'turn_started',
      data: {
        cwd: workspace,
        maxToolRounds: 3,
        toolNames: ['read_file', 'edit_file', 'search', 'shell'],
        userInput: 'Read note.txt and summarize it.'
      }
    });
    expect(observedEvents[3]).toMatchObject({
      type: 'tool_call_started',
      data: {
        toolName: 'read_file',
        toolCallId: 'call-read-telemetry',
        inputPreview: '{"path":"note.txt"}',
        inputRawRedacted: {
          path: 'note.txt'
        }
      }
    });
    expect(observedEvents[4]).toMatchObject({
      type: 'tool_call_completed',
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
        }
      }
    });
    expect(observedEvents[7]).toMatchObject({
      type: 'verification_completed',
      data: {
        isVerified: true,
        toolMessagesCount: 1
      }
    });
    expect(observedEvents[8]).toMatchObject({
      type: 'turn_completed',
      data: {
        stopReason: 'completed',
        toolRoundsUsed: 1
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

  it('redacts sensitive values in JSON string tool results before recording telemetry', async () => {
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

    expect(observedEvents[4]).toMatchObject({
      type: 'tool_call_completed',
      data: {
        toolName: 'json_tool',
        toolCallId: 'call-json-telemetry',
        isError: false,
        resultPreview: '{"content":"{\\"token\\":\\"secret-token-value\\",\\"nested\\":{\\"authorization\\":\\"Bearer abc\\"},\\"query\\":\\"show token\\"}"}'
      }
    });
    expect(observedEvents[4]?.data.resultRawRedacted).toEqual({
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
    expect(observedEvents.at(-1)).toMatchObject({
      type: 'turn_stopped',
      data: {
        stopReason: 'max_tool_rounds_reached',
        toolRoundsUsed: 1,
        isVerified: false
      }
    });
    expect(metrics.snapshot()).toEqual({
      turnsStarted: 1,
      turnsCompleted: 0,
      turnsFailed: 0,
      totalToolCallsCompleted: 1,
      lastTurnDurationMs: 0
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

    expect(observedEvents.map((event) => event.type)).toEqual(['turn_started', 'provider_called', 'turn_failed']);
    expect(observedEvents[2]).toMatchObject({
      type: 'turn_failed',
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

  it('skips obvious irrelevant directories while searching and reports matches as they are found', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-search-'));
    const srcDir = join(workspace, 'src');
    const nodeModulesDir = join(workspace, 'node_modules');
    const gitDir = join(workspace, '.git');
    const distDir = join(workspace, 'dist');
    const worktreesDir = join(workspace, '.worktrees');

    await mkdir(srcDir, { recursive: true });
    await mkdir(nodeModulesDir, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(worktreesDir, { recursive: true });

    await writeFile(join(srcDir, 'match.txt'), 'needle here', 'utf8');
    await writeFile(join(nodeModulesDir, 'ignored.txt'), 'needle in dependency', 'utf8');
    await writeFile(join(gitDir, 'ignored.txt'), 'needle in git dir', 'utf8');
    await writeFile(join(distDir, 'ignored.txt'), 'needle in build output', 'utf8');
    await writeFile(join(worktreesDir, 'ignored.txt'), 'needle in nested worktree', 'utf8');

    const result = await searchTool.execute({ pattern: 'needle' }, { cwd: workspace });

    expect(result.content).toBe(join(srcDir, 'match.txt'));
  });

  it('wraps shell failures with command, exit code, stdout, and stderr', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-shell-'));

    await expect(
      shellTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/exit code:\s*7/i);

    await expect(
      shellTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/stdout:\s*out[\s\S]*stderr:\s*err/i);
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
