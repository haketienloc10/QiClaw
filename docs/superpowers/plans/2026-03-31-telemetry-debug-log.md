# Telemetry Debug Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compact CLI tool activity display plus optional full redacted JSONL debug logging for tool call/tool result telemetry.

**Architecture:** Keep `runAgentTurn(...)` as the single source of truth for execution events, enrich tool telemetry payloads there, and fan out one observer pipeline into metrics, compact CLI display, and optional debug JSONL logging. Redaction and preview generation live in focused telemetry helpers so CLI output stays minimal while debug files receive detailed but sanitized events.

**Tech Stack:** TypeScript, Node.js fs/path utilities, existing observer-based telemetry pipeline, Vitest.

---

## File map

### Existing files to modify

- `src/telemetry/observer.ts`
  - Extend tool event payload typing so loop, display observer, and debug logger share one consistent contract.
- `src/agent/loop.ts`
  - Emit enriched `tool_call_started` / `tool_call_completed` events with preview and redacted payloads.
- `src/cli/main.ts`
  - Parse `--debug-log`, read `QICLAW_DEBUG_LOG`, create log directories, and compose metrics + display + optional JSONL observers.
- `tests/agent/loop.test.ts`
  - Lock enriched telemetry payloads and redaction behavior in the core loop.
- `tests/cli/repl.test.ts`
  - Lock CLI flag/env precedence, compact tool display, and JSONL file output.

### New files to create

- `src/telemetry/composite.ts`
  - Tiny fan-out helper for multiple telemetry observers.
- `src/telemetry/display.ts`
  - CLI-facing compact tool activity observer.
- `src/telemetry/redaction.ts`
  - Recursive redaction helper for sensitive keys.
- `src/telemetry/preview.ts`
  - Deterministic preview builder for tool input/result payloads.
- `tests/telemetry/composite.test.ts`
  - Unit tests for observer fan-out.
- `tests/telemetry/display.test.ts`
  - Unit tests for compact CLI status messages.
- `tests/telemetry/redaction.test.ts`
  - Unit tests for nested sensitive key redaction.
- `tests/telemetry/preview.test.ts`
  - Unit tests for deterministic serialization/truncation.

## Task 1: Add telemetry helper coverage first

**Files:**
- Create: `tests/telemetry/composite.test.ts`
- Create: `tests/telemetry/display.test.ts`
- Create: `tests/telemetry/redaction.test.ts`
- Create: `tests/telemetry/preview.test.ts`
- Read for reference: `src/telemetry/observer.ts`

- [ ] **Step 1: Write the failing composite observer test**

```ts
import { describe, expect, it, vi } from 'vitest';

import { createCompositeObserver } from '../../src/telemetry/composite.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompositeObserver', () => {
  it('fans out each event to every observer in order', () => {
    const first = { record: vi.fn() };
    const second = { record: vi.fn() };
    const observer = createCompositeObserver([first, second]);
    const event = createTelemetryEvent('turn_started', { userInput: 'hello' });

    observer.record(event);

    expect(first.record).toHaveBeenCalledWith(event);
    expect(second.record).toHaveBeenCalledWith(event);
    expect(first.record.mock.invocationCallOrder[0]).toBeLessThan(second.record.mock.invocationCallOrder[0]);
  });
});
```

- [ ] **Step 2: Write the failing display observer test**

```ts
import { describe, expect, it } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompactCliTelemetryObserver', () => {
  it('prints only compact tool status lines', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', {
      toolName: 'read_file',
      toolCallId: 'call-1',
      inputPreview: '{"path":"note.txt"}',
      inputRawRedacted: { path: 'note.txt' }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', {
      toolName: 'read_file',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'agent note',
      resultRawRedacted: { content: 'agent note' }
    }));

    expect(lines).toEqual(['Tool: read_file', 'Tool: read_file done']);
  });
});
```

- [ ] **Step 3: Write the failing redaction helper test**

