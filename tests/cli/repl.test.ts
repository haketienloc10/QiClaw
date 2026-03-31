import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCli, type CliRunTurnResult } from '../../src/cli/main.js';
import { createRepl } from '../../src/cli/repl.js';
import { getDefaultModelForProvider, parseProviderId, resolveProviderConfig } from '../../src/provider/config.js';
import { createJsonLineLogger } from '../../src/telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../../src/telemetry/metrics.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

const tempDirs: string[] = [];
const providerEnvKeys = [
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
      requiresNonEmptyFinalAnswer: true,
      requiresToolEvidence: false
    },
    verification: {
      isVerified: true,
      finalAnswerIsNonEmpty: true,
      toolEvidenceSatisfied: true,
      toolMessagesCount: 0,
      checks: []
    }
  });
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
      promptLabel: 'qiclaw> ',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `echo: ${input}`,
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          toolEvidenceSatisfied: true,
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

  it('tracks telemetry metrics deterministically from loop-level events', () => {
    const metrics = createInMemoryMetricsObserver();

    metrics.record(createTelemetryEvent('turn_started'));
    metrics.record(createTelemetryEvent('tool_call_completed', { toolName: 'read_file' }));
    metrics.record(createTelemetryEvent('turn_completed'));

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
      promptLabel: 'qiclaw> ',
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: `answer: ${input}`,
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          toolEvidenceSatisfied: true,
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
});

