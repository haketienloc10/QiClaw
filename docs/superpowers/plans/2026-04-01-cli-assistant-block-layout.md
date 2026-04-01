# CLI Assistant Block Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render both prompt mode and interactive mode outputs as a structured assistant block with one blank line before `QiClaw`, two-space-indented body lines, indented tool activity lines, and a non-indented footer.

**Architecture:** Keep tool/footer formatting in `src/telemetry/display.ts` and add a small assistant block writer in the CLI render layer. Reuse the same writer for prompt mode and interactive mode so both flows share the same spacing, header, body indentation, and footer bypass behavior.

**Tech Stack:** TypeScript, Vitest, Node.js streams, existing CLI telemetry observer pipeline

---

## File structure

- `src/cli/main.ts`
  - Add the assistant block writer and wire it into prompt mode, interactive mode, and observer callbacks.
- `src/cli/repl.ts`
  - Keep REPL loop behavior, but allow caller-provided `writeLine` + `afterTurnRendered` to render the new block layout consistently.
- `tests/cli/repl.test.ts`
  - Add prompt-mode and interactive-mode regression tests for the new block layout.
- `src/telemetry/display.ts`
  - No business-format changes planned; keep current compact tool/footer line generation intact.

### Task 1: Lock the new output layout in tests

**Files:**
- Modify: `tests/cli/repl.test.ts:166-295`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing interactive layout test**

```ts
  it('renders interactive turns as an indented QiClaw block with a non-indented footer', async () => {
    const outputs: string[] = [];
    const inputs = ['first question', '/exit'];
    const repl = buildCli({
      argv: [],
      readLine: async () => inputs.shift(),
      stdout: {
        write(chunk) {
          outputs.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: '/tmp/qiclaw-test',
        observer: runtimeOptions.observer ?? { record() {} }
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 1,
          toolName: 'shell',
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
          toolCallsByName: { shell: 1 },
          inputTokensTotal: 516,
          outputTokensTotal: 274,
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

    await expect(repl.run()).resolves.toBe(0);
    expect(outputs.join('')).toContain('\n\nQiClaw\n  · shell git status\n  Tôi sẽ kiểm tra trước.\n  \n  Tóm tắt:\n  - xong\n─ completed • 2 provider • 1 tools • 516 in / 274 out • 4.8s\nGoodbye.\n');
  });
```

- [ ] **Step 2: Run the interactive test to verify it fails**

Run: `npm test -- --run tests/cli/repl.test.ts --testNamePattern="renders interactive turns as an indented QiClaw block with a non-indented footer"`
Expected: FAIL because current CLI writes plain final answers and tool lines without the `QiClaw` block or indentation.

- [ ] **Step 3: Write the failing prompt-mode layout test**

```ts
  it('renders prompt mode as an indented QiClaw block with the footer flush to column zero', async () => {
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
    expect(writes).toEqual([
      '\n',
      'QiClaw\n',
      '  · read /tmp/package.json\n',
      '  Tóm tắt:\n',
      '  - handled\n',
      '─ completed • 1 provider • 1 tools • 185 in / 15 out • 6.3s\n'
    ]);
  });
```

- [ ] **Step 4: Run the prompt-mode test to verify it fails**

Run: `npm test -- --run tests/cli/repl.test.ts --testNamePattern="renders prompt mode as an indented QiClaw block with the footer flush to column zero"`
Expected: FAIL because prompt mode currently writes tool lines and final answer directly to stdout without the blank line, header, indentation, or footer separation.

- [ ] **Step 5: Commit the failing tests**

```bash
git add tests/cli/repl.test.ts
git commit -m "test: lock CLI assistant block layout"
```

### Task 2: Add a shared assistant block writer in the CLI layer

**Files:**
- Modify: `src/cli/main.ts:45-214`
- Modify: `src/cli/repl.ts:23-63`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the assistant block writer in `src/cli/main.ts`**

Add a focused helper near the CLI wiring code:

```ts
function createAssistantBlockWriter(stdout: Pick<NodeJS.WriteStream, 'write'>): {
  writeAssistantLine(text: string): void;
  writeAssistantTextBlock(text: string): void;
  writeFooterLine(text: string): void;
  resetTurn(): void;
} {
  let started = false;

  function ensurePrelude(): void {
    if (started) {
      return;
    }

    stdout.write('\n');
    stdout.write('QiClaw\n');
    started = true;
  }

  return {
    writeAssistantLine(text: string) {
      ensurePrelude();
      stdout.write(`  ${text}\n`);
    },
    writeAssistantTextBlock(text: string) {
      ensurePrelude();
      for (const line of text.split('\n')) {
        stdout.write(`  ${line}\n`);
      }
    },
    writeFooterLine(text: string) {
      stdout.write(`${text}\n`);
    },
    resetTurn() {
      started = false;
    }
  };
}
```

- [ ] **Step 2: Wire the block writer into `createCliObserver(...)`**

Replace the current observer callbacks so tool lines and footer lines take different paths:

```ts
        const assistantWriter = createAssistantBlockWriter(stdout);
        const cliObserver = createCliObserver({
          cwd,
          stdout,
          metrics,
          debugLogPath: parsed.debugLogPath,
          envDebugLogPath: process.env.QICLAW_DEBUG_LOG,
          showCompactToolStatus: true,
          writeAssistantLine(text) {
            assistantWriter.writeAssistantLine(text);
          },
          writeFooterLine(text) {
            assistantWriter.writeFooterLine(text);
          }
        });
```

and update the observer factory signature accordingly:

```ts
function createCliObserver(options: {
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  metrics: TelemetryObserver;
  debugLogPath?: string;
  envDebugLogPath?: string;
  showCompactToolStatus?: boolean;
  writeAssistantLine(text: string): void;
  writeFooterLine(text: string): void;
}): {
  observer: TelemetryObserver;
  flushPendingFooter(): void;
} {
```

- [ ] **Step 3: Split tool-line and footer callbacks in `src/telemetry/display.ts` usage**

When constructing the compact observer, use two separate callbacks rather than one generic `writeLine` path:

```ts
    compactObserver = createCompactCliTelemetryObserver({
      writeLine(text) {
        options.writeAssistantLine(text);
      },
      writeFooterLine(text) {
        options.writeFooterLine(text);
      }
    });
```

If `src/telemetry/display.ts` needs a small interface update to support the second callback, make that change without touching the formatting logic itself.

- [ ] **Step 4: Render prompt-mode final answers through the assistant block writer**

Replace direct prompt-mode stdout writing:

```ts
          const result = await repl.runOnce(parsed.prompt);
          assistantWriter.writeAssistantTextBlock(result.finalAnswer);
          cliObserver.flushPendingFooter();
          assistantWriter.resetTurn();
          return 0;
```

- [ ] **Step 5: Render interactive-mode final answers through the same block writer**

Pass assistant-aware handlers into `createRepl(...)`:

```ts
          writeLine(text) {
            assistantWriter.writeAssistantTextBlock(text);
          },
          afterTurnRendered() {
            cliObserver.flushPendingFooter();
            assistantWriter.resetTurn();
          }
```

Keep `/exit` and `Goodbye.` unchanged by leaving that responsibility inside `src/cli/repl.ts`.

- [ ] **Step 6: Run the two new tests to verify they pass**

Run: `npm test -- --run tests/cli/repl.test.ts --testNamePattern="indented QiClaw block"`
Expected: PASS for both prompt mode and interactive mode layout tests.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/cli/main.ts src/cli/repl.ts tests/cli/repl.test.ts
git commit -m "feat: render CLI assistant output as blocks"
```

### Task 3: Verify regressions and keep footer behavior intact

**Files:**
- Modify: `tests/cli/repl.test.ts:195-355` (if any assertion tuning is needed)
- Test: `tests/cli/repl.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Re-run existing compact output tests**

Run: `npm test -- --run tests/cli/repl.test.ts tests/telemetry/display.test.ts`
Expected: PASS, including safe tool summaries and unchanged footer format.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS with all existing tests green.

- [ ] **Step 3: Inspect the final diff for scope control**

Run: `git diff -- src/cli/main.ts src/cli/repl.ts tests/cli/repl.test.ts src/telemetry/display.ts tests/telemetry/display.test.ts`
Expected: Only CLI render-layer wiring, any minimal observer callback adjustments, and test updates for the new block layout.

- [ ] **Step 4: Commit any final assertion or wiring cleanup if needed**

```bash
git add src/cli/main.ts src/cli/repl.ts tests/cli/repl.test.ts src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "test: verify CLI assistant block layout"
```