```ts
import { describe, expect, it } from 'vitest';

import { redactSensitiveTelemetryValue } from '../../src/telemetry/redaction.js';

describe('redactSensitiveTelemetryValue', () => {
  it('redacts nested sensitive keys case-insensitively', () => {
    expect(redactSensitiveTelemetryValue({
      apiKey: 'top-secret',
      headers: {
        Authorization: 'Bearer abc',
        nested: [{ refreshToken: 'refresh-secret' }]
      },
      safe: 'visible'
    })).toEqual({
      apiKey: '[REDACTED]',
      headers: {
        Authorization: '[REDACTED]',
        nested: [{ refreshToken: '[REDACTED]' }]
      },
      safe: 'visible'
    });
  });
});
```

- [ ] **Step 4: Write the failing preview helper test**

```ts
import { describe, expect, it } from 'vitest';

import { buildTelemetryPreview } from '../../src/telemetry/preview.js';

describe('buildTelemetryPreview', () => {
  it('serializes values deterministically and truncates long output', () => {
    expect(buildTelemetryPreview({ path: 'note.txt', limit: 10 })).toBe('{"limit":10,"path":"note.txt"}');
    expect(buildTelemetryPreview({ content: 'x'.repeat(200) }, 32)).toBe('{"content":"xxxxxxxxxxxxxxxxxxxx...');
  });
});
```

- [ ] **Step 5: Run helper tests to verify they fail**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/telemetry/composite.test.ts tests/telemetry/display.test.ts tests/telemetry/redaction.test.ts tests/telemetry/preview.test.ts`
Expected: FAIL with module-not-found errors for the new telemetry helper files.

- [ ] **Step 6: Commit the failing test scaffold**

```bash
git add tests/telemetry/composite.test.ts tests/telemetry/display.test.ts tests/telemetry/redaction.test.ts tests/telemetry/preview.test.ts
git commit -m "test: add telemetry helper coverage"
```

## Task 2: Implement focused telemetry helpers

**Files:**
- Create: `src/telemetry/composite.ts`
- Create: `src/telemetry/display.ts`
- Create: `src/telemetry/redaction.ts`
- Create: `src/telemetry/preview.ts`
- Test: `tests/telemetry/composite.test.ts`
- Test: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/redaction.test.ts`
- Test: `tests/telemetry/preview.test.ts`

- [ ] **Step 1: Implement the composite observer**

```ts
import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export function createCompositeObserver(observers: TelemetryObserver[]): TelemetryObserver {
  return {
    record(event: TelemetryEvent) {
      for (const observer of observers) {
        observer.record(event);
      }
    }
  };
}
```

- [ ] **Step 2: Implement the redaction helper**

```ts
const REDACTED = '[REDACTED]';
const sensitiveKeyPattern = /(?:api[-_]?key|authorization|token|access[-_]?token|refresh[-_]?token|secret)/iu;

export function redactSensitiveTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveTelemetryValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sensitiveKeyPattern.test(key) ? REDACTED : redactSensitiveTelemetryValue(entry)
      ])
    );
  }

  return value;
}
```

- [ ] **Step 3: Implement the deterministic preview helper**

```ts
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)])
    );
  }

  return value;
}

export function buildTelemetryPreview(value: unknown, maxLength = 160): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(sortValue(value));
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 3)}...`;
}
```

- [ ] **Step 4: Implement the compact CLI display observer**

```ts
import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export interface CompactCliTelemetryObserverOptions {
  writeLine(text: string): void;
}

export function createCompactCliTelemetryObserver(
  options: CompactCliTelemetryObserverOptions
): TelemetryObserver {
  return {
    record(event: TelemetryEvent) {
      if (event.type === 'tool_call_started') {
        options.writeLine(`Tool: ${String(event.data.toolName)}`);
        return;
      }

      if (event.type === 'tool_call_completed') {
        const suffix = event.data.isError === true ? 'failed' : 'done';
        options.writeLine(`Tool: ${String(event.data.toolName)} ${suffix}`);
      }
    }
  };
}
```

- [ ] **Step 5: Run helper tests to verify they pass**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/telemetry/composite.test.ts tests/telemetry/display.test.ts tests/telemetry/redaction.test.ts tests/telemetry/preview.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the helper implementation**

```bash
git add src/telemetry/composite.ts src/telemetry/display.ts src/telemetry/redaction.ts src/telemetry/preview.ts tests/telemetry/composite.test.ts tests/telemetry/display.test.ts tests/telemetry/redaction.test.ts tests/telemetry/preview.test.ts
git commit -m "feat: add telemetry helper pipeline"
```

## Task 3: Enrich tool telemetry events in the core loop

**Files:**
- Modify: `src/telemetry/observer.ts`
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`
- Read for reference: `src/provider/model.ts`

