import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentPackage } from '../../src/agent/spec.js';
import { resolveBuiltinAgentPackage } from '../../src/agent/specRegistry.js';
import { buildCli, type CliRunTurnResult } from '../../src/cli/main.js';
import type { NormalizedEvent } from '../../src/provider/model.js';
import { createRepl } from '../../src/cli/repl.js';
import type { TurnEvent } from '../../src/agent/loop.js';
import { getDefaultModelForProvider, parseProviderId, resolveProviderConfig } from '../../src/provider/config.js';
import { createJsonLineLogger } from '../../src/telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../../src/telemetry/metrics.js';
import { createNoopObserver, createTelemetryEvent, type TelemetryObserver } from '../../src/telemetry/observer.js';
import { searchTool } from '../../src/tools/search.js';
import type { Tool } from '../../src/tools/tool.js';

const INTERACTIVE_PULSE_SETTLE_MS = 240;
const defaultResolvedPackage = resolveBuiltinAgentPackage('default');

const tempDirs: string[] = [];
const providerEnvKeys = [
  'MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'QICLAW_DEBUG_LOG'
] as const;

type ProviderEnvSnapshot = Partial<Record<(typeof providerEnvKeys)[number], string>>;

function snapshotProviderEnv(): ProviderEnvSnapshot {
  return {
    MODEL: process.env.MODEL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL
  };
}

function restoreProviderEnv(snapshot: ProviderEnvSnapshot): void {
  for (const key of providerEnvKeys) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withProviderEnvSnapshot(run: () => Promise<void> | void): Promise<void> {
  const snapshot = snapshotProviderEnv();

  try {
    await run();
  } finally {
    restoreProviderEnv(snapshot);
  }
}

function createSuccessfulRunTurn(): (input: { userInput: string }) => Promise<CliRunTurnResult> {
  return async (input: { userInput: string }) => ({
    stopReason: 'completed',
    finalAnswer: `handled: ${input.userInput}`,
    history: [],
    toolRoundsUsed: 0,
    doneCriteria: {
      goal: input.userInput,
      checklist: [input.userInput],
      requiresNonEmptyFinalAnswer: true as const,
      requiresToolEvidence: false,
      requiresSubstantiveFinalAnswer: false,
      forbidSuccessAfterToolErrors: false
    },
    verification: {
      isVerified: true,
      finalAnswerIsNonEmpty: true,
      finalAnswerIsSubstantive: true,
      toolEvidenceSatisfied: true,
      noUnresolvedToolErrors: true,
      toolMessagesCount: 0,
      checks: []
    }
  });
}

function createBridgeResolvedPackage(policy: ResolvedAgentPackage['effectivePolicy']): ResolvedAgentPackage {
  return {
    preset: 'cli-bridge',
    sourceTier: 'project',
    extendsChain: ['cli-bridge'],
    packageChain: [],
    effectivePolicy: policy,
    effectivePromptOrder: ['AGENT.md'],
    effectivePromptFiles: {
      'AGENT.md': {
        filePath: '/virtual/AGENT.md',
        content: 'CLI bridge agent purpose'
      }
    },
    resolvedFiles: ['/virtual/AGENT.md']
  };
}

function createNoopTestProvider() {
  return {
    name: 'test-provider',
    model: 'test-model',
    async generate() {
      throw new Error('not used');
    },
    async *stream() {
      throw new Error('not used');
    }
  };
}

function createTestRuntime(
  cwd: string,
  observer?: TelemetryObserver,
  overrides: Partial<{
    resolvedPackage: ResolvedAgentPackage;
    systemPrompt: string;
    maxToolRounds: number;
  }> = {}
) {
  return {
    provider: createNoopTestProvider(),
    availableTools: [],
    cwd,
    observer: observer ?? { record() {} },
    resolvedPackage: overrides.resolvedPackage ?? createBridgeResolvedPackage({ maxToolRounds: overrides.maxToolRounds ?? 3 }),
    systemPrompt: overrides.systemPrompt ?? 'Test prompt',
    maxToolRounds: overrides.maxToolRounds ?? 3
  };
}

function createReadFileTool(): Tool<{ path: string }> {
  return {
    name: 'read_file',
    description: 'Read a file',
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
        content: `read:${input.path}`
      };
    }
  };
}

function createPromptCliTestHarness(options: {
  cwd: string;
  runTurn: NonNullable<Parameters<typeof buildCli>[0]>['runTurn'];
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}): { writes: string[]; cli: ReturnType<typeof buildCli> } {
  const writes: string[] = [];
  const stdout = options.stdout ?? {
    write(chunk: string | Uint8Array) {
      writes.push(String(chunk));
      return true;
    }
  };

  return {
    writes,
    cli: buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: options.cwd,
      stdout,
      createRuntime: (runtimeOptions) => createTestRuntime(options.cwd, runtimeOptions.observer),
      runTurn: options.runTurn
    })
  };
}

function expectExactlyOneBlankLineBeforeEachAssistantBlock(output: string): void {
  const assistantBlockLabel = 'QiClaw';
  let blockIndex = output.indexOf(assistantBlockLabel);
  let isFirstBlock = true;

  while (blockIndex !== -1) {
    if (isFirstBlock) {
      expect(output.slice(0, blockIndex)).toBe('\n');
      isFirstBlock = false;
    } else {
      expect(output.slice(blockIndex - 2, blockIndex)).toBe('\n\n');
      expect(output[blockIndex - 3]).not.toBe('\n');
    }

    blockIndex = output.indexOf(assistantBlockLabel, blockIndex + assistantBlockLabel.length);
  }
}

function expectRenderedCliOutput(writes: string[], expectedOutput: string): void {
  const output = writes.join('');
  expect(output).toBe(expectedOutput);
  expectExactlyOneBlankLineBeforeEachAssistantBlock(output);
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

function renderTerminalTranscript(output: string): string {
  const normalizedOutput = stripAnsi(output);
  const lines: string[] = [];
  let currentLine = '';

  for (let index = 0; index < normalizedOutput.length; index += 1) {
    const character = normalizedOutput[index];

    if (character === '\u001b') {
      const sequence = normalizedOutput.slice(index);
      if (sequence.startsWith('\u001b[1A\u001b[2K')) {
        if (currentLine.length > 0) {
          currentLine = '';
        } else if (lines.length > 0) {
          lines.pop();
        }
        index += '\u001b[1A\u001b[2K'.length - 1;
        continue;
      }
      continue;
    }

    if (character === '\n') {
      lines.push(currentLine);
      currentLine = '';
      continue;
    }

    currentLine += character;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return `${lines.join('\n')}${normalizedOutput.endsWith('\n') ? '\n' : ''}`;
}

function expectTopLevelResponding(output: string): void {
  const normalizedOutput = renderTerminalTranscript(output);
  expect(normalizedOutput).toMatch(/(?:^|\n)✓ Responding\n/);
  expect(normalizedOutput).not.toContain('  ✓ Responding\n');
}

function expectContainsInOrder(text: string, markers: string[]): void {
  let cursor = 0;

  for (const marker of markers) {
    const index = text.indexOf(marker, cursor);
    expect(index, `Expected marker in order: ${marker}`).toBeGreaterThanOrEqual(cursor);
    cursor = index + marker.length;
  }
}

describe('createSuccessfulRunTurn', () => {
  it('returns a result compatible with CliRunTurnResult literal requirements', async () => {
    const runTurn = createSuccessfulRunTurn();
    const result: CliRunTurnResult = await runTurn({ userInput: 'inspect package.json' });

    expect(result.doneCriteria.requiresNonEmptyFinalAnswer).toBe(true);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createRepl', () => {
  it('runs one turn and returns the assistant text', async () => {
    const repl = createRepl({
      promptLabel: '> ',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `echo: ${input}`,
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        }
      }),
      readLine: async () => undefined,
      writeLine() {}
    });

    await expect(repl.runOnce('hello')).resolves.toEqual({
      finalAnswer: 'echo: hello',
      stopReason: 'completed'
    });
  });

  it('forwards turn stream events before returning the final result', async () => {
    const observedEvents: TurnEvent[] = [];
    const turnEvents: TurnEvent[] = [
      { type: 'turn_started' },
      { type: 'assistant_text_delta', text: 'Thinking...' },
      {
        type: 'turn_completed',
        finalAnswer: 'echo: hello',
        stopReason: 'completed',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: 'hello',
          checklist: ['hello'],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        turnCompleted: true
      }
    ];
    const callOrder: string[] = [];
    const repl = createRepl({
      promptLabel: '> ',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `echo: ${input}`,
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* () {
          for (const event of turnEvents) {
            callOrder.push(`stream:${event.type}`);
            yield event;
          }
        })()
      }),
      onTurnEvent(event) {
        callOrder.push(`event:${event.type}`);
        observedEvents.push(event);
      },
      readLine: async () => undefined,
      writeLine() {}
    });

    const result = await repl.runOnce('hello');

    expect(observedEvents).toEqual(turnEvents);
    expect(callOrder).toEqual([
      'stream:turn_started',
      'event:turn_started',
      'stream:assistant_text_delta',
      'event:assistant_text_delta',
      'stream:turn_completed',
      'event:turn_completed'
    ]);
    expect(result).toEqual({
      finalAnswer: 'echo: hello',
      stopReason: 'completed'
    });
  });

  it('awaits async turn event callbacks before returning the final result', async () => {
    const turnEvents: TurnEvent[] = [
      { type: 'turn_started' },
      { type: 'assistant_text_delta', text: 'Thinking...' }
    ];
    const callOrder: string[] = [];
    const repl = createRepl({
      promptLabel: '> ',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `echo: ${input}`,
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* () {
          for (const event of turnEvents) {
            callOrder.push(`stream:${event.type}`);
            yield event;
          }
        })()
      }),
      async onTurnEvent(event) {
        callOrder.push(`event:start:${event.type}`);
        await Promise.resolve();
        callOrder.push(`event:end:${event.type}`);
      },
      readLine: async () => undefined,
      writeLine() {}
    });

    const result = await repl.runOnce('hello');
    callOrder.push('runOnce:resolved');

    expect(callOrder).toEqual([
      'stream:turn_started',
      'event:start:turn_started',
      'event:end:turn_started',
      'stream:assistant_text_delta',
      'event:start:assistant_text_delta',
      'event:end:assistant_text_delta',
      'runOnce:resolved'
    ]);
    expect(result).toEqual({
      finalAnswer: 'echo: hello',
      stopReason: 'completed'
    });
  });

  it('consumes finalResult rejection when the stream throws after turn_failed', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const finalResult = Promise.reject(new Error('final result rejected after stream failure'));
      const repl = createRepl({
        promptLabel: '> ',
        runTurn: async () => ({
          stopReason: 'completed',
          finalAnswer: '',
          toolRoundsUsed: 0,
          verification: {
            isVerified: false,
            finalAnswerIsNonEmpty: false,
            finalAnswerIsSubstantive: false,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: false,
            toolMessagesCount: 0,
            checks: []
          },
          turnStream: (async function* () {
            yield { type: 'turn_started' } satisfies TurnEvent;
            yield {
              type: 'turn_failed',
              error: new Error('stream failed first')
            } satisfies TurnEvent;
            throw new Error('stream failed first');
          })(),
          finalResult
        }),
        readLine: async () => undefined,
        writeLine() {}
      });

      await expect(repl.runOnce('hello')).rejects.toMatchObject({
        message: 'stream failed first',
        replTurnErrorRendered: true
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('tracks telemetry metrics deterministically from loop-level events', () => {
    const metrics = createInMemoryMetricsObserver();

    metrics.record(createTelemetryEvent('turn_started', 'input_received', {
      turnId: 'turn-1',
      providerRound: 0,
      toolRound: 0,
      cwd: '/tmp/workspace',
      userInput: 'hello',
      maxToolRounds: 3,
      toolNames: []
    }));
    metrics.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'read_file',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: '{}',
      resultRawRedacted: {},
      durationMs: 1,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));
    metrics.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      stopReason: 'completed',
      toolRoundsUsed: 1,
      isVerified: true,
      durationMs: 5
    }));

    expect(metrics.snapshot()).toEqual({
      turnsStarted: 1,
      turnsCompleted: 1,
      turnsFailed: 0,
      totalToolCallsCompleted: 1,
      lastTurnDurationMs: expect.any(Number)
    });
  });

  it('runs an interactive loop until the exit command is entered', async () => {
    const outputs: string[] = [];
    const inputs = ['first question', '/exit'];
    const repl = createRepl({
      promptLabel: '> ',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `answer: ${input}`,
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        }
      }),
      readLine: async () => inputs.shift(),
      writeLine(text) {
        outputs.push(text);
      }
    });

    await expect(repl.runInteractive()).resolves.toBe(0);
    expect(outputs).toEqual(['answer: first question', 'Goodbye.']);
  });

  it('shows help commands without calling runTurn', async () => {
    const outputs: string[] = [];
    const runTurn = vi.fn(async (input: string) => ({
      stopReason: 'completed' as const,
      finalAnswer: `answer: ${input}`,
      toolRoundsUsed: 0,
      verification: {
        isVerified: true,
        finalAnswerIsNonEmpty: true,
        finalAnswerIsSubstantive: true,
        toolEvidenceSatisfied: true,
        noUnresolvedToolErrors: true,
        toolMessagesCount: 0,
        checks: []
      }
    }));
    const inputs = ['/help', '/exit'];
    const repl = createRepl({
      promptLabel: '> ',
      runTurn,
      readLine: async () => inputs.shift(),
      writeLine(text) {
        outputs.push(text);
      }
    });

    await expect(repl.runInteractive()).resolves.toBe(0);
    expect(runTurn).not.toHaveBeenCalled();
    expect(outputs).toEqual([
      'Commands: /help, /multiline, /skills, /exit',
      'Goodbye.'
    ]);
  });

  it('combines continued input lines into one multiline turn', async () => {
    const outputs: string[] = [];
    const runTurn = vi.fn(async (input: string) => ({
      stopReason: 'completed' as const,
      finalAnswer: `answer: ${JSON.stringify(input)}`,
      toolRoundsUsed: 0,
      verification: {
        isVerified: true,
        finalAnswerIsNonEmpty: true,
        finalAnswerIsSubstantive: true,
        toolEvidenceSatisfied: true,
        noUnresolvedToolErrors: true,
        toolMessagesCount: 0,
        checks: []
      }
    }));
    const inputs = ['/multiline', 'first line', 'second line', '/send', '/exit'];
    const repl = createRepl({
      promptLabel: '> ',
      runTurn,
      readLine: async () => inputs.shift(),
      writeLine(text) {
        outputs.push(text);
      }
    });

    await expect(repl.runInteractive()).resolves.toBe(0);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith('first line\nsecond line');
    expect(outputs).toEqual([
      'Multiline mode on. Enter /send to submit or /cancel to discard.',
      'answer: "first line\\nsecond line"',
      'Goodbye.'
    ]);
  });

  it('renders interactive turns as an indented QiClaw block with a non-indented footer', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: '/tmp/qiclaw-interactive-layout',
      readLine: (() => {
        const inputs = ['first question', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-interactive-layout',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));
        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'tool_use',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          responseContentBlockCount: 1,
          toolCallCount: 1,
          hasTextOutput: false,
          responseContentBlocksByType: { tool_use: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
          providerStopDetails: { stop_reason: 'tool_use' },
          responsePreviewRedacted: '[{"type":"tool_use"}]',
          durationMs: 20
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell_readonly',
          toolCallId: 'toolu_1',
          inputPreview: '{"command":"git","args":["status"]}',
          inputRawRedacted: { command: 'git', args: ['status'] }
        }));
        input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          stopReason: 'completed',
          toolRoundsUsed: 1,
          isVerified: true,
          durationMs: 4800
        }));
        input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          providerRounds: 2,
          toolRoundsUsed: 1,
          toolCallsTotal: 1,
          toolCallsByName: { shell_readonly: 1 },
          inputTokensTotal: 516,
          outputTokensTotal: 274,
          cacheReadInputTokens: 0,
          promptCharsMax: 100,
          toolResultCharsInFinalPrompt: 0,
          assistantToolCallCharsInFinalPrompt: 0,
          toolResultPromptGrowthCharsTotal: 0,
          toolResultCharsAddedAcrossTurn: 0,
          turnCompleted: true,
          stopReason: 'completed'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: 'Tôi sẽ kiểm tra trước.\n\nTóm tắt:\n- xong',
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '\n🧠 Thinking.\n',
      '✓ Responding\n',
      '──────────────────────────────────────────────────────\n\nTôi sẽ kiểm tra trước.\n\nTóm tắt:\n- xong\n',
      '──────────────────────────────────────────────────────\n',
      '✔ DONE • 2 provider • 1 tools • 516 in / 274 out • ⏱️4.8s\n\n',
      'Goodbye.\n'
    ]);
    expect(output).not.toContain(' ✦ shell:read git status\n');
  });

  it('keeps exactly one blank line before each assistant block across interactive turns', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: '/tmp/qiclaw-interactive-multi-turn-layout',
      readLine: (() => {
        const inputs = ['first question', 'second question', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-interactive-multi-turn-layout',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: createSuccessfulRunTurn()
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '\n──────────────────────────────────────────────────────\n\nhandled: first question\n',
      '\n──────────────────────────────────────────────────────\n\nhandled: second question\n',
      'Goodbye.\n'
    ]);
  });
});