describe('buildCli', () => {
  it('keeps prompt mode stdout limited to the final answer even when tool telemetry events are recorded', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-telemetry-'));
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
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', {
          toolName: 'Read',
          toolCallId: 'toolu_1',
          payload: { path: '/tmp/package.json', raw: 'secret payload' }
        }));
        input.observer?.record(createTelemetryEvent('tool_call_completed', {
          toolName: 'Read',
          toolCallId: 'toolu_1',
          isError: false,
          payload: { content: '{"name":"secret"}' }
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(writes).toEqual(['handled: inspect package.json\n']);
    expect(writes.join('')).not.toContain('Tool: Read');
    expect(writes.join('')).not.toContain('secret payload');
    expect(writes.join('')).not.toContain('{"name":"secret"}');
  });

  it('prefers --debug-log over QICLAW_DEBUG_LOG and writes JSONL events to the selected file', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-debug-log-'));
      tempDirs.push(tempDir);

      const envLogPath = join(tempDir, 'from-env', 'telemetry.jsonl');
      const flagLogPath = join(tempDir, 'from-flag', 'telemetry.jsonl');
      process.env.QICLAW_DEBUG_LOG = envLogPath;

      const cli = buildCli({
        argv: ['--debug-log', flagLogPath, '--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? { record() {} }
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('tool_call_started', {
            toolName: 'Read',
            toolCallId: 'toolu_1'
          }));

          return {
            stopReason: 'completed',
            finalAnswer: `handled: ${input.userInput}`,
            history: [],
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              toolEvidenceSatisfied: true,
              toolMessagesCount: 1,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(flagLogPath, 'utf8');
      expect(selectedLog).toContain('"type":"tool_call_started"');
      await expect(readFile(envLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('falls back to QICLAW_DEBUG_LOG when --debug-log is not provided', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-debug-log-env-'));
      tempDirs.push(tempDir);

      const envLogPath = join(tempDir, 'from-env', 'telemetry.jsonl');
      process.env.QICLAW_DEBUG_LOG = envLogPath;

      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? { record() {} }
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('turn_started', {
            userInput: input.userInput
          }));

          return {
            stopReason: 'completed',
            finalAnswer: `handled: ${input.userInput}`,
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              toolEvidenceSatisfied: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(envLogPath, 'utf8');
      expect(selectedLog).toContain('"type":"turn_started"');
    });
  });

  it('records provider telemetry events to the debug JSONL log without changing prompt-mode stdout', async () => {
    await withProviderEnvSnapshot(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-31T12:34:56.000Z'));

      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-debug-log-'));
      tempDirs.push(tempDir);

      const logPath = join(tempDir, 'provider', 'telemetry.jsonl');
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
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? { record() {} }
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('provider_called', {
            messageCount: 2,
            promptRawChars: 42,
            toolNames: ['Read'],
            messageSummaries: [
              {
                role: 'system',
                rawChars: 67,
                contentBlockCount: 1
              },
              {
                role: 'user',
                rawChars: 40,
                contentBlockCount: 1
              }
            ],
            totalContentBlockCount: 2,
            hasSystemPrompt: true,
            promptRawPreviewRedacted: '{"messages":[{"role":"system"},{"role":"user"}]}'
          }));
          input.observer?.record(createTelemetryEvent('provider_responded', {
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
            responsePreviewRedacted: '[{"type":"text","text":"handled"}]'
          }));

          return {
            stopReason: 'completed',
            finalAnswer: `handled: ${input.userInput}`,
            history: [],
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: input.userInput,
              checklist: [input.userInput],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              toolEvidenceSatisfied: true,
              toolMessagesCount: 0,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);

      const selectedLog = await readFile(logPath, 'utf8');
      const events = selectedLog
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      const providerCalledEvent = events.find((event) => event.type === 'provider_called');
      const providerRespondedEvent = events.find((event) => event.type === 'provider_responded');

      expect(providerCalledEvent).toEqual(
        expect.objectContaining({
          type: 'provider_called',
          timestamp: '2026-03-31T12:34:56.000Z',
          data: expect.objectContaining({
            promptRawChars: 42
          })
        })
      );
      expect(providerRespondedEvent).toEqual(
        expect.objectContaining({
          type: 'provider_responded',
          timestamp: '2026-03-31T12:34:56.000Z',
          data: expect.objectContaining({
            usage: expect.objectContaining({
              totalTokens: 20
            }),
            responseContentBlockCount: 1
          })
        })
      );
      expect(stdoutWrites).toEqual(['handled: inspect package.json\n']);
    });
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
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_MODEL;

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
          expect(runtimeOptions.provider).toBe('anthropic');
          expect(runtimeOptions.model).toBe('claude-opus-4-6');

          return {
            provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
            availableTools: [],
            cwd: '/tmp/qiclaw-test',
            observer: runtimeOptions.observer ?? { record() {} }
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(writes).toEqual(['handled: inspect package.json\n']);
    });
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
            observer: runtimeOptions.observer ?? { record() {} }
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(writes).toEqual(['handled: inspect package.json\n']);
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
            observer: runtimeOptions.observer ?? { record() {} }
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        })
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(writes).toEqual(['handled: inspect package.json\n']);
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
          observer: runtimeOptions.observer ?? { record() {} }
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
          requiresNonEmptyFinalAnswer: true,
          requiresToolEvidence: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          toolEvidenceSatisfied: true,
          toolMessagesCount: 0,
          checks: []
        }
      })
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(writes).toEqual(['handled: inspect package.json\n']);
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
            observer: runtimeOptions.observer ?? { record() {} }
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
            observer: runtimeOptions.observer ?? { record() {} }
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
            observer: runtimeOptions.observer ?? { record() {} }
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
            observer: runtimeOptions.observer ?? { record() {} }
          };
        },
        stdout: { write() { return true; } },
        runTurn: createSuccessfulRunTurn()
      });

      await expect(cli.run()).resolves.toBe(0);
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
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
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
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              toolEvidenceSatisfied: true,
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
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
    expect(writes).toEqual(['answer: first question\n', 'answer: second question\n', 'Goodbye.\n']);

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
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
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
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false
            },
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              toolEvidenceSatisfied: true,
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
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
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(writes).toEqual(['handled: inspect package.json\n']);
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

    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: {
        write() {
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 1,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
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
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
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
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(seenSessionIds).toEqual(['fresh-session']);
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

    logger.record(createTelemetryEvent('turn_started', { userInput: 'hello' }));

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({
      type: 'turn_started',
      data: {
        userInput: 'hello'
      }
    });
  });
});