- [ ] **Step 1: Write the failing loop telemetry assertions**

Add this assertion block to `tests/agent/loop.test.ts` inside the existing telemetry integration test after `expect(observedEvents[3]).toMatchObject(...)`:

```ts
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
        resultPreview: 'agent note',
        resultRawRedacted: 'agent note'
      }
    });
```

Add a second test for redaction near the other telemetry tests:

```ts
  it('redacts sensitive tool payload values before recording telemetry details', async () => {
    const observedEvents: TelemetryEvent[] = [];
    const provider = createScriptedProvider([
      {
        message: { role: 'assistant', content: 'I will call the shell tool.' },
        toolCalls: [
          {
            id: 'call-shell-secret',
            name: 'shell',
            input: {
              command: 'printenv',
              args: ['API_KEY=secret-value', 'Authorization=Bearer abc']
            }
          }
        ]
      },
      {
        message: { role: 'assistant', content: 'Done.' },
        toolCalls: []
      }
    ]);

    await runAgentTurn({
      provider,
      availableTools: [
        {
          ...shellTool,
          async execute() {
            return {
              content: JSON.stringify({ token: 'tool-secret', ok: true })
            };
          }
        }
      ],
      baseSystemPrompt: 'You are helpful.',
      userInput: 'Run shell safely.',
      cwd: '/tmp/runtime-redaction',
      maxToolRounds: 2,
      observer: {
        record(event) {
          observedEvents.push(event);
        }
      }
    });

    expect(observedEvents[3]).toMatchObject({
      type: 'tool_call_started',
      data: {
        inputRawRedacted: {
          command: 'printenv',
          args: ['API_KEY=secret-value', 'Authorization=Bearer abc']
        }
      }
    });
    expect(observedEvents[4]).toMatchObject({
      type: 'tool_call_completed',
      data: {
        resultRawRedacted: '{"token":"tool-secret","ok":true}'
      }
    });
  });
```

- [ ] **Step 2: Run the loop test file to verify the new assertions fail**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/agent/loop.test.ts`
Expected: FAIL because the recorded tool telemetry events do not yet include `inputPreview`, `inputRawRedacted`, `resultPreview`, or `resultRawRedacted`.

- [ ] **Step 3: Extend telemetry event typing for tool events**

Update `src/telemetry/observer.ts` to this structure:

```ts
export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ToolCallStartedTelemetryData extends Record<string, unknown> {
  toolName: string;
  toolCallId: string;
  inputPreview: string;
  inputRawRedacted: unknown;
}

export interface ToolCallCompletedTelemetryData extends Record<string, unknown> {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  resultPreview: string;
  resultRawRedacted: unknown;
}
```

Keep `createTelemetryEvent(...)` unchanged so callers can keep using the same helper.

- [ ] **Step 4: Enrich tool telemetry payloads in `runAgentTurn(...)`**

Update the tool-event sections in `src/agent/loop.ts`:

```ts
import { buildTelemetryPreview } from '../telemetry/preview.js';
import { redactSensitiveTelemetryValue } from '../telemetry/redaction.js';
```

```ts
        observer.record(
          createTelemetryEvent('tool_call_started', {
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            inputPreview: buildTelemetryPreview(toolCall.input),
            inputRawRedacted: redactSensitiveTelemetryValue(toolCall.input)
          })
        );

        const toolResult = await dispatchAllowedToolCall(toolCall, input.availableTools, input.cwd);
        history.push(toolResult);

        observer.record(
          createTelemetryEvent('tool_call_completed', {
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            isError: toolResult.isError,
            resultPreview: buildTelemetryPreview(toolResult.content),
            resultRawRedacted: redactSensitiveTelemetryValue(toolResult.content)
          })
        );