describe('buildCli', () => {
  it('passes runtime resolvedPackage through prompt-mode turn execution during the bridge phase', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-resolved-package-prompt-'));
    tempDirs.push(tempDir);

    let observedResolvedPackage: ResolvedAgentPackage | undefined;
    const runtimeResolvedPackage = createBridgeResolvedPackage({
      maxToolRounds: 7,
      includeMemory: false,
      requiresToolEvidence: false
    });
    const { cli } = createPromptCliTestHarness({
      cwd: tempDir,
      runTurn: async (input) => {
        observedResolvedPackage = input.resolvedPackage;

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      },
      stdout: {
        write() {
          return true;
        }
      }
    });

    const cliWithResolvedPackage = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => createTestRuntime(tempDir, runtimeOptions.observer, {
        resolvedPackage: runtimeResolvedPackage,
        maxToolRounds: 7
      }),
      runTurn: async (input) => {
        observedResolvedPackage = input.resolvedPackage;

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cliWithResolvedPackage.run()).resolves.toBe(0);
    expect(observedResolvedPackage).toBe(runtimeResolvedPackage);
    expect(observedResolvedPackage?.effectivePolicy.maxToolRounds).toBe(7);
    void cli;
  });

  it('keeps prompt mode output compact with safe summaries when tool telemetry events are recorded', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-telemetry-'));
    tempDirs.push(tempDir);

    const { writes, cli } = createPromptCliTestHarness({
      cwd: tempDir,
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_1',
          inputPreview: '{"path":"/tmp/package.json"}',
          inputRawRedacted: { path: '/tmp/package.json', raw: 'secret payload' }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'edit_file',
          toolCallId: 'toolu_2',
          inputPreview: '{"path":"/tmp/package.json"}',
          inputRawRedacted: {
            path: '/tmp/package.json',
            oldText: 'secret old text',
            newText: 'secret new text'
          }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'search',
          toolCallId: 'toolu_3',
          inputPreview: '{"query":"package"}',
          inputRawRedacted: { query: 'package' }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_1',
          isError: false,
          resultPreview: '{"name":"secret"}',
          resultRawRedacted: { content: '{"name":"secret"}' },
          durationMs: 1,
          resultSizeChars: 17,
          resultSizeBucket: 'small'
        }));

        expect(writes.join('')).not.toContain('handled: inspect package.json');

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = writes.join('');
    expectContainsInOrder(output, [
      '\nQiClaw\n',
      '  handled: inspect package.json\n'
    ]);
    expect(output).toContain('  · read_file /tmp/package.json\n');
    expect(output).toContain('  · edit_file /tmp/package.json\n');
    expect(output).toContain('  · search package\n');
    expect(output).toContain('  · read_file /tmp/package.json | done (1ms)\n');
    expectExactlyOneBlankLineBeforeEachAssistantBlock(output);
    expect(output).not.toContain('Tool: Read');
    expect(output).not.toContain('secret payload');
    expect(output).not.toContain('secret old text');
    expect(output).not.toContain('secret new text');
    expect(output).not.toContain('{"name":"secret"}');
  });

  it('renders tool status immediately before final answer in prompt mode', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-telemetry-immediate-'));
    tempDirs.push(tempDir);

    const { writes, cli } = createPromptCliTestHarness({
      cwd: tempDir,
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell_exec',
          toolCallId: 'toolu_1',
          inputPreview: '{"command":"pwd"}',
          inputRawRedacted: { command: 'pwd' }
        }));

        expect(writes.join('')).not.toContain('handled: inspect package.json');

        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell_exec',
          toolCallId: 'toolu_1',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 11,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));

        expect(writes.join('')).not.toContain('handled: inspect package.json');

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
  });

  it('replaces the active tool line immediately on TTY output', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-telemetry-tty-'));
    tempDirs.push(tempDir);

    const writes: string[] = [];
    const { cli } = createPromptCliTestHarness({
      cwd: tempDir,
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell_exec',
          toolCallId: 'toolu_1',
          inputPreview: '{"command":"pwd"}',
          inputRawRedacted: { command: 'pwd' }
        }));

        expect(writes.join('')).not.toContain('handled: inspect package.json');

        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell_exec',
          toolCallId: 'toolu_1',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 11,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));

        expect(writes.join('')).not.toContain('handled: inspect package.json');

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
  });

  async function runInteractiveCompletionPlacementScenario(stdout: Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean }): Promise<string[]> {
    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: '/tmp/qiclaw-interactive-tool-placement',
      readLine: (() => {
        const inputs = ['inspect package.json', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        ...stdout,
        write(chunk) {
          writes.push(String(chunk));
          return stdout.write(chunk);
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-interactive-tool-placement',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));
        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'tool_use',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          responseContentBlockCount: 1,
          toolCallCount: 2,
          hasTextOutput: false,
          responseContentBlocksByType: { tool_use: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
          providerStopDetails: { stop_reason: 'tool_use' },
          responsePreviewRedacted: '[{"type":"tool_use"}]',
          durationMs: 20
        }));

        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_1',
          inputPreview: '{"path":"src/cli/main.ts"}',
          inputRawRedacted: { path: 'src/cli/main.ts' }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'search',
          toolCallId: 'toolu_2',
          inputPreview: '{"pattern":"promptLabel"}',
          inputRawRedacted: { pattern: 'promptLabel' }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_1',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 5,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));
        input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          stopReason: 'completed',
          toolRoundsUsed: 1,
          isVerified: true,
          durationMs: 4800
        }));
        input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          providerRounds: 1,
          toolRoundsUsed: 1,
          toolCallsTotal: 2,
          toolCallsByName: { read_file: 1, search: 1 },
          inputTokensTotal: 185,
          outputTokensTotal: 15,
          cacheReadInputTokens: 0,
          promptCharsMax: 100,
          toolResultCharsInFinalPrompt: 0,
          assistantToolCallCharsInFinalPrompt: 0,
          toolResultPromptGrowthCharsTotal: 0,
          toolResultCharsAddedAcrossTurn: 0,
          turnCompleted: true,
          stopReason: 'completed'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 2,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    return writes;
  }

  it('renders git and web_fetch tool activity in prompt transcript while preserving footer counts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-git-web-'));
    tempDirs.push(tempDir);

    const { writes, cli } = createPromptCliTestHarness({
      cwd: tempDir,
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: ['git', 'web_fetch']
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'git',
          toolCallId: 'toolu_git',
          inputPreview: '{"args":["status","--short"]}',
          inputRawRedacted: { args: ['status', '--short'] }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'git',
          toolCallId: 'toolu_git',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 11,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 1,
          messageCount: 4,
          promptRawChars: 84,
          toolNames: ['git', 'web_fetch']
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 2,
          toolName: 'web_fetch',
          toolCallId: 'toolu_web',
          inputPreview: '{"url":"https://example.com/docs"}',
          inputRawRedacted: { url: 'https://example.com/docs', prompt: 'secret prompt text' }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 2,
          toolName: 'web_fetch',
          toolCallId: 'toolu_web',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 13,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));
        input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 2,
          stopReason: 'completed',
          toolRoundsUsed: 2,
          isVerified: true,
          durationMs: 6300
        }));
        input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 2,
          providerRounds: 2,
          toolRoundsUsed: 2,
          toolCallsTotal: 2,
          toolCallsByName: { git: 1, web_fetch: 1 },
          inputTokensTotal: 185,
          outputTokensTotal: 15,
          cacheReadInputTokens: 0,
          promptCharsMax: 100,
          toolResultCharsInFinalPrompt: 0,
          assistantToolCallCharsInFinalPrompt: 0,
          toolResultPromptGrowthCharsTotal: 0,
          toolResultCharsAddedAcrossTurn: 0,
          turnCompleted: true,
          stopReason: 'completed'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 2,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 2,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = writes.join('');
    expectContainsInOrder(output, [
      '\nQiClaw\n',
      '✓ Responding\n',
      '  · git status --short | done (11ms)\n',
      '✓ Responding\n',
      '  · web fetch https://example.com/docs | done (13ms)\n',
      '  handled: inspect package.json\n'
    ]);
    expect(output).not.toContain('secret prompt text');
    expect(output).toContain('─ completed • verified • 2 provider • 2 tool round • 2 tools • 185 in / 15 out • 6.3s\n\n');
  });

  it('inserts interactive completion below the matching tool line on TTY output', async () => {
    const writes = await runInteractiveCompletionPlacementScenario({
      isTTY: true,
      write() {
        return true;
      }
    } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean });

    const transcript = renderTerminalTranscript(writes.join(''));
    expect(transcript).toContain('✓ Responding\n');
    expect(transcript).toContain('──────────────────────────────────────────────────────\n\nhandled: inspect package.json\n');
    expect(transcript).not.toContain(' ✦ read src/cli/main.ts\n');
  });

  it('does not animate interactive tool lines in non-tty output', async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: '/tmp/qiclaw-interactive-tool-non-tty',
      readLine: (() => {
        const inputs = ['inspect package.json', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        isTTY: false,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-interactive-tool-non-tty',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));
        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'tool_use',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          responseContentBlockCount: 1,
          toolCallCount: 1,
          hasTextOutput: false,
          responseContentBlocksByType: { tool_use: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
          providerStopDetails: { stop_reason: 'tool_use' },
          responsePreviewRedacted: '[{"type":"tool_use"}]',
          durationMs: 20
        }));
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_non_tty',
          inputPreview: '{"path":"src/cli/main.ts"}',
          inputRawRedacted: { path: 'src/cli/main.ts' }
        }));

        await vi.advanceTimersByTimeAsync(240);

        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_non_tty',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 5,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = stripAnsi(writes.join(''));
    expect(output).not.toContain(' ✧ ');
    expect(output).not.toContain(' ✱ ');
    expect(output).not.toContain(' ✲ ');
    expect(output).not.toContain(' ✳ ');
    expect(output).not.toContain(' ✴ ');
    expect(output).not.toContain(' ✦ read src/cli/main.ts\n');
  });

  it('rewrites the active interactive tool line multiple times on TTY while a tool is still running', async () => {
    vi.useFakeTimers();

    let moveCursorCalls = 0;
    let clearLineCalls = 0;
    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: '/tmp/qiclaw-interactive-tool-tty-rewrite-count',
      readLine: (() => {
        const inputs = ['inspect package.json', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        },
        moveCursor() {
          moveCursorCalls += 1;
          return true;
        },
        clearLine() {
          clearLineCalls += 1;
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write' | 'moveCursor' | 'clearLine'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-interactive-tool-tty-rewrite-count',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell',
          toolCallId: 'toolu_tty_rewrite',
          inputPreview: '{"command":"npm","args":["test"]}',
          inputRawRedacted: { command: 'npm', args: ['test'] }
        }));

        await vi.advanceTimersByTimeAsync(INTERACTIVE_PULSE_SETTLE_MS);

        input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell',
          toolCallId: 'toolu_tty_rewrite',
          isError: false,
          resultPreview: 'ok',
          resultRawRedacted: { content: 'ok' },
          durationMs: 5,
          resultSizeChars: 2,
          resultSizeBucket: 'small'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    expect(writes.join('')).toContain('\u001b[1A\u001b[2K');
    expect(moveCursorCalls).toBe(0);
    expect(clearLineCalls).toBe(0);
    expect(stripAnsi(writes.join(''))).toContain(' ✦ shell npm test\n');
  });

  it('prefers --debug-log over QICLAW_DEBUG_LOG and writes JSONL events to a day-scoped file derived from the selected path', async () => {
    await withProviderEnvSnapshot(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-12T08:00:00.000Z'));

      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-debug-log-'));
      tempDirs.push(tempDir);

      const envLogPath = join(tempDir, 'from-env', 'telemetry.jsonl');
      const flagLogPath = join(tempDir, 'from-flag', 'telemetry.jsonl');
      const rotatedFlagLogPath = join(tempDir, 'from-flag', 'telemetry-2026-04-12.jsonl');
      process.env.QICLAW_DEBUG_LOG = envLogPath;

      const cli = buildCli({
        argv: ['--debug-log', flagLogPath, '--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: createNoopTestProvider(),
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? createNoopObserver(),
            systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
            turnId: 'turn-1',
            providerRound: 1,
            toolRound: 1,
            toolName: 'Read',
            toolCallId: 'toolu_1',
            inputPreview: '{}',
            inputRawRedacted: {}
          }));

          return {
            stopReason: 'completed',
            finalAnswer: `handled: ${input.userInput}`,
            history: [],
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 1,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(rotatedFlagLogPath, 'utf8');
      expect(selectedLog).toContain('"type":"tool_call_started"');
      await expect(readFile(flagLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(envLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('writes memory_candidates records into the selected debug JSONL file', async () => {
    await withProviderEnvSnapshot(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));

      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-memory-candidates-log-'));
      tempDirs.push(tempDir);

      const debugLogPath = join(tempDir, 'debug', 'telemetry.jsonl');
      const rotatedLogPath = join(tempDir, 'debug', 'telemetry-2026-04-12.jsonl');

      const cli = buildCli({
        argv: ['--debug-log', debugLogPath],
        cwd: tempDir,
        createSessionId: () => 'session-memory-debug',
        readLine: (() => {
          const inputs = ['remember my language preference', '/exit'];
          return async () => inputs.shift();
        })(),
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: createNoopTestProvider(),
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? createNoopObserver(),
          resolvedPackage: defaultResolvedPackage,
          systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        prepareSessionMemory: async () => ({
          memoryText: '',
          store: {} as never,
          globalStore: undefined,
          recalled: [],
          checkpointState: {
            storeSessionId: 'session-memory-debug',
            engine: 'file-session-memory-store',
            version: 1,
            memoryPath: '/tmp/memory/index.json',
            metaPath: '/tmp/memory/meta.json',
            totalEntries: 0,
            lastCompactedAt: null
          }
        }),
        captureTurnMemory: async () => ({
          saved: false,
          checkpointState: {
            storeSessionId: 'session-memory-debug',
            engine: 'file-session-memory-store',
            version: 1,
            memoryPath: '/tmp/memory/index.json',
            metaPath: '/tmp/memory/meta.json',
            totalEntries: 0,
            lastCompactedAt: null
          }
        }),
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: 'Tôi sẽ trả lời bằng tiếng Việt.',
          history: [
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'Tôi sẽ trả lời bằng tiếng Việt.' }
          ],
          memoryCandidates: [
            {
              operation: 'create',
              target_memory_ids: '',
              kind: 'fact',
              title: 'User prefers Vietnamese',
              summary: 'Always answer in Vietnamese unless explicitly asked otherwise.',
              keywords: 'language | vietnamese | preference',
              confidence: 0.94,
              durability: 'durable',
              speculative: false,
              novelty_basis: 'User explicitly stated this preference in the current turn.'
            }
          ],
          structuredOutputParsed: true,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(rotatedLogPath, 'utf8');
      expect(selectedLog).toContain('"type":"memory_candidates"');
      expect(selectedLog).toContain('"sessionId":"session-memory-debug"');
      expect(selectedLog).toContain('"title":"User prefers Vietnamese"');
      expect(selectedLog).toContain('"parsed":true');
      expect(selectedLog).toContain('"parseFallbackUsed":false');
    });
  });

  it('logs parsed true with zero candidates when structured output parsing succeeded', async () => {
    await withProviderEnvSnapshot(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-12T10:30:00.000Z'));

      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-memory-candidates-empty-log-'));
      tempDirs.push(tempDir);

      const debugLogPath = join(tempDir, 'debug', 'telemetry.jsonl');
      const rotatedLogPath = join(tempDir, 'debug', 'telemetry-2026-04-12.jsonl');

      const cli = buildCli({
        argv: ['--debug-log', debugLogPath],
        cwd: tempDir,
        createSessionId: () => 'session-memory-debug-empty',
        readLine: (() => {
          const inputs = ['remember my language preference', '/exit'];
          return async () => inputs.shift();
        })(),
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: createNoopTestProvider(),
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? createNoopObserver(),
          resolvedPackage: defaultResolvedPackage,
          systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        prepareSessionMemory: async () => ({
          memoryText: '',
          store: {} as never,
          globalStore: undefined,
          recalled: [],
          checkpointState: {
            storeSessionId: 'session-memory-debug-empty',
            engine: 'file-session-memory-store',
            version: 1,
            memoryPath: '/tmp/memory/index.json',
            metaPath: '/tmp/memory/meta.json',
            totalEntries: 0,
            lastCompactedAt: null
          }
        }),
        captureTurnMemory: async () => ({
          saved: false,
          checkpointState: {
            storeSessionId: 'session-memory-debug-empty',
            engine: 'file-session-memory-store',
            version: 1,
            memoryPath: '/tmp/memory/index.json',
            metaPath: '/tmp/memory/meta.json',
            totalEntries: 0,
            lastCompactedAt: null
          }
        }),
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: 'Đã hiểu.',
          history: [
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'Đã hiểu.' }
          ],
          memoryCandidates: [],
          structuredOutputParsed: true,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(rotatedLogPath, 'utf8');
      expect(selectedLog).toContain('"type":"memory_candidates"');
      expect(selectedLog).toContain('"sessionId":"session-memory-debug-empty"');
      expect(selectedLog).toContain('"count":0');
      expect(selectedLog).toContain('"parsed":true');
      expect(selectedLog).toContain('"parseFallbackUsed":false');
    });
  });
  it('falls back to QICLAW_DEBUG_LOG and writes to a day-scoped file when --debug-log is not provided', async () => {
    await withProviderEnvSnapshot(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-12T09:00:00.000Z'));

      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-debug-log-env-'));
      tempDirs.push(tempDir);

      const envLogPath = join(tempDir, 'from-env', 'telemetry.jsonl');
      const rotatedEnvLogPath = join(tempDir, 'from-env', 'telemetry-2026-04-12.jsonl');
      process.env.QICLAW_DEBUG_LOG = envLogPath;

      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: createNoopTestProvider(),
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? createNoopObserver(),
            systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('turn_started', 'input_received', {
            turnId: 'turn-1',
            providerRound: 0,
            toolRound: 0,
            cwd: tempDir,
            userInput: input.userInput,
            maxToolRounds: 3,
            toolNames: []
          }));

          return {
            stopReason: 'completed',
            finalAnswer: `handled: ${input.userInput}`,
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(rotatedEnvLogPath, 'utf8');
      expect(selectedLog).toContain('"type":"turn_started"');
      await expect(readFile(envLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('records provider telemetry events to the day-scoped debug JSONL log without changing prompt-mode stdout', async () => {
    await withProviderEnvSnapshot(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-31T12:34:56.000Z'));

      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-debug-log-'));
      tempDirs.push(tempDir);

      const logPath = join(tempDir, 'provider', 'telemetry.jsonl');
      const rotatedLogPath = join(tempDir, 'provider', 'telemetry-2026-03-31.jsonl');
      const stdoutWrites: string[] = [];
      const cli = buildCli({
        argv: ['--debug-log', logPath, '--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: {
          write(chunk) {
            stdoutWrites.push(String(chunk));
            return true;
          }
        },
        createRuntime: (runtimeOptions) => ({
          provider: createNoopTestProvider(),
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? createNoopObserver(),
            systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
            turnId: 'turn-1',
            providerRound: 1,
            toolRound: 0,
            messageCount: 2,
            promptRawChars: 42,
            toolNames: ['Read'],
            messageSummaries: [
              {
                role: 'system',
                rawChars: 67,
                contentBlockCount: 1,
                messageSource: 'system'
              },
              {
                role: 'user',
                rawChars: 40,
                contentBlockCount: 1,
                messageSource: 'user'
              }
            ],
            totalContentBlockCount: 2,
            hasSystemPrompt: true,
            promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
          }));
          input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
            turnId: 'turn-1',
            providerRound: 1,
            toolRound: 0,
            stopReason: 'end_turn',
            usage: {
              inputTokens: 12,
              outputTokens: 8,
              totalTokens: 20
            },
            responseContentBlockCount: 1,
            toolCallCount: 0,
            hasTextOutput: true,
            responseContentBlocksByType: { text: 1 },
            toolCallSummaries: [],
            providerUsageRawRedacted: {
              input_tokens: 12,
              output_tokens: 8
            },
            providerStopDetails: {
              stop_reason: 'end_turn'
            },
            responsePreviewRedacted: '[{"type":"text","text":"handled"}]',
            durationMs: 20
          }));

          return {
            stopReason: 'completed',
            finalAnswer: `handled: ${input.userInput}`,
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(rotatedLogPath, 'utf8');
      const events = selectedLog
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      const providerCalledEvent = events.find((event) => event.type === 'provider_called');
      const providerRespondedEvent = events.find((event) => event.type === 'provider_responded');

      expect(providerCalledEvent).toEqual(
        expect.objectContaining({
          type: 'provider_called',
          stage: 'provider_decision',
          timestamp: '2026-03-31T12:34:56.000Z',
          data: expect.objectContaining({
            promptRawChars: 42,
            turnId: 'turn-1'
          })
        })
      );
      expect(providerRespondedEvent).toEqual(
        expect.objectContaining({
          type: 'provider_responded',
          stage: 'provider_decision',
          timestamp: '2026-03-31T12:34:56.000Z',
          data: expect.objectContaining({
            usage: expect.objectContaining({
              totalTokens: 20
            }),
            responseContentBlockCount: 1,
            durationMs: 20
          })
        })
      );
      expectRenderedCliOutput(stdoutWrites, '\nQiClaw\n🧠 Thinking.\n✓ Responding\n  handled: inspect package.json\n');
    });
  });

  it('shows QiClaw and provider thinking immediately when provider_called is recorded', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-immediate',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-immediate',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));

        const outputAfterProviderCalled = writes.join('');
        expect(outputAfterProviderCalled).toContain('\nQiClaw\n🧠 Thinking.\n');
        expect(outputAfterProviderCalled).not.toContain('handled: inspect package.json');

        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'end_turn',
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20
          },
          responseContentBlockCount: 1,
          toolCallCount: 0,
          hasTextOutput: true,
          responseContentBlocksByType: { text: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: {
            input_tokens: 12,
            output_tokens: 8
          },
          providerStopDetails: {
            stop_reason: 'end_turn'
          },
          responsePreviewRedacted: '[{"type":"text","text":"handled"}]',
          durationMs: 20
        }));

        expectTopLevelResponding(writes.join(''));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = writes.join('');
    const normalizedOutput = stripAnsi(output);
    expectTopLevelResponding(output);
    expectContainsInOrder(normalizedOutput, [
      'QiClaw\n',
      '🧠 Thinking.\n',
      '✓ Responding\n',
      '  handled: inspect package.json\n'
    ]);
  });

  it('shows QiClaw only once and preserves one responding line per provider round in the same turn', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-multi-round',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-multi-round',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 6
      }),
      runTurn: async (input) => {
        for (let providerRound = 1; providerRound <= 5; providerRound += 1) {
          input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
            turnId: 'turn-1',
            providerRound,
            toolRound: providerRound - 1,
            messageCount: providerRound + 1,
            promptRawChars: 40 + providerRound,
            toolNames: providerRound === 1 ? [] : ['shell_readonly'],
            messageSummaries: [
              { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
              { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
            ],
            totalContentBlockCount: 2,
            hasSystemPrompt: true,
            promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
          }));
          input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
            turnId: 'turn-1',
            providerRound,
            toolRound: providerRound - 1,
            stopReason: providerRound === 5 ? 'end_turn' : 'tool_use',
            usage: { inputTokens: 10 + providerRound, outputTokens: 5 + providerRound, totalTokens: 15 + providerRound * 2 },
            responseContentBlockCount: 1,
            toolCallCount: providerRound === 5 ? 0 : 1,
            hasTextOutput: providerRound === 5,
            responseContentBlocksByType: providerRound === 5 ? { text: 1 } : { tool_use: 1 },
            toolCallSummaries: [],
            providerUsageRawRedacted: { input_tokens: 10 + providerRound, output_tokens: 5 + providerRound },
            providerStopDetails: { stop_reason: providerRound === 5 ? 'end_turn' : 'tool_use' },
            responsePreviewRedacted: providerRound === 5 ? '[{"type":"text","text":"handled"}]' : '[{"type":"tool_use"}]',
            durationMs: 20 + providerRound
          }));

          if (providerRound < 5) {
            input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
              turnId: 'turn-1',
              providerRound,
              toolRound: providerRound,
              toolName: 'shell_readonly',
              toolCallId: `call-${providerRound}`,
              inputPreview: '{"command":"git diff -- repl.ts"}',
              inputRawRedacted: { command: 'git diff -- repl.ts' }
            }));
            input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
              turnId: 'turn-1',
              providerRound,
              toolRound: providerRound,
              toolName: 'shell_readonly',
              toolCallId: `call-${providerRound}`,
              durationMs: 15,
              isError: false,
              resultPreview: '',
              resultRawRedacted: {},
              resultSizeChars: 0,
              resultSizeBucket: 'small'
            }));
          }
        }

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 4,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 4,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = writes.join('');
    const normalizedOutput = renderTerminalTranscript(output);
    expect(normalizedOutput.match(/(?:^|\n)QiClaw\n/g)).toHaveLength(1);
    expect(normalizedOutput.match(/(?:^|\n)✓ Responding\n/g)).toHaveLength(5);
    expect(normalizedOutput).not.toContain('  ✓ Responding\n');
    expectContainsInOrder(normalizedOutput, [
      'QiClaw\n',
      '✓ Responding\n',
      '  · shell_readonly git diff -- repl.ts | done',
      '✓ Responding\n',
      '  · shell_readonly git diff -- repl.ts | done',
      '✓ Responding\n',
      '  · shell_readonly git diff -- repl.ts | done',
      '✓ Responding\n',
      '  · shell_readonly git diff -- repl.ts | done',
      '✓ Responding\n',
      '  handled: inspect package.json\n'
    ]);
  });

  it('renders provider status at top level instead of indenting it into the assistant body', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-layout',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-layout',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));

        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          responseContentBlockCount: 1,
          toolCallCount: 0,
          hasTextOutput: true,
          responseContentBlocksByType: { text: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
          providerStopDetails: { stop_reason: 'end_turn' },
          responsePreviewRedacted: '[{"type":"text","text":"handled"}]',
          durationMs: 20
        }));

        return {
          stopReason: 'completed',
          finalAnswer: 'handled: inspect package.json',
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const transcript = stripAnsi(renderTerminalTranscript(writes.join('')));
    expectTopLevelResponding(transcript);
    expectContainsInOrder(transcript, [
      '\nQiClaw\n',
      '✓ Responding\n',
      '  handled: inspect package.json\n'
    ]);
  });

  it('transitions waiting provider status before rendering the footer', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-footer',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-footer',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));
        expect(stripAnsi(writes.join(''))).toContain('\nQiClaw\n🧠 Thinking.\n');
        input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          providerRounds: 1,
          toolRoundsUsed: 0,
          toolCallsTotal: 0,
          toolCallsByName: {},
          inputTokensTotal: 12,
          outputTokensTotal: 8,
          cacheReadInputTokens: 0,
          promptCharsMax: 42,
          toolResultCharsInFinalPrompt: 0,
          assistantToolCallCharsInFinalPrompt: 0,
          toolResultPromptGrowthCharsTotal: 0,
          toolResultCharsAddedAcrossTurn: 0,
          turnCompleted: true,
          stopReason: 'completed'
        }));
        input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'completed',
          toolRoundsUsed: 0,
          isVerified: true,
          durationMs: 5
        }));

        return {
          stopReason: 'completed',
          finalAnswer: '',
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: false,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = writes.join('');
    const normalizedOutput = stripAnsi(output);
    expectTopLevelResponding(output);
    expect(normalizedOutput).toContain('─ completed');
    expect(normalizedOutput.indexOf('✓ Responding\n')).toBeLessThan(normalizedOutput.indexOf('─ completed'));
  });
  it('preserves replacement semantics for provider status on tty without cursor controls', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-fallback-tty',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-fallback-tty',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));
        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          responseContentBlockCount: 1,
          toolCallCount: 0,
          hasTextOutput: true,
          responseContentBlocksByType: { text: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
          providerStopDetails: { stop_reason: 'end_turn' },
          responsePreviewRedacted: '[{"type":"text","text":"handled"}]',
          durationMs: 20
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const transcript = renderTerminalTranscript(writes.join(''));
    expect(transcript).not.toContain('🧠 Thinking.\n✓ Responding\n');
    expectContainsInOrder(transcript, [
      '\nQiClaw\n',
      '✓ Responding\n',
      '  handled: inspect package.json\n'
    ]);
  });

  it('replaces the previous thinking frame after the animation cycles back to Thinking. on fallback tty', async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-cycle-fallback-tty',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-cycle-fallback-tty',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));

        await vi.advanceTimersByTimeAsync(1600);

        input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          responseContentBlockCount: 1,
          toolCallCount: 0,
          hasTextOutput: true,
          responseContentBlocksByType: { text: 1 },
          toolCallSummaries: [],
          providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
          providerStopDetails: { stop_reason: 'end_turn' },
          responsePreviewRedacted: '[{"type":"text","text":"handled"}]',
          durationMs: 20
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const transcript = renderTerminalTranscript(writes.join(''));
    expect(transcript).not.toContain('🧠 Thinking...\n🧠 Thinking.\n');
    expect(transcript).not.toContain('🧠 Thinking.\n✓ Responding\n');
    expectContainsInOrder(transcript, [
      '\nQiClaw\n',
      '✓ Responding\n',
      '  handled: inspect package.json\n'
    ]);
  });

  it('cleans up provider thinking timers when a turn throws after provider_called', async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-error-cleanup',
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      stderr: {
        write() {
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-error-cleanup',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));

        throw new Error('turn failed');
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    const outputAfterFailure = writes.join('');
    await vi.advanceTimersByTimeAsync(1600);
    expect(writes.join('')).toBe(outputAfterFailure);
  });

  it('does not animate provider thinking frames in non-tty mode', async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-provider-thinking-non-tty',
      stdout: {
        isTTY: false,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & { isTTY: boolean },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-provider-thinking-non-tty',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 42,
          toolNames: [],
          messageSummaries: [
            { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
            { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
          ],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
        }));

        await vi.advanceTimersByTimeAsync(1600);

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = writes.join('');
    const thinkingFrames = output.match(/🧠 Thinking/g) ?? [];
    expect(thinkingFrames.length).toBeLessThanOrEqual(1);
    expect(output).not.toContain('\u001b[1A');
  });

  it('returns exit code 1 and prints an error when --debug-log is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--debug-log'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --debug-log\n']);
  });
  it('returns an object with a run method', () => {
    const cli = buildCli();

    expect(cli).toBeTypeOf('object');
    expect(cli.run).toBeTypeOf('function');
  });

  it('runs a prompt through the runtime turn runner and prints the final answer', async () => {
    await withProviderEnvSnapshot(async () => {
      delete process.env.MODEL;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_MODEL;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const writes: string[] = [];
      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: '/tmp/qiclaw-test',
        stdout: {
          write(chunk) {
            writes.push(String(chunk));
            return true;
          }
        },
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions.provider).toBe('openai');
          expect(runtimeOptions.model).toBe('gpt-4.1');

          return {
            provider: createNoopTestProvider(),
            availableTools: [],
            cwd: '/tmp/qiclaw-test',
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
      expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
    });
  });

  it('renders assistant text deltas live in prompt mode without duplicating the final block', async () => {
    const { writes, cli } = createPromptCliTestHarness({
      cwd: '/tmp/qiclaw-prompt-live-text',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'Xin chào',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          yield { type: 'assistant_text_delta', text: 'Xin ' } satisfies TurnEvent;
          expect(writes.join('')).toContain('\nQiClaw\n  Xin ');
          yield { type: 'assistant_text_delta', text: 'chào' } satisfies TurnEvent;
          yield {
            type: 'assistant_message_completed',
            text: 'Xin chào'
          } satisfies TurnEvent;
          yield {
            type: 'turn_completed',
            finalAnswer: 'Xin chào',
            stopReason: 'completed',
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          } satisfies TurnEvent;
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(0);
    expectRenderedCliOutput(writes, '\nQiClaw\n  Xin chào\n');
  });

  it('renders assistant text deltas live in interactive mode without duplicating the final block', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-live-text-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['live text please', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'Xin chào',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          yield { type: 'assistant_text_delta', text: 'Xin ' } satisfies TurnEvent;
          expect(stripAnsi(writes.join(''))).toContain(
            '└────────────────────────────────────────────────────┘\n\n──────────────────────────────────────────────────────\n\nXin '
          );
          yield { type: 'assistant_text_delta', text: 'chào' } satisfies TurnEvent;
          yield {
            type: 'assistant_message_completed',
            text: 'Xin chào'
          } satisfies TurnEvent;
          yield {
            type: 'turn_completed',
            finalAnswer: 'Xin chào',
            stopReason: 'completed',
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          } satisfies TurnEvent;
        })(),
        finalResult: Promise.resolve((() => {
          input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
            turnId: 'turn-live-text',
            providerRound: 1,
            toolRound: 0,
            stopReason: 'completed',
            toolRoundsUsed: 0,
            isVerified: true,
            durationMs: 1200
          }));
          input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
            turnId: 'turn-live-text',
            providerRound: 1,
            toolRound: 0,
            providerRounds: 1,
            toolRoundsUsed: 0,
            toolCallsTotal: 0,
            toolCallsByName: {},
            inputTokensTotal: 12,
            outputTokensTotal: 8,
            cacheReadInputTokens: 0,
            promptCharsMax: 42,
            toolResultCharsInFinalPrompt: 0,
            assistantToolCallCharsInFinalPrompt: 0,
            toolResultPromptGrowthCharsTotal: 0,
            toolResultCharsAddedAcrossTurn: 0,
            turnCompleted: true,
            stopReason: 'completed'
          }));

          return {
            stopReason: 'completed',
            finalAnswer: 'Xin chào',
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        })())
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '\n──────────────────────────────────────────────────────\n\nXin chào\n',
      '──────────────────────────────────────────────────────\n',
      '✔ DONE • 1 provider • 12 in / 8 out • ⏱️1.2s\n\n',
      'Goodbye.\n'
    ]);
    expect(output).not.toContain('Xin chàoGoodbye.\n');
  });

  it('keeps streamed interactive text visible on TTY output with cursor controls', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-live-text-tty-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['live text please', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        },
        moveCursor(dx, dy) {
          writes.push(`\u001b[${Math.abs(dy)}A`);
          return true;
        },
        clearLine() {
          writes.push('\u001b[2K');
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & {
        isTTY: boolean;
        moveCursor(dx: number, dy: number): boolean;
        clearLine(dir: -1 | 0 | 1): boolean;
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'Xin chào',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
            turnId: 'turn-tty-live-text',
            providerRound: 1,
            toolRound: 0,
            messageCount: 2,
            promptRawChars: 42,
            toolNames: [],
            messageSummaries: [
              { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
              { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
            ],
            totalContentBlockCount: 2,
            hasSystemPrompt: true,
            promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
          }));
          yield { type: 'assistant_text_delta', text: 'Xin ' } satisfies TurnEvent;
          yield { type: 'assistant_text_delta', text: 'chào' } satisfies TurnEvent;
          yield {
            type: 'assistant_message_completed',
            text: 'Xin chào'
          } satisfies TurnEvent;
          yield {
            type: 'turn_completed',
            finalAnswer: 'Xin chào',
            stopReason: 'completed',
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          } satisfies TurnEvent;
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = stripAnsi(renderTerminalTranscript(writes.join('')));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '✓ Responding\n',
      'Xin chào\n',
      'Goodbye.\n'
    ]);
  });

  it('keeps both streamed interactive text segments around later tool activity on TTY output', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-text-tool-text-tool-tty-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['trace transcript please', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        },
        moveCursor(dx, dy) {
          writes.push(`\u001b[${Math.abs(dy)}A`);
          return true;
        },
        clearLine() {
          writes.push('\u001b[2K');
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write'> & {
        isTTY: boolean;
        moveCursor(dx: number, dy: number): boolean;
        clearLine(dir: -1 | 0 | 1): boolean;
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'Alpha text\nBeta text\n',
        history: [],
        toolRoundsUsed: 2,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 2,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
            turnId: 'turn-tty-text-tool-text-tool',
            providerRound: 1,
            toolRound: 0,
            messageCount: 2,
            promptRawChars: 42,
            toolNames: [],
            messageSummaries: [
              { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
              { role: 'user', rawChars: 24, contentBlockCount: 1, messageSource: 'user' }
            ],
            totalContentBlockCount: 2,
            hasSystemPrompt: true,
            promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
          }));
          yield { type: 'assistant_text_delta', text: 'Alpha text\n' } satisfies TurnEvent;
          yield {
            type: 'tool_call_started',
            id: 'toolu_1',
            name: 'file',
            input: { action: 'read', path: 'src/alpha.ts' }
          } satisfies TurnEvent;
          yield {
            type: 'tool_call_completed',
            id: 'toolu_1',
            name: 'file',
            resultPreview: 'alpha result',
            isError: false
          } satisfies TurnEvent;
          yield { type: 'assistant_text_delta', text: 'Beta text\n' } satisfies TurnEvent;
          yield {
            type: 'tool_call_started',
            id: 'toolu_2',
            name: 'shell',
            input: { command: 'pwd' }
          } satisfies TurnEvent;
          yield {
            type: 'tool_call_completed',
            id: 'toolu_2',
            name: 'shell',
            resultPreview: 'pwd result',
            isError: false
          } satisfies TurnEvent;
          yield {
            type: 'assistant_message_completed',
            text: 'Alpha text\nBeta text\n'
          } satisfies TurnEvent;
          yield {
            type: 'turn_completed',
            finalAnswer: 'Alpha text\nBeta text\n',
            stopReason: 'completed',
            history: [],
            toolRoundsUsed: 2,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          } satisfies TurnEvent;
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const transcript = stripAnsi(renderTerminalTranscript(writes.join('')));
    expect(transcript).toContain('  alpha result\n');
    expect(transcript).toContain(' └─ ✔ Success\n');
    expect(transcript).toContain('  pwd result\n');
    expectContainsInOrder(transcript, [
      '✓ Responding\n',
      '──────────────────────────────────────────────────────\n\n',
      'Alpha text\n',
      ' ✦ file read src/alpha.ts\n',
      'Beta text\n',
      ' ✦ shell pwd\n',
      'Goodbye.\n'
    ]);
  });

  it('falls back to raw ANSI line rewrites for interactive tool activity even when cursor methods exist', async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    let moveCursorCalls = 0;
    let clearLineCalls = 0;
    const cwd = join(tmpdir(), `qiclaw-interactive-ansi-rewrite-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['run tool please', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        isTTY: true,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        },
        moveCursor() {
          moveCursorCalls += 1;
          return true;
        },
        clearLine() {
          clearLineCalls += 1;
          return true;
        }
      } as Pick<NodeJS.WriteStream, 'write' | 'moveCursor' | 'clearLine'> & {
        isTTY: boolean;
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 1,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
            turnId: 'turn-ansi-rewrite',
            providerRound: 1,
            toolRound: 0,
            messageCount: 2,
            promptRawChars: 42,
            toolNames: [],
            messageSummaries: [
              { role: 'system', rawChars: 12, contentBlockCount: 1, messageSource: 'system' },
              { role: 'user', rawChars: 20, contentBlockCount: 1, messageSource: 'user' }
            ],
            totalContentBlockCount: 2,
            hasSystemPrompt: true,
            promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
          }));
          input.observer?.record(createTelemetryEvent('provider_responded', 'provider_decision', {
            turnId: 'turn-ansi-rewrite',
            providerRound: 1,
            toolRound: 0,
            stopReason: 'tool_use',
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            responseContentBlockCount: 1,
            toolCallCount: 1,
            hasTextOutput: false,
            responseContentBlocksByType: { tool_use: 1 },
            toolCallSummaries: [],
            providerUsageRawRedacted: { input_tokens: 12, output_tokens: 8 },
            providerStopDetails: { stop_reason: 'tool_use' },
            responsePreviewRedacted: '[{"type":"tool_use"}]',
            durationMs: 20
          }));
          input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
            turnId: 'turn-ansi-rewrite',
            providerRound: 1,
            toolRound: 1,
            toolName: 'shell',
            toolCallId: 'toolu_ansi',
            inputPreview: '{"command":"npm","args":["test"]}',
            inputRawRedacted: { command: 'npm', args: ['test'] }
          }));

          await vi.advanceTimersByTimeAsync(INTERACTIVE_PULSE_SETTLE_MS);

          input.observer?.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
            turnId: 'turn-ansi-rewrite',
            providerRound: 1,
            toolRound: 1,
            toolName: 'shell',
            toolCallId: 'toolu_ansi',
            isError: false,
            resultPreview: 'ok',
            resultRawRedacted: { content: 'ok' },
            durationMs: 5,
            resultSizeChars: 2,
            resultSizeBucket: 'small'
          }));
          yield {
            type: 'turn_completed',
            finalAnswer: '',
            stopReason: 'completed',
            history: [],
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          } satisfies TurnEvent;
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = writes.join('');
    expect(output).toContain('\u001b[1A\u001b[2K');
    expect(moveCursorCalls).toBe(0);
    expect(clearLineCalls).toBe(0);
  });

  it('shows interactive fallback failure duration when tool events include durationMs', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-fallback-duration-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['run tool please'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      stderr: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'run tool please',
          checklist: ['run tool please'],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: true,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: false,
          finalAnswerIsNonEmpty: false,
          finalAnswerIsSubstantive: false,
          toolEvidenceSatisfied: false,
          noUnresolvedToolErrors: false,
          toolMessagesCount: 1,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          yield {
            type: 'tool_call_started',
            id: 'toolu_1',
            name: 'shell',
            input: { command: 'npm', args: ['test'] }
          } satisfies TurnEvent;
          yield {
            type: 'tool_call_completed',
            id: 'toolu_1',
            name: 'shell',
            resultPreview: 'permission denied',
            isError: true,
            durationMs: 15
          } satisfies TurnEvent & { durationMs: number };
          yield {
            type: 'turn_failed',
            error: new Error('Tool crashed')
          } satisfies TurnEvent;
          throw new Error('Tool crashed');
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(1);

    const output = stripAnsi(writes.join(''));
    expect(output).toContain(' └─ ✖ Fail (15ms)\n');
  });

  it('streams real runtime tool activity in prompt mode without duplicate telemetry render', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-prompt-real-stream-${Math.random().toString(36).slice(2)}`);
    let providerRound = 0;
    const cli = buildCli({
      argv: ['--prompt', 'run tool please'],
      cwd,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: {
          name: 'test-provider',
          model: 'test-model',
          async generate() {
            throw new Error('not used');
          },
          async *stream(): AsyncIterable<NormalizedEvent> {
            providerRound += 1;
            yield { type: 'start', provider: 'test-provider', model: 'test-model' };

            if (providerRound === 1) {
              yield {
                type: 'tool_call',
                id: 'toolu_1',
                name: 'read_file',
                input: { path: 'src/cli/main.ts' }
              };
              yield {
                type: 'finish',
                finish: { stopReason: 'tool_use' },
                responseMetrics: {
                  contentBlockCount: 1,
                  toolCallCount: 1,
                  hasTextOutput: false,
                  contentBlocksByType: { tool_use: 1 }
                },
                debug: {
                  toolCallSummaries: [{ id: 'toolu_1', name: 'read_file' }],
                  responsePreviewRedacted: '[{"type":"tool_use"}]'
                }
              };
              return;
            }

            yield {
              type: 'text_delta',
              text: 'read:src/cli/main.ts'
            };
            yield {
              type: 'finish',
              finish: { stopReason: 'stop' },
              responseMetrics: {
                contentBlockCount: 1,
                toolCallCount: 0,
                hasTextOutput: true,
                contentBlocksByType: { text: 1 }
              },
              debug: {
                responsePreviewRedacted: 'read:src/cli/main.ts'
              }
            };
          }
        },
        availableTools: [createReadFileTool()],
        cwd,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '\nQiClaw\n',
      '  read:src/cli/main.ts'
    ]);
    expect(output).not.toContain('  · read src/cli/main.ts\n');
  });

  it('renders streamed search tool activity from query input without falling back to pattern', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-prompt-search-stream-${Math.random().toString(36).slice(2)}`);
    let providerRound = 0;
    const cli = buildCli({
      argv: ['--prompt', 'run search please'],
      cwd,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: {
          name: 'test-provider',
          model: 'test-model',
          async generate() {
            throw new Error('not used');
          },
          async *stream(): AsyncIterable<NormalizedEvent> {
            providerRound += 1;
            yield { type: 'start', provider: 'test-provider', model: 'test-model' };

            if (providerRound === 1) {
              yield {
                type: 'tool_call',
                id: 'toolu_search_1',
                name: 'search',
                input: { query: 'package' }
              };
              yield {
                type: 'finish',
                finish: { stopReason: 'tool_use' },
                responseMetrics: {
                  contentBlockCount: 1,
                  toolCallCount: 1,
                  hasTextOutput: false,
                  contentBlocksByType: { tool_use: 1 }
                },
                debug: {
                  toolCallSummaries: [{ id: 'toolu_search_1', name: 'search' }],
                  responsePreviewRedacted: '[{"type":"tool_use"}]'
                }
              };
              return;
            }

            yield {
              type: 'text_delta',
              text: 'found package'
            };
            yield {
              type: 'finish',
              finish: { stopReason: 'stop' },
              responseMetrics: {
                contentBlockCount: 1,
                toolCallCount: 0,
                hasTextOutput: true,
                contentBlocksByType: { text: 1 }
              },
              debug: {
                responsePreviewRedacted: 'found package'
              }
            };
          }
        },
        availableTools: [searchTool],
        cwd,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('  found package\n');
    expect(output).not.toContain('  · search pattern\n');
  });

  it('renders streamed interactive text that already ends with a newline without adding extra blank lines before footer', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-live-text-newline-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['live text please', '/exit'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'Xin chào\n',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          yield { type: 'assistant_text_delta', text: 'Xin chào\n' } satisfies TurnEvent;
          yield {
            type: 'assistant_message_completed',
            text: 'Xin chào\n'
          } satisfies TurnEvent;
          yield {
            type: 'turn_completed',
            finalAnswer: 'Xin chào\n',
            stopReason: 'completed',
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          } satisfies TurnEvent;
        })(),
        finalResult: Promise.resolve((() => {
          input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
            turnId: 'turn-live-text-newline',
            providerRound: 1,
            toolRound: 0,
            stopReason: 'completed',
            toolRoundsUsed: 0,
            isVerified: true,
            durationMs: 900
          }));
          input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
            turnId: 'turn-live-text-newline',
            providerRound: 1,
            toolRound: 0,
            providerRounds: 1,
            toolRoundsUsed: 0,
            toolCallsTotal: 0,
            toolCallsByName: {},
            inputTokensTotal: 12,
            outputTokensTotal: 8,
            cacheReadInputTokens: 0,
            promptCharsMax: 42,
            toolResultCharsInFinalPrompt: 0,
            assistantToolCallCharsInFinalPrompt: 0,
            toolResultPromptGrowthCharsTotal: 0,
            toolResultCharsAddedAcrossTurn: 0,
            turnCompleted: true,
            stopReason: 'completed'
          }));

          return {
            stopReason: 'completed',
            finalAnswer: 'Xin chào\n',
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        })())
      })
    });

    await expect(cli.run()).resolves.toBe(0);

    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '\n──────────────────────────────────────────────────────\n\nXin chào\n',
      '──────────────────────────────────────────────────────\n',
      '✔ DONE • 1 provider • 12 in / 8 out • ⏱️0.9s\n\n',
      'Goodbye.\n'
    ]);
    expect(output).not.toContain('Xin chào\n\n\n────────────────');
  });

  it('renders streamed tool errors in interactive mode with failure status and preview', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-tool-error-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['run tool please'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      stderr: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'run tool please',
          checklist: ['run tool please'],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: true,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: false,
          finalAnswerIsNonEmpty: false,
          finalAnswerIsSubstantive: false,
          toolEvidenceSatisfied: false,
          noUnresolvedToolErrors: false,
          toolMessagesCount: 1,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          yield {
            type: 'tool_call_started',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'src/cli/main.ts' }
          } satisfies TurnEvent;
          yield {
            type: 'tool_call_completed',
            id: 'toolu_1',
            name: 'read_file',
            resultPreview: 'permission denied',
            isError: true
          } satisfies TurnEvent;
          yield {
            type: 'turn_failed',
            error: new Error('Tool crashed')
          } satisfies TurnEvent;
          throw new Error('Tool crashed');
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(1);

    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      ' ✦ file read src/cli/main.ts\n',
      ' └─ ✖ Fail',
      '  permission denied\n',
      '──────────────────────────────────────────────────────\n',
      '✖ FAIL: Tool crashed\n'
    ]);
    expect(output).toContain(' ✦ file read src/cli/main.ts\n');
    expect(output.match(/ ✦ file read src\/cli\/main\.ts\n/g)).toHaveLength(1);
    expect(output.match(/Tool crashed\n/g)).toHaveLength(1);
  });

  it('renders streamed turn failure once and returns a non-zero exit when the stream throws after turn_failed', async () => {
    const writes: string[] = [];
    const cwd = join(tmpdir(), `qiclaw-interactive-tool-events-${Math.random().toString(36).slice(2)}`);
    const cli = buildCli({
      argv: [],
      cwd,
      readLine: (() => {
        const inputs = ['run tool please'];
        return async () => inputs.shift();
      })(),
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      stderr: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => createTestRuntime(cwd, runtimeOptions.observer),
      runTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'run tool please',
          checklist: ['run tool please'],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: true,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: false,
          finalAnswerIsNonEmpty: false,
          finalAnswerIsSubstantive: false,
          toolEvidenceSatisfied: false,
          noUnresolvedToolErrors: false,
          toolMessagesCount: 1,
          checks: []
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' } satisfies TurnEvent;
          yield {
            type: 'tool_call_started',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'src/cli/main.ts' }
          } satisfies TurnEvent;
          yield {
            type: 'tool_call_completed',
            id: 'toolu_1',
            name: 'read_file',
            resultPreview: 'export function buildCli',
            isError: false
          } satisfies TurnEvent;
          yield {
            type: 'turn_failed',
            error: new Error('Tool crashed')
          } satisfies TurnEvent;
          throw new Error('Tool crashed');
        })()
      })
    });

    await expect(cli.run()).resolves.toBe(1);

    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      ' ✦ file read src/cli/main.ts\n',
      ' └─ ✔ Success',
      '  export function buildCli\n',
      '──────────────────────────────────────────────────────\n',
      '✖ FAIL: Tool crashed\n'
    ]);
    expect(output).toContain(' ✦ file read src/cli/main.ts\n');
    expect(output.match(/ ✦ file read src\/cli\/main\.ts\n/g)).toHaveLength(1);
    expect(output.match(/Tool crashed\n/g)).toHaveLength(1);
  });

  it('passes the selected provider and model to runtime creation in prompt mode', async () => {
    await withProviderEnvSnapshot(async () => {
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const writes: string[] = [];
      const cli = buildCli({
        argv: ['--provider', 'openai', '--model', 'gpt-4.1', '--prompt', 'inspect package.json'],
        cwd: '/tmp/qiclaw-provider-test',
        stdout: {
          write(chunk) {
            writes.push(String(chunk));
            return true;
          }
        },
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions.provider).toBe('openai');
          expect(runtimeOptions.model).toBe('gpt-4.1');
          expect(runtimeOptions.baseUrl).toBeUndefined();
          expect(runtimeOptions.apiKey).toBeUndefined();
          expect(runtimeOptions.cwd).toBe('/tmp/qiclaw-provider-test');

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
      expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
    });
  });

  it('uses the provider default model when --provider is passed without --model', async () => {
    await withProviderEnvSnapshot(async () => {
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const writes: string[] = [];
      const cli = buildCli({
        argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
        cwd: '/tmp/qiclaw-provider-default-test',
        stdout: {
          write(chunk) {
            writes.push(String(chunk));
            return true;
          }
        },
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions.provider).toBe('openai');
          expect(runtimeOptions.model).toBe('gpt-4.1');
          expect(runtimeOptions.baseUrl).toBeUndefined();
          expect(runtimeOptions.apiKey).toBeUndefined();
          expect(runtimeOptions.cwd).toBe('/tmp/qiclaw-provider-default-test');

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
      expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
    });
  });

  it('returns exit code 1 and prints an error when --prompt is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--prompt'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --prompt\n']);
  });

  it('passes the selected agent spec name to runtime creation in prompt mode', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec', 'readonly', '--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-readonly-spec-test',
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => {
        expect(runtimeOptions.agentSpecName).toBe('readonly');

        return {
          provider: createNoopTestProvider(),
          availableTools: [],
          cwd: '/tmp/qiclaw-readonly-spec-test',
          observer: runtimeOptions.observer ?? createNoopObserver(),
            systemPrompt: 'Test prompt',
          maxToolRounds: 3
        };
      },
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `handled: ${input.userInput}`,
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        }
      })
    });

    await expect(cli.run()).resolves.toBe(0);
    expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
  });

  it('uses the same project-tier resolved package for prompt execution as preview', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-agent-runtime-project-'));
    tempDirs.push(tempDir);
    const presetDir = join(tempDir, '.qiclaw', 'agents', 'readonly');
    await mkdir(presetDir, { recursive: true });
    await writeFile(join(presetDir, 'agent.json'), `${JSON.stringify({
      extends: 'default',
      policy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 2,
        mutationMode: 'none'
      }
    }, null, 2)}\n`);
    await writeFile(join(presetDir, 'AGENT.md'), 'Project readonly override\n');
    await writeFile(join(presetDir, 'USER.md'), 'Project user override\n');

    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec', 'readonly', '--prompt', 'inspect package.json'],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      runTurn: async (input) => {
        expect(input.resolvedPackage?.sourceTier).toBe('project');
        expect(input.resolvedPackage?.preset).toBe('readonly');
        expect(input.resolvedPackage?.extendsChain).toEqual(['readonly', 'default']);
        expect(input.resolvedPackage?.effectivePolicy.allowedCapabilityClasses).toEqual(['read']);
        expect(input.resolvedPackage?.effectivePolicy.maxToolRounds).toBe(2);
        expect(input.resolvedPackage?.effectivePromptFiles['AGENT.md']?.filePath).toBe(join(presetDir, 'AGENT.md'));
        expect(input.baseSystemPrompt).toContain('Project readonly override');

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
  });

  it('prints a package preview using project-tier resolution and exits before runtime execution when --agent-spec-preview is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-agent-preview-project-'));
    tempDirs.push(tempDir);
    const presetDir = join(tempDir, '.qiclaw', 'agents', 'readonly');
    await mkdir(presetDir, { recursive: true });
    await writeFile(join(presetDir, 'agent.json'), `${JSON.stringify({
      extends: 'default',
      policy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 2,
        mutationMode: 'none'
      }
    }, null, 2)}\n`);
    await writeFile(join(presetDir, 'AGENT.md'), 'Project readonly override\n');
    await writeFile(join(presetDir, 'USER.md'), 'Project user override\n');

    const stdoutWrites: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec-preview', 'readonly'],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          stdoutWrites.push(String(chunk));
          return true;
        }
      },
      createRuntime: () => {
        throw new Error('createRuntime should not be called for preview mode');
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(stdoutWrites.join('')).toContain('Agent spec preview: readonly\n');
    expect(stdoutWrites.join('')).toContain('Source tier: project\n');
    expect(stdoutWrites.join('')).toContain('Inheritance chain: readonly -> default\n');
    expect(stdoutWrites.join('')).toContain(`AGENT.md: ${join(tempDir, '.qiclaw', 'agents', 'readonly', 'AGENT.md')}\n`);
    expect(stdoutWrites.join('')).not.toContain('CHECKLIST.md:');
    expect(stdoutWrites.join('')).toContain('Rendered system prompt:\n');
    expect(stdoutWrites.join('')).toContain('Project readonly override\n');
    expect(stdoutWrites.join('')).toContain('Project user override\n');
    expect(stdoutWrites.join('')).toContain('Runtime constraints summary\n');
    expect(stdoutWrites.join('')).not.toContain('Completion mode:');
  });

  it('returns exit code 1 and prints an error when --agent-spec-preview is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec-preview'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --agent-spec-preview\n']);
  });

  it('returns exit code 1 and prints an error when --agent-spec-preview is unknown', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec-preview', 'ghost'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Unknown agent spec: ghost\n']);
  });

  it('returns exit code 1 and prints an error when --agent-spec is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --agent-spec\n']);
  });

  it('returns exit code 1 and prints an error when --provider is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--provider'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --provider\n']);
  });

  it('returns exit code 1 and prints an error when --base-url is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--base-url'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --base-url\n']);
  });

  it('returns exit code 1 and prints an error when --api-key is missing a value', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--api-key'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Missing value for --api-key\n']);
  });

  it('returns exit code 1 and prints an error when an unknown provider is provided', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--provider', 'bedrock'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Unknown provider: bedrock\n']);
  });

  it('returns exit code 1 and prints an error when an unknown agent spec is provided', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--agent-spec', 'missing', '--prompt', 'inspect package.json'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Unknown agent spec: missing\n']);
  });

  it('uses shared provider config helpers for provider parsing and default models', () => {
    expect(parseProviderId('openai')).toBe('openai');
    expect(parseProviderId('anthropic')).toBe('anthropic');
    expect(() => parseProviderId('bedrock')).toThrow('Unknown provider: bedrock');
    expect(getDefaultModelForProvider('openai')).toBe('gpt-4.1');
    expect(getDefaultModelForProvider('anthropic')).toBe('claude-opus-4-6');
  });

  it('passes custom endpoint and api key overrides to runtime creation in prompt mode', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--provider', 'openai', '--model', 'gpt-4.1', '--base-url', 'https://openai.example/v1', '--api-key', 'openai-cli-key', '--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-custom-provider-test',
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => {
        expect(runtimeOptions).toMatchObject({
          provider: 'openai',
          model: 'gpt-4.1',
          baseUrl: 'https://openai.example/v1',
          apiKey: 'openai-cli-key',
          cwd: '/tmp/qiclaw-custom-provider-test'
        });

        return {
          provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: runtimeOptions.cwd,
          observer: runtimeOptions.observer ?? createNoopObserver(),
            systemPrompt: 'Test prompt',
          maxToolRounds: 3
        };
      },
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `handled: ${input.userInput}`,
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true as const,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: 0,
          checks: []
        }
      })
    });

    await expect(cli.run()).resolves.toBe(0);
    expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
  });

  it('lets CLI overrides win over provider-specific env vars', async () => {
    await withProviderEnvSnapshot(async () => {
      process.env.OPENAI_BASE_URL = 'https://openai-env.example/v1';
      process.env.OPENAI_API_KEY = 'openai-env-key';

      expect(resolveProviderConfig({
        provider: 'openai',
        baseUrl: 'https://openai-cli.example/v1',
        apiKey: 'openai-cli-key',
        model: 'gpt-4.1-mini'
      })).toEqual({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        baseUrl: 'https://openai-cli.example/v1',
        apiKey: 'openai-cli-key'
      });
    });
  });

  it('loads provider config from a cwd .env file before creating the runtime', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
        'OPENAI_API_KEY=openai-dotenv-key',
        'OPENAI_MODEL=gpt-from-dotenv'
      ].join('\n'), 'utf8');

      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const cli = buildCli({
        argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            provider: 'openai',
            model: 'gpt-from-dotenv',
            baseUrl: 'https://openai-from-dotenv.example/v1',
            apiKey: 'openai-dotenv-key',
            cwd: tempDir
          });

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('prefers .env.local values over .env values from the same cwd', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-local-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
        'OPENAI_API_KEY=openai-dotenv-key',
        'OPENAI_MODEL=gpt-from-dotenv'
      ].join('\n'), 'utf8');
      await writeFile(join(tempDir, '.env.local'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv-local.example/v1',
        'OPENAI_API_KEY=openai-dotenv-local-key',
        'OPENAI_MODEL=gpt-from-dotenv-local'
      ].join('\n'), 'utf8');

      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const cli = buildCli({
        argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            provider: 'openai',
            model: 'gpt-from-dotenv-local',
            baseUrl: 'https://openai-from-dotenv-local.example/v1',
            apiKey: 'openai-dotenv-local-key',
            cwd: tempDir
          });

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('does not let env files overwrite variables already present in process.env', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-shell-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
        'OPENAI_API_KEY=openai-dotenv-key',
        'OPENAI_MODEL=gpt-from-dotenv'
      ].join('\n'), 'utf8');
      await writeFile(join(tempDir, '.env.local'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv-local.example/v1',
        'OPENAI_API_KEY=openai-dotenv-local-key',
        'OPENAI_MODEL=gpt-from-dotenv-local'
      ].join('\n'), 'utf8');

      process.env.OPENAI_BASE_URL = 'https://openai-from-shell.example/v1';
      process.env.OPENAI_API_KEY = 'openai-shell-key';
      process.env.OPENAI_MODEL = 'gpt-from-shell';

      const cli = buildCli({
        argv: ['--provider', 'openai', '--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            model: 'gpt-from-shell',
            baseUrl: 'https://openai-from-shell.example/v1',
            apiKey: 'openai-shell-key'
          });

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('lets CLI flags override env file values before creating the runtime', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-env-override-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv.example/v1',
        'OPENAI_API_KEY=openai-dotenv-key',
        'OPENAI_MODEL=gpt-from-dotenv'
      ].join('\n'), 'utf8');
      await writeFile(join(tempDir, '.env.local'), [
        'OPENAI_BASE_URL=https://openai-from-dotenv-local.example/v1',
        'OPENAI_API_KEY=openai-dotenv-local-key',
        'OPENAI_MODEL=gpt-from-dotenv-local'
      ].join('\n'), 'utf8');

      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;

      const cli = buildCli({
        argv: [
          '--provider',
          'openai',
          '--base-url',
          'https://openai-from-cli.example/v1',
          '--api-key',
          'openai-cli-key',
          '--prompt',
          'inspect package.json'
        ],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            provider: 'openai',
            model: 'gpt-from-dotenv-local',
            baseUrl: 'https://openai-from-cli.example/v1',
            apiKey: 'openai-cli-key',
            cwd: tempDir
          });

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('uses MODEL from .env.local to select the provider when --provider is omitted', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-from-env-local-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'MODEL=anthropic',
        'OPENAI_MODEL=gpt-from-dotenv',
        'ANTHROPIC_MODEL=claude-from-dotenv'
      ].join('\n'), 'utf8');
      await writeFile(join(tempDir, '.env.local'), [
        'MODEL=openai',
        'OPENAI_MODEL=gpt-from-dotenv-local'
      ].join('\n'), 'utf8');

      delete process.env.MODEL;
      delete process.env.OPENAI_MODEL;
      delete process.env.ANTHROPIC_MODEL;

      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            provider: 'openai',
            model: 'gpt-from-dotenv-local',
            cwd: tempDir
          });

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('lets --provider override MODEL from env files', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-flag-over-env-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'MODEL=openai',
        'OPENAI_MODEL=gpt-from-dotenv',
        'ANTHROPIC_MODEL=claude-from-dotenv'
      ].join('\n'), 'utf8');
      await writeFile(join(tempDir, '.env.local'), [
        'MODEL=openai',
        'ANTHROPIC_MODEL=claude-from-dotenv-local'
      ].join('\n'), 'utf8');

      delete process.env.MODEL;
      delete process.env.OPENAI_MODEL;
      delete process.env.ANTHROPIC_MODEL;

      const cli = buildCli({
        argv: ['--provider', 'anthropic', '--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            provider: 'anthropic',
            model: 'claude-from-dotenv-local',
            cwd: tempDir
          });

          return {
            provider: { name: 'anthropic', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('keeps openai as the default provider when MODEL is absent', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-default-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env'), [
        'OPENAI_MODEL=gpt-from-dotenv',
        'ANTHROPIC_MODEL=claude-from-dotenv'
      ].join('\n'), 'utf8');

      delete process.env.MODEL;
      delete process.env.OPENAI_MODEL;
      delete process.env.ANTHROPIC_MODEL;

      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: tempDir,
        createRuntime: (runtimeOptions) => {
          expect(runtimeOptions).toMatchObject({
            provider: 'openai',
            model: 'gpt-from-dotenv',
            cwd: tempDir
          });

          return {
            provider: { name: 'openai', model: runtimeOptions.model, async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: runtimeOptions.cwd,
            observer: runtimeOptions.observer ?? createNoopObserver(),
                systemPrompt: 'Test prompt',
            maxToolRounds: 3
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
    });
  });

  it('returns exit code 1 when MODEL from env is not a supported provider', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-invalid-env-'));
      tempDirs.push(tempDir);

      await writeFile(join(tempDir, '.env.local'), [
        'MODEL=bedrock'
      ].join('\n'), 'utf8');

      delete process.env.MODEL;

      const stderrWrites: string[] = [];
      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: tempDir,
        stderr: {
          write(chunk) {
            stderrWrites.push(String(chunk));
            return true;
          }
        },
        createRuntime() {
          throw new Error('runtime should not be created for an invalid provider env');
        },
        readLine: async () => '/exit'
      });

      await expect(cli.run()).resolves.toBe(1);
      expect(stderrWrites).toEqual(['Unknown provider: bedrock\n']);
    });
  });

  it('returns exit code 1 and prints an error when an unknown flag is provided', async () => {
    const stderrWrites: string[] = [];
    const cli = buildCli({
      argv: ['--unknown'],
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      }
    });

    await expect(cli.run()).resolves.toBe(1);
    expect(stderrWrites).toEqual(['Unknown argument: --unknown\n']);
  });

  it('renders prompt mode as an indented QiClaw block with the footer flush to column zero', async () => {
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-prompt-layout',
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: '/tmp/qiclaw-prompt-layout',
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'read_file',
          toolCallId: 'toolu_1',
          inputPreview: '{"path":"/tmp/package.json"}',
          inputRawRedacted: { path: '/tmp/package.json' }
        }));
        input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          stopReason: 'completed',
          toolRoundsUsed: 1,
          isVerified: true,
          durationMs: 6300
        }));
        input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          providerRounds: 1,
          toolRoundsUsed: 1,
          toolCallsTotal: 1,
          toolCallsByName: { read_file: 1 },
          inputTokensTotal: 185,
          outputTokensTotal: 15,
          cacheReadInputTokens: 0,
          promptCharsMax: 100,
          toolResultCharsInFinalPrompt: 0,
          assistantToolCallCharsInFinalPrompt: 0,
          toolResultPromptGrowthCharsTotal: 0,
          toolResultCharsAddedAcrossTurn: 0,
          turnCompleted: true,
          stopReason: 'completed'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: 'Tóm tắt:\n- handled',
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expectRenderedCliOutput(
      writes,
      '\nQiClaw\n  · read_file /tmp/package.json\n  Tóm tắt:\n  - handled\n─ completed • verified • 1 provider • 1 tool round • 1 tools • 185 in / 15 out • 6.3s\n\n'
    );
  });

  it('keeps interactive session state across turns and saves the latest checkpoint', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-'));
    tempDirs.push(tempDir);

    const writes: string[] = [];
    const runTurnInputs: Array<{ userInput: string; sessionId?: string; historySummary?: string; historyLength: number }> = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-test-1',
      readLine: (() => {
        const inputs = ['first question', 'second question', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        runTurnInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          historySummary: input.historySummary,
          historyLength: input.history?.length ?? 0
        });

        if (input.userInput === 'first question') {
          return {
            stopReason: 'completed',
            finalAnswer: 'answer: first question',
            history: [
              ...(input.history ?? []),
              { role: 'user', content: input.userInput },
              { role: 'assistant', content: 'answer: first question' }
            ],
            historySummary: 'Summary after first question',
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        }

        return {
          stopReason: 'completed',
          finalAnswer: 'answer: second question',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'answer: second question' }
          ],
          historySummary: 'Summary after second question',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    expect(runTurnInputs).toEqual([
      {
        userInput: 'first question',
        sessionId: 'session-test-1',
        historySummary: undefined,
        historyLength: 0
      },
      {
        userInput: 'second question',
        sessionId: 'session-test-1',
        historySummary: 'Summary after first question',
        historyLength: 2
      }
    ]);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '\n──────────────────────────────────────────────────────\n\nanswer: first question\n',
      '\n──────────────────────────────────────────────────────\n\nanswer: second question\n',
      'Goodbye.\n'
    ]);

    const resumedRunTurnInputs: Array<{ userInput: string; historySummary?: string; historyLength: number }> = [];
    const resumedCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-test-2',
      readLine: (() => {
        const inputs = ['resumed question', 'follow-up question', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        expect(input.sessionId).toBe('session-test-1');
        resumedRunTurnInputs.push({
          userInput: input.userInput,
          historySummary: input.historySummary,
          historyLength: input.history?.length ?? 0
        });

        if (input.userInput === 'resumed question') {
          expect(input.historySummary).toBe('Summary after second question');
          expect(input.history).toEqual([
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'answer: first question' },
            { role: 'user', content: 'second question' },
            { role: 'assistant', content: 'answer: second question' }
          ]);

          return {
            stopReason: 'completed',
            finalAnswer: 'answer: resumed question',
            history: [
              ...(input.history ?? []),
              { role: 'user', content: input.userInput },
              { role: 'assistant', content: 'answer: resumed question' }
            ],
            historySummary: undefined,
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true as const,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        }

        expect(input.history).toEqual([
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'answer: first question' },
          { role: 'user', content: 'second question' },
          { role: 'assistant', content: 'answer: second question' },
          { role: 'user', content: 'resumed question' },
          { role: 'assistant', content: 'answer: resumed question' }
        ]);

        return {
          stopReason: 'completed',
          finalAnswer: 'answer: follow-up question',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'answer: follow-up question' }
          ],
          historySummary: 'Summary after follow-up question',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(resumedCli.run()).resolves.toBe(0);
    expect(resumedRunTurnInputs).toEqual([
      {
        userInput: 'resumed question',
        historySummary: 'Summary after second question',
        historyLength: 4
      },
      {
        userInput: 'follow-up question',
        historySummary: 'Summary after second question',
        historyLength: 6
      }
    ]);
  });

  it('renders footer for default interactive streaming runtime path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-default-stream-footer-'));
    tempDirs.push(tempDir);

    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: {
          name: 'test-provider',
          model: 'test-model',
          async generate() {
            throw new Error('not used');
          },
          async *stream() {
            yield { type: 'start', provider: 'test-provider', model: 'test-model' } as const;
            yield { type: 'text_delta', text: 'Xin ' } as const;
            yield { type: 'text_delta', text: 'chào' } as const;
            yield {
              type: 'finish',
              finish: { stopReason: 'completed' },
              usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
              responseMetrics: {
                contentBlockCount: 1,
                toolCallCount: 0,
                hasTextOutput: true,
                contentBlocksByType: { text: 1 }
              },
              debug: {
                responseContentBlocksByType: { text: 1 },
                responsePreviewRedacted: '[{"type":"text"}]'
              }
            } as const;
          }
        },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-default-stream-footer',
      readLine: (() => {
        const inputs = ['streamed question', '/exit'];
        return async () => inputs.shift();
      })()
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      '\n──────────────────────────────────────────────────────\n\nXin chào\n',
      '──────────────────────────────────────────────────────\n',
      '✔ DONE • 1 provider • 12 in / 8 out • ⏱️',
      'Goodbye.\n'
    ]);
  });

  it('does not deadlock interactive streamed turns when finalResult depends on stream consumption', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-final-result-'));
    tempDirs.push(tempDir);

    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-final-result',
      readLine: (() => {
        const inputs = ['streamed question', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        const finalHistory = [
          ...(input.history ?? []),
          { role: 'user' as const, content: input.userInput },
          { role: 'assistant' as const, content: 'resolved final answer' }
        ];

        let resolveFinalResult: ((value: CliRunTurnResult & { historySummary: string }) => void) | undefined;
        const finalResult = new Promise<CliRunTurnResult & { historySummary: string }>((resolve) => {
          resolveFinalResult = resolve;
        });

        return {
          stopReason: 'completed',
          finalAnswer: '',
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: false,
            finalAnswerIsNonEmpty: false,
            finalAnswerIsSubstantive: false,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          },
          turnStream: (async function* () {
            yield { type: 'turn_started' } satisfies TurnEvent;
            yield { type: 'assistant_text_delta', text: 'resolved ' } satisfies TurnEvent;
            yield { type: 'assistant_text_delta', text: 'final answer' } satisfies TurnEvent;
            yield {
              type: 'assistant_message_completed',
              text: 'resolved final answer'
            } satisfies TurnEvent;
            resolveFinalResult?.({
              stopReason: 'completed',
              finalAnswer: 'resolved final answer',
              history: finalHistory,
              toolRoundsUsed: 0,
              doneCriteria: {
                goal: input.userInput,
                checklist: [input.userInput],
                requiresNonEmptyFinalAnswer: true as const,
                requiresToolEvidence: false,
                requiresSubstantiveFinalAnswer: false,
                forbidSuccessAfterToolErrors: false
              },
              verification: {
                isVerified: true,
                finalAnswerIsNonEmpty: true,
                finalAnswerIsSubstantive: true,
                toolEvidenceSatisfied: true,
                noUnresolvedToolErrors: true,
                toolMessagesCount: 0,
                checks: []
              },
              historySummary: 'resolved summary'
            });
            yield {
              type: 'turn_completed',
              finalAnswer: 'resolved final answer',
              stopReason: 'completed',
              history: finalHistory,
              toolRoundsUsed: 0,
              doneCriteria: {
                goal: input.userInput,
                checklist: [input.userInput],
                requiresNonEmptyFinalAnswer: true as const,
                requiresToolEvidence: false,
                requiresSubstantiveFinalAnswer: false,
                forbidSuccessAfterToolErrors: false
              },
              turnCompleted: true
            } satisfies TurnEvent;
          })(),
          finalResult
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const checkpointPath = join(tempDir, '.qiclaw', 'checkpoint.sqlite');
    const { CheckpointStore } = await import('../../src/session/checkpointStore.js');
    const { parseInteractiveCheckpointJson } = await import('../../src/session/session.js');
    const checkpointStore = new CheckpointStore(checkpointPath);
    const latestCheckpoint = checkpointStore.getLatest();

    expect(latestCheckpoint?.sessionId).toBe('session-final-result');
    expect(parseInteractiveCheckpointJson(latestCheckpoint?.checkpointJson ?? '')).toMatchObject({
      history: [
        { role: 'user', content: 'streamed question' },
        { role: 'assistant', content: 'resolved final answer' }
      ],
      historySummary: 'resolved summary'
    });

    const output = stripAnsi(writes.join(''));
    expect(output).toContain('\nresolved final answer');
  });

  it('keeps prompt mode stateless and does not load checkpoints', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-'));
    tempDirs.push(tempDir);

    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        expect(input.sessionId).toBeUndefined();
        expect(input.history).toBeUndefined();
        expect(input.historySummary).toBeUndefined();

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          historySummary: 'should not persist',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expectRenderedCliOutput(writes, '\nQiClaw\n  handled: inspect package.json\n');
  });

  it('restores tool messages from a valid checkpoint when resuming interactive mode', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-'));
    tempDirs.push(tempDir);

    const checkpointDir = join(tempDir, '.qiclaw');
    const checkpointStoreFilename = join(checkpointDir, 'checkpoint.sqlite');
    const { mkdir } = await import('node:fs/promises');
    const { CheckpointStore } = await import('../../src/session/checkpointStore.js');
    const { createInteractiveCheckpointJson } = await import('../../src/session/session.js');

    await mkdir(checkpointDir, { recursive: true });
    const store = new CheckpointStore(checkpointStoreFilename);
    store.save({
      sessionId: 'restored-session',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [
          { role: 'user', content: 'inspect package.json' },
          {
            role: 'assistant',
            content: 'Calling Read tool.',
            toolCalls: [
              {
                id: 'toolu_restore_1',
                name: 'Read',
                input: { path: '/tmp/package.json' }
              }
            ]
          },
          {
            role: 'tool',
            name: 'Read',
            toolCallId: 'toolu_restore_1',
            content: '{"path":"/tmp/package.json"}',
            isError: false
          },
          { role: 'assistant', content: 'package.json inspected' }
        ],
        historySummary: 'Package metadata restored from checkpoint.'
      }),
      updatedAt: '2026-03-30T12:00:00.000Z'
    });

    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'fresh-session',
      readLine: (() => {
        const inputs = ['follow-up question', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        expect(input.sessionId).toBe('restored-session');
        expect(input.historySummary).toBe('Package metadata restored from checkpoint.');
        expect(input.history).toEqual([
          { role: 'user', content: 'inspect package.json' },
          {
            role: 'assistant',
            content: 'Calling Read tool.',
            toolCalls: [
              {
                id: 'toolu_restore_1',
                name: 'Read',
                input: { path: '/tmp/package.json' }
              }
            ]
          },
          {
            role: 'tool',
            name: 'Read',
            toolCallId: 'toolu_restore_1',
            content: '{"path":"/tmp/package.json"}',
            isError: false
          },
          { role: 'assistant', content: 'package.json inspected' }
        ]);

        return {
          stopReason: 'completed',
          finalAnswer: 'follow-up answer',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'follow-up answer' }
          ],
          historySummary: 'Follow-up summary',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      '┌────────────────────────────────────────────────────┐\n',
      '│ ⚡QiClaw                      🤖 Model: test-model │\n',
      '└────────────────────────────────────────────────────┘\n',
      'Resumed checkpoint • 2 messages • summary available\n',
      '» inspect package.json\n',
      '──────────────────────────────────────────────────────\npackage.json inspected\n',
      '\n──────────────────────────────────────────────────────\n\nfollow-up answer\n'
    ]);
    expect(output).not.toContain('tool(Read): {"path":"/tmp/package.json"}');
    expect(output).not.toContain('Calling Read tool.');
  });

  it('renders full multiline checkpoint preview content instead of truncating to the first line', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-'));
    tempDirs.push(tempDir);

    const checkpointDir = join(tempDir, '.qiclaw');
    const checkpointStoreFilename = join(checkpointDir, 'checkpoint.sqlite');
    const { mkdir } = await import('node:fs/promises');
    const { CheckpointStore } = await import('../../src/session/checkpointStore.js');
    const { createInteractiveCheckpointJson } = await import('../../src/session/session.js');

    await mkdir(checkpointDir, { recursive: true });
    const store = new CheckpointStore(checkpointStoreFilename);
    store.save({
      sessionId: 'restored-session-multiline',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [
          { role: 'user', content: 'first line\nsecond line' },
          { role: 'assistant', content: 'assistant line one\nassistant line two' }
        ],
        historySummary: 'Multiline checkpoint preview'
      }),
      updatedAt: '2026-03-30T12:00:00.000Z'
    });

    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'fresh-session',
      readLine: (() => {
        const inputs = ['/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async () => {
        throw new Error('runTurn should not be called');
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      'Resumed checkpoint • 2 messages • summary available\n',
      '» first line\nsecond line\n',
      '──────────────────────────────────────────────────────\nassistant line one\nassistant line two\n'
    ]);
  });

  it('shows summary unavailable when resuming a checkpoint without a history summary', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-'));
    tempDirs.push(tempDir);

    const checkpointDir = join(tempDir, '.qiclaw');
    const checkpointStoreFilename = join(checkpointDir, 'checkpoint.sqlite');
    const { mkdir } = await import('node:fs/promises');
    const { CheckpointStore } = await import('../../src/session/checkpointStore.js');
    const { createInteractiveCheckpointJson } = await import('../../src/session/session.js');

    await mkdir(checkpointDir, { recursive: true });
    const store = new CheckpointStore(checkpointStoreFilename);
    store.save({
      sessionId: 'restored-session-no-summary',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [
          { role: 'user', content: 'first restored message' },
          { role: 'assistant', content: 'second restored message' }
        ]
      }),
      updatedAt: '2026-03-30T12:00:00.000Z'
    });

    const writes: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'fresh-session',
      readLine: (() => {
        const inputs = ['/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async () => {
        throw new Error('runTurn should not be called');
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    const output = stripAnsi(writes.join(''));
    expectContainsInOrder(output, [
      'Resumed checkpoint • 2 messages • summary unavailable\n',
      '» first restored message\n',
      '──────────────────────────────────────────────────────\nsecond restored message\n'
    ]);
  });

  it('ignores invalid interactive checkpoints and starts a new session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-'));
    tempDirs.push(tempDir);

    const checkpointDir = join(tempDir, '.qiclaw');
    const checkpointStoreFilename = join(checkpointDir, 'checkpoint.sqlite');
    const { mkdir } = await import('node:fs/promises');
    const { CheckpointStore } = await import('../../src/session/checkpointStore.js');

    await mkdir(checkpointDir, { recursive: true });
    const store = new CheckpointStore(checkpointStoreFilename);
    store.save({
      sessionId: 'invalid-session',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: JSON.stringify({ version: 999, history: 'bad' }),
      updatedAt: '2026-03-30T12:00:00.000Z'
    });

    const seenSessionIds: string[] = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'fresh-session',
      readLine: (() => {
        const inputs = ['new question', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        seenSessionIds.push(input.sessionId ?? 'missing');
        expect(input.history).toEqual([]);
        expect(input.historySummary).toBeUndefined();

        return {
          stopReason: 'completed',
          finalAnswer: 'fresh answer',
          history: [
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'fresh answer' }
          ],
          historySummary: 'fresh summary',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
  });

  it('continues interactive turns and logs debug telemetry when memory maintenance preflight fails on prepare or capture', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'));

    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-memory-failure-'));
    tempDirs.push(tempDir);

    let callCount = 0;
    const writes: string[] = [];
    const stderrWrites: string[] = [];
    const runTurnInputs: Array<{ userInput: string; memoryText?: string }> = [];
    const logPath = join(tempDir, 'memory-fallback.jsonl');
    const rotatedLogPath = join(tempDir, 'memory-fallback-2026-04-12.jsonl');
    const cli = buildCli({
      argv: ['--debug-log', logPath],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      stderr: {
        write(chunk) {
          stderrWrites.push(String(chunk));
          return true;
        }
      },
      prepareSessionMemory: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('prepare memory failed');
        }

        return {
          memoryText: '',
          store: {
            put: vi.fn(async () => undefined),
            seal: vi.fn(async () => undefined)
          } as never,
          globalStore: {
            put: vi.fn(async () => undefined),
            seal: vi.fn(async () => undefined)
          } as never,
          recalled: [],
          checkpointState: {
            storeSessionId: 'session-test-1',
            engine: 'file-session-memory-store',
            version: 1,
            memoryPath: join(tempDir, 'session-memory/index.json'),
            metaPath: join(tempDir, 'session-memory-meta.json'),
            totalEntries: 0,
            lastCompactedAt: null
          }
        };
      },
      captureTurnMemory: async () => {
        throw new Error('capture memory failed');
      },
      createRuntime: (runtimeOptions) => ({
        provider: createNoopTestProvider(),
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? createNoopObserver(),
        resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-test-1',
      readLine: (() => {
        const inputs = ['first question', 'remember my preference', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        runTurnInputs.push({ userInput: input.userInput, memoryText: input.memoryText });

        return {
          stopReason: 'completed',
          finalAnswer: `answer: ${input.userInput}`,
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: `answer: ${input.userInput}` }
          ],
          historySummary: `Summary after ${input.userInput}`,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true as const,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            finalAnswerIsSubstantive: true,
            toolEvidenceSatisfied: true,
            noUnresolvedToolErrors: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(runTurnInputs).toEqual([
      { userInput: 'first question', memoryText: '' },
      { userInput: 'remember my preference', memoryText: '' }
    ]);
    expect(stripAnsi(writes.join(''))).toContain('answer: first question');
    expect(stripAnsi(writes.join(''))).toContain('answer: remember my preference');
    expect(stderrWrites).toEqual([]);

    const loggedEvents = (await readFile(rotatedLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'interactive_memory_fallback');

    expect(loggedEvents).toEqual([
      expect.objectContaining({
        type: 'interactive_memory_fallback',
        stage: 'input_received',
        data: expect.objectContaining({
          sessionId: 'session-test-1',
          phase: 'prepare',
          message: 'prepare memory failed'
        })
      }),
      expect.objectContaining({
        type: 'interactive_memory_fallback',
        stage: 'input_received',
        data: expect.objectContaining({
          sessionId: 'session-test-1',
          phase: 'capture',
          message: 'capture memory failed'
        })
      })
    ]);
  });
});

describe('createJsonLineLogger', () => {
  it('serializes each event as one JSONL line', () => {
    const lines: string[] = [];
    const logger = createJsonLineLogger({
      appendLine(line) {
        lines.push(line);
      }
    });

    logger.record(createTelemetryEvent('turn_started', 'input_received', {
      turnId: 'turn-1',
      providerRound: 0,
      toolRound: 0,
      cwd: '/tmp/workspace',
      userInput: 'hello',
      maxToolRounds: 3,
      toolNames: []
    }));

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({
      type: 'turn_started',
      stage: 'input_received',
      data: {
        userInput: 'hello'
      }
    });
  });
});
