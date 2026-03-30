import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCli } from '../../src/cli/main.js';
import { createRepl } from '../../src/cli/repl.js';
import { createJsonLineLogger } from '../../src/telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../../src/telemetry/metrics.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

const tempDirs: string[] = [];

afterEach(async () => {
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
  it('returns an object with a run method', () => {
    const cli = buildCli();

    expect(cli).toBeTypeOf('object');
    expect(cli.run).toBeTypeOf('function');
  });

  it('runs a prompt through the runtime turn runner and prints the final answer', async () => {
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
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: '/tmp/qiclaw-test',
        observer: runtimeOptions.observer ?? { record() {} }
      }),
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
          { role: 'assistant', content: 'Calling Read tool.' },
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
          { role: 'assistant', content: 'Calling Read tool.' },
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