```

- [ ] **Step 5: Tighten the redaction test to match the final sanitized behavior**

Replace the temporary expectations from Step 1 with this final assertion block so the loop test actually verifies redaction took place on parsed JSON strings too:

```ts
    expect(observedEvents[4]).toMatchObject({
      type: 'tool_call_completed',
      data: {
        resultRawRedacted: {
          token: '[REDACTED]',
          ok: true
        }
      }
    });
```

And update the implementation to sanitize stringified JSON results before recording them:

```ts
function toTelemetryDebugValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return redactSensitiveTelemetryValue(value);
  }

  try {
    return redactSensitiveTelemetryValue(JSON.parse(value));
  } catch {
    return redactSensitiveTelemetryValue(value);
  }
}
```

Use `toTelemetryDebugValue(...)` for both tool input and tool result raw payloads.

- [ ] **Step 6: Run the loop test file to verify it passes**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/agent/loop.test.ts`
Expected: PASS

- [ ] **Step 7: Commit the enriched loop telemetry**

```bash
git add src/telemetry/observer.ts src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: enrich tool telemetry events"
```

## Task 4: Wire compact CLI display and optional debug JSONL logging

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `tests/cli/repl.test.ts`
- Read for reference: `src/telemetry/logger.ts`
- Read for reference: `src/telemetry/metrics.ts`
- Read for reference: `src/telemetry/composite.ts`
- Read for reference: `src/telemetry/display.ts`

- [ ] **Step 1: Write the failing CLI tests for flag/env precedence and output separation**

Add this test near the other prompt-mode CLI tests in `tests/cli/repl.test.ts`:

```ts
  it('prints compact tool status lines without leaking raw payloads', async () => {
    const writes: string[] = [];
    const observedEvents: Array<Parameters<NonNullable<ReturnType<typeof buildCli>['run']>>[0]> = [];
    const cli = buildCli({
      argv: ['--prompt', 'inspect package.json'],
      cwd: '/tmp/qiclaw-telemetry-display',
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: runtimeOptions.cwd,
        observer: runtimeOptions.observer ?? { record() {} }
      }),
      runTurn: async (input) => {
        const observer = input.observer;
        observer?.record(createTelemetryEvent('tool_call_started', {
          toolName: 'read_file',
          toolCallId: 'call-1',
          inputPreview: '{"path":"package.json"}',
          inputRawRedacted: { path: 'package.json', apiKey: '[REDACTED]' }
        }));
        observer?.record(createTelemetryEvent('tool_call_completed', {
          toolName: 'read_file',
          toolCallId: 'call-1',
          isError: false,
          resultPreview: '{"name":"qiclaw"}',
          resultRawRedacted: { name: 'qiclaw', token: '[REDACTED]' }
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
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(writes).toEqual([
      'Tool: read_file\n',
      'Tool: read_file done\n',
      'handled: inspect package.json\n'
    ]);
    expect(writes.join('')).not.toContain('[REDACTED]');
    expect(writes.join('')).not.toContain('package.json"}');
  });
```

Add this env/flag precedence test:

```ts
  it('prefers --debug-log over QICLAW_DEBUG_LOG and writes JSONL events to the selected file', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-debug-log-'));
      tempDirs.push(tempDir);
      const envLogPath = join(tempDir, 'env-debug.jsonl');
      const flagLogPath = join(tempDir, 'flag-debug.jsonl');

      process.env.QICLAW_DEBUG_LOG = envLogPath;

      const cli = buildCli({
        argv: ['--debug-log', flagLogPath, '--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: runtimeOptions.cwd,
          observer: runtimeOptions.observer ?? { record() {} }
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('tool_call_started', {
            toolName: 'read_file',
            toolCallId: 'call-1',
            inputPreview: '{"path":"package.json"}',
            inputRawRedacted: { path: 'package.json', apiKey: '[REDACTED]' }
          }));

          return {
            stopReason: 'completed',
            finalAnswer: 'handled',
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
              toolMessagesCount: 0,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);
      await expect(readFile(flagLogPath, 'utf8')).resolves.toContain('"tool_call_started"');
      await expect(readFile(flagLogPath, 'utf8')).resolves.toContain('"apiKey":"[REDACTED]"');
      await expect(readFile(envLogPath, 'utf8')).rejects.toThrow();
    });
  });
```

