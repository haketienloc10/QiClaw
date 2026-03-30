import { describe, expect, it } from 'vitest';

import { buildCli } from '../../src/cli/main.js';
import { createRepl } from '../../src/cli/repl.js';
import { createJsonLineLogger } from '../../src/telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../../src/telemetry/metrics.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

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