Add this env fallback test:

```ts
  it('uses QICLAW_DEBUG_LOG when --debug-log is omitted', async () => {
    await withProviderEnvSnapshot(async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-debug-env-'));
      tempDirs.push(tempDir);
      const logPath = join(tempDir, 'debug.jsonl');

      process.env.QICLAW_DEBUG_LOG = logPath;

      const cli = buildCli({
        argv: ['--prompt', 'inspect package.json'],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: runtimeOptions.cwd,
          observer: runtimeOptions.observer ?? { record() {} }
        }),
        runTurn: async (input) => {
          input.observer?.record(createTelemetryEvent('tool_call_completed', {
            toolName: 'read_file',
            toolCallId: 'call-1',
            isError: false,
            resultPreview: '{"name":"qiclaw"}',
            resultRawRedacted: { name: 'qiclaw' }
          }));

          return {
            stopReason: 'completed',
            finalAnswer: 'handled',
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
              toolMessagesCount: 0,
              checks: []
            }
          };
        }
      });

      await expect(cli.run()).resolves.toBe(0);
      await expect(readFile(logPath, 'utf8')).resolves.toContain('"tool_call_completed"');
    });
  });
```

- [ ] **Step 2: Run the CLI test file to verify the new assertions fail**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts`
Expected: FAIL because `buildCli(...)` does not yet accept `--debug-log`, does not wire observer composition for display logging, and does not write debug JSONL files.

- [ ] **Step 3: Extend the CLI turn input type so tests can inject telemetry through the configured observer**

Update `src/cli/main.ts`:

```ts
type CliRunTurnInput = RunAgentTurnInput & {
  sessionId?: string;
};
```

Keep that type, but pass `observer` into every `executeTurn(...)` call so custom `runTurn` test doubles can use the same observer pipeline:

```ts
              observer
```

This line belongs in both prompt mode and interactive mode `executeTurn(...)` calls.

- [ ] **Step 4: Add `--debug-log` parsing and env fallback**

Update the `parseArgs(...)` return type and body in `src/cli/main.ts`:

```ts
function parseArgs(argv: string[]): {
  prompt?: string;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  debugLog?: string;
} {
  let debugLog: string | undefined;
```

Add a parser branch:

```ts
    if (token === '--debug-log') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --debug-log');
      }

      debugLog = value;
      index += 1;
      continue;
    }
```

Return it:

```ts
  return {
    prompt,
    provider,
    model,
    baseUrl,
    apiKey,
    debugLog
  };
}
```

In `run()`, resolve the log path with CLI precedence:

```ts
        const parsed = parseArgs(argv);
        const debugLogPath = parsed.debugLog ?? process.env.QICLAW_DEBUG_LOG;
```

- [ ] **Step 5: Compose metrics, display, and optional debug logger observers**

Add the imports in `src/cli/main.ts`:

```ts
import { resolve } from 'node:path';
import { createCompositeObserver } from '../telemetry/composite.js';
import { createCompactCliTelemetryObserver } from '../telemetry/display.js';
import { createFileJsonLineWriter, createJsonLineLogger } from '../telemetry/logger.js';
```

Replace the metrics-only observer setup with:

```ts
        const metrics = createInMemoryMetricsObserver();
        const displayObserver = createCompactCliTelemetryObserver({
          writeLine(text) {
            stdout.write(`${text}\n`);
          }
        });
        const observers = [metrics, displayObserver];

        if (debugLogPath) {
          const resolvedDebugLogPath = resolve(cwd, debugLogPath);
          mkdirSync(dirname(resolvedDebugLogPath), { recursive: true });
          observers.push(createJsonLineLogger(createFileJsonLineWriter(resolvedDebugLogPath)));
        }

        const runtime = createRuntime({
          ...providerConfig,
          cwd,
          observer: createCompositeObserver(observers)
        });
```

- [ ] **Step 6: Add the missing parse-error test and implementation for `--debug-log`**

Add this test in `tests/cli/repl.test.ts` next to the other missing-value tests:

```ts
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
```

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts`
Expected: PASS

- [ ] **Step 7: Commit the CLI wiring work**

```bash
git add src/cli/main.ts tests/cli/repl.test.ts
git commit -m "feat: wire cli telemetry debug logging"
```

## Task 5: Run the focused verification suite and tidy the plan scope

**Files:**
- Verify: `tests/telemetry/composite.test.ts`
- Verify: `tests/telemetry/display.test.ts`
- Verify: `tests/telemetry/redaction.test.ts`
- Verify: `tests/telemetry/preview.test.ts`
- Verify: `tests/agent/loop.test.ts`
- Verify: `tests/cli/repl.test.ts`

- [ ] **Step 1: Run the telemetry-focused test suite**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/telemetry/composite.test.ts tests/telemetry/display.test.ts tests/telemetry/redaction.test.ts tests/telemetry/preview.test.ts tests/agent/loop.test.ts tests/cli/repl.test.ts`
Expected: PASS

- [ ] **Step 2: Run the full project test suite**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test`
Expected: PASS

- [ ] **Step 3: Inspect git diff before the final commit**

Run: `git -C "/home/locdt/Notes/VSCode/QiClaw" diff -- src/telemetry src/agent/loop.ts src/cli/main.ts tests/telemetry tests/agent/loop.test.ts tests/cli/repl.test.ts`
Expected: Diff only shows telemetry helper additions, enriched tool event payloads, CLI observer wiring, and matching tests.

- [ ] **Step 4: Create the final integration commit**

```bash
git add src/telemetry/composite.ts src/telemetry/display.ts src/telemetry/redaction.ts src/telemetry/preview.ts src/telemetry/observer.ts src/agent/loop.ts src/cli/main.ts tests/telemetry/composite.test.ts tests/telemetry/display.test.ts tests/telemetry/redaction.test.ts tests/telemetry/preview.test.ts tests/agent/loop.test.ts tests/cli/repl.test.ts
git commit -m "feat: add cli telemetry debug logging"
```

- [ ] **Step 5: Manual smoke check of prompt-mode debug logging**

Run: `node ./dist/cli/main.js --debug-log .qiclaw/debug.jsonl --prompt "inspect package.json"`
Expected: stdout shows only compact tool lines plus final answer; `.qiclaw/debug.jsonl` contains JSON lines with enriched tool telemetry fields such as `inputPreview`, `inputRawRedacted`, `resultPreview`, and `resultRawRedacted`.

---

## Self-review checklist

### Spec coverage

- Compact CLI display: covered by Task 1/2 display observer tests and implementation, plus Task 4 CLI wiring/tests.
- Optional JSONL debug logging: covered by Task 4 flag/env parsing, logger composition, and CLI file-output tests.
- Redaction default: covered by Task 1/2 redaction helper and Task 3 loop redaction integration test.
- Enriched tool call/result telemetry payloads: covered by Task 3 observer typing + loop integration tests.
- Flag over env precedence: covered by Task 4 CLI tests.

### Placeholder scan

- No `TODO`, `TBD`, “similar to above”, or missing command placeholders remain.
- Each code-changing task includes the concrete code block or assertion block to add.

### Type consistency

- New helper names are consistent across tasks:
  - `createCompositeObserver`
  - `createCompactCliTelemetryObserver`
  - `redactSensitiveTelemetryValue`
  - `buildTelemetryPreview`
- Tool event field names are consistent across tasks:
  - `inputPreview`
  - `inputRawRedacted`
  - `resultPreview`
  - `resultRawRedacted`
