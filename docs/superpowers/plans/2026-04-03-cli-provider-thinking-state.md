# CLI Provider Thinking State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm cho CLI hiển thị `QiClaw` ngay khi một provider round bắt đầu và render provider status theo kiểu `🧠 Thinking.` / `🧠 Thinking..` / `🧠 Thinking...`, sau đó thay bằng `✓ Responding` trước mọi output thật hoặc footer.

**Architecture:** Giữ trigger ở telemetry event `provider_called` đã có trong `src/agent/loop.ts`, và triển khai lifecycle của provider status hoàn toàn ở CLI render layer trong `src/cli/main.ts`. Không đẩy logic thinking/responding vào REPL hoặc telemetry formatter; `src/telemetry/display.ts` tiếp tục chỉ format activity/footer compact.

**Tech Stack:** TypeScript, Node.js timers, Vitest, existing CLI telemetry observer/writer.

---

## File map

- **Modify:** `src/cli/main.ts`
  - Mở rộng `AssistantBlockWriter` với provider status lifecycle.
  - Bổ sung observer nhẹ nghe event `provider_called` và gọi writer.
  - Đảm bảo mọi path render output thật/footer đều transition trạng thái đúng.
- **Modify:** `tests/cli/repl.test.ts`
  - Thêm test RED/GREEN cho interactive provider status, multi-round provider status, footer-first transition, và non-TTY safety.
- **Keep unchanged unless forced by failing tests:** `src/agent/loop.ts`
  - `provider_called` đã emit trước `await input.provider.generate(...)`, nên không nên sửa nếu không cần.
- **Keep unchanged unless contract truly changes:** `src/telemetry/display.ts`
  - File này không nên render provider placeholder text.

## Implementation notes

- Provider status line phải bắt đầu ở đầu dòng, **không indent 2 spaces**.
- Assistant body và tool activity lines giữ contract hiện tại: indent 2 spaces.
- Footer vẫn không indent.
- `✓ Responding` phải được render **thay cho** dòng thinking hiện tại, không xóa trần.
- Với TTY, cho phép ANSI xanh lá cho dấu `✓`; với non-TTY, fallback text thường.
- Animation chỉ chạy ở TTY. Non-TTY không được spam nhiều frame.
- Khi sang provider round mới sau tool execution, thinking state phải khởi động lại được.

### Task 1: Lock behavior with failing CLI tests

**Files:**
- Modify: `tests/cli/repl.test.ts`
- Reference: `src/cli/main.ts`
- Reference: `src/agent/loop.ts`

- [ ] **Step 1: Write the failing test for first provider round showing `QiClaw` immediately**

Add a new test near the existing `provider_called` / prompt-mode tests in `tests/cli/repl.test.ts` that asserts `provider_called` causes `QiClaw` + a top-level provider status line before the final answer.

```ts
it('shows QiClaw and provider thinking immediately when provider_called is recorded', async () => {
  const writes: string[] = [];
  const cli = buildCli({
    argv: ['--prompt', 'inspect package.json'],
    cwd: '/tmp/qiclaw-provider-thinking',
    stdout: {
      isTTY: true,
      write(chunk) {
        writes.push(String(chunk));
        return true;
      }
    },
    createRuntime: (runtimeOptions) => ({
      provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
      availableTools: [],
      cwd: '/tmp/qiclaw-provider-thinking',
      observer: runtimeOptions.observer ?? { record() {} },
      agentSpec: defaultAgentSpec,
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
        messageSummaries: [],
        totalContentBlockCount: 2,
        hasSystemPrompt: true,
        promptRawPreviewRedacted: '{}'
      }));

      expect(writes.join('')).toContain('\nQiClaw\n');
      expect(writes.join('')).toContain('🧠 Thinking.\n');

      return {
        stopReason: 'completed',
        finalAnswer: 'handled: inspect package.json',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
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
  expect(writes.join('')).toContain('✓ Responding\n');
  expect(writes.join('')).toContain('  handled: inspect package.json\n');
});
```

- [ ] **Step 2: Run the single test and verify it fails for the right reason**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "shows QiClaw and provider thinking immediately when provider_called is recorded"
```

Expected: FAIL because current `buildCli()`/`createAssistantBlockWriter()` does not react to `provider_called`, so output does not contain `🧠 Thinking.` or `✓ Responding`.

- [ ] **Step 3: Write the failing test for multi-round provider thinking**

Add a second test proving provider status reappears on provider round 2 after a tool round.

```ts
it('restarts provider thinking on each provider round', async () => {
  const writes: string[] = [];
  const cli = buildCli({
    argv: ['--prompt', 'multi round'],
    cwd: '/tmp/qiclaw-provider-thinking-rounds',
    stdout: {
      isTTY: true,
      write(chunk) {
        writes.push(String(chunk));
        return true;
      }
    },
    createRuntime: (runtimeOptions) => ({
      provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
      availableTools: [],
      cwd: '/tmp/qiclaw-provider-thinking-rounds',
      observer: runtimeOptions.observer ?? { record() {} },
      agentSpec: defaultAgentSpec,
      systemPrompt: 'Test prompt',
      maxToolRounds: 3
    }),
    runTurn: async (input) => {
      input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
        turnId: 'turn-1', providerRound: 1, toolRound: 0, messageCount: 2, promptRawChars: 42, toolNames: [], messageSummaries: [], totalContentBlockCount: 2, hasSystemPrompt: true, promptRawPreviewRedacted: '{}'
      }));
      input.observer?.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
        turnId: 'turn-1', providerRound: 1, toolRound: 1, toolName: 'read_file', toolCallId: 'call-1', inputPreview: '{"path":"note.txt"}', inputRawRedacted: { path: 'note.txt' }
      }));
      input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
        turnId: 'turn-1', providerRound: 2, toolRound: 1, messageCount: 4, promptRawChars: 84, toolNames: [], messageSummaries: [], totalContentBlockCount: 4, hasSystemPrompt: true, promptRawPreviewRedacted: '{}'
      }));

      return {
        stopReason: 'completed',
        finalAnswer: 'done',
        history: [],
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
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
  expect(writes.join('')).toContain('🧠 Thinking.');
  expect(writes.join('').match(/✓ Responding/g)).toHaveLength(2);
});
```

- [ ] **Step 4: Run the multi-round test and verify it fails**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "restarts provider thinking on each provider round"
```

Expected: FAIL because current writer has no provider-round status lifecycle.

- [ ] **Step 5: Write the failing test for footer-first transition**

Add a test proving that if a waiting provider state exists and the next rendered thing is the footer, the status still transitions to `✓ Responding` before footer output.

```ts
it('transitions waiting provider status before rendering the footer', async () => {
  const writes: string[] = [];
  const cli = buildCli({
    argv: ['--prompt', 'footer case'],
    cwd: '/tmp/qiclaw-provider-footer',
    stdout: {
      isTTY: true,
      write(chunk) {
        writes.push(String(chunk));
        return true;
      }
    },
    createRuntime: (runtimeOptions) => ({
      provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
      availableTools: [],
      cwd: '/tmp/qiclaw-provider-footer',
      observer: runtimeOptions.observer ?? { record() {} },
      agentSpec: defaultAgentSpec,
      systemPrompt: 'Test prompt',
      maxToolRounds: 3
    }),
    runTurn: async (input) => {
      input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
        turnId: 'turn-1', providerRound: 1, toolRound: 0, messageCount: 2, promptRawChars: 42, toolNames: [], messageSummaries: [], totalContentBlockCount: 2, hasSystemPrompt: true, promptRawPreviewRedacted: '{}'
      }));
      input.observer?.record(createTelemetryEvent('turn_completed', 'completion_check', {
        turnId: 'turn-1',
        providerRound: 1,
        toolRound: 0,
        stopReason: 'completed',
        toolRoundsUsed: 0,
        isVerified: true,
        durationMs: 1200
      }));
      input.observer?.record(createTelemetryEvent('turn_summary', 'completion_check', {
        turnId: 'turn-1',
        providerRound: 1,
        toolRound: 0,
        providerRounds: 1,
        toolRoundsUsed: 0,
        toolCallsTotal: 0,
        toolCallsByName: {},
        inputTokensTotal: 10,
        outputTokensTotal: 5,
        promptCharsMax: 10,
        toolResultCharsInFinalPrompt: 0,
        assistantToolCallCharsInFinalPrompt: 0,
        toolResultPromptGrowthCharsTotal: 0,
        toolResultCharsAddedAcrossTurn: 0,
        turnCompleted: true,
        stopReason: 'completed'
      }));

      return {
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: false,
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
  expect(writes.join('')).toContain('✓ Responding\n');
  expect(writes.join('')).toContain('─ completed • 1 provider • 10 in / 5 out • 1.2s\n');
});
```

- [ ] **Step 6: Run the footer-first test and verify it fails**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "transitions waiting provider status before rendering the footer"
```

Expected: FAIL because current footer path does not know about provider waiting state.

- [ ] **Step 7: Write the failing test for non-TTY safety**

Add a test proving that non-TTY prompt mode does not emit multiple animated frames.

```ts
it('does not animate provider thinking frames in non-tty mode', async () => {
  const writes: string[] = [];
  const cli = buildCli({
    argv: ['--prompt', 'non tty'],
    cwd: '/tmp/qiclaw-provider-non-tty',
    stdout: {
      isTTY: false,
      write(chunk) {
        writes.push(String(chunk));
        return true;
      }
    },
    createRuntime: (runtimeOptions) => ({
      provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
      availableTools: [],
      cwd: '/tmp/qiclaw-provider-non-tty',
      observer: runtimeOptions.observer ?? { record() {} },
      agentSpec: defaultAgentSpec,
      systemPrompt: 'Test prompt',
      maxToolRounds: 3
    }),
    runTurn: async (input) => {
      input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
        turnId: 'turn-1', providerRound: 1, toolRound: 0, messageCount: 2, promptRawChars: 42, toolNames: [], messageSummaries: [], totalContentBlockCount: 2, hasSystemPrompt: true, promptRawPreviewRedacted: '{}'
      }));
      return {
        stopReason: 'completed',
        finalAnswer: 'done',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
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
  expect(writes.join('').match(/🧠 Thinking/g)?.length ?? 0).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 8: Run the non-TTY test and verify it fails or stays red for the expected missing behavior**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "does not animate provider thinking frames in non-tty mode"
```

Expected: If you choose the recommended behavior “no provider status in non-TTY”, this test should initially fail because the behavior is not implemented yet.

### Task 2: Implement provider status lifecycle in the CLI writer

**Files:**
- Modify: `src/cli/main.ts`
- Reference: `src/agent/loop.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Extend the writer interface with provider status methods**

Update the `AssistantBlockWriter` type in `src/cli/main.ts` to include explicit provider status methods.

```ts
interface AssistantBlockWriter {
  writeAssistantLine(text: string, toolCallId?: string): void;
  replaceAssistantLine(toolCallId: string, text: string): void;
  writeAssistantTextBlock(text: string): void;
  writeFooterLine(text: string): void;
  startProviderThinking(): void;
  markResponding(): void;
  clearProviderStatus(): void;
  resetTurn(): void;
}
```

- [ ] **Step 2: Add provider status state to `createAssistantBlockWriter()`**

Inside `createAssistantBlockWriter()` in `src/cli/main.ts`, add state for the provider status line, its timer, and whether the current round has already transitioned.

```ts
let providerStatusInterval: NodeJS.Timeout | undefined;
let providerStatusActive = false;
let providerStatusResponded = false;
let providerStatusFrameIndex = 0;
let providerStatusLineIndex: number | undefined;
const providerThinkingFrames = ['🧠 Thinking.', '🧠 Thinking..', '🧠 Thinking...'];
const respondingLine = stdout.isTTY ? '\u001b[32m✓\u001b[39m Responding' : '✓ Responding';
```

- [ ] **Step 3: Add helper functions that render and replace the provider status line**

Implement small helpers in `createAssistantBlockWriter()` for provider status rendering and replacement.

```ts
function writeTopLevelLine(text: string): void {
  writeRaw(`${text}\n`);
  activeActivityLineCount += 1;
}

function renderProviderStatus(text: string): void {
  ensureTurnPrelude();
  if (providerStatusLineIndex === undefined) {
    providerStatusLineIndex = renderedActivityLines.length;
    renderedActivityLines.push(text);
    writeTopLevelLine(text);
    return;
  }

  renderedActivityLines[providerStatusLineIndex] = text;
  if (stdout.isTTY) {
    rerenderActivityLines();
    return;
  }

  writeTopLevelLine(text);
}

function stopProviderThinkingTimer(): void {
  if (!providerStatusInterval) {
    return;
  }

  clearInterval(providerStatusInterval);
  providerStatusInterval = undefined;
}
```

Then adjust `writeRenderedActivityLine()` to support either body-indented activity or top-level provider status. The simplest safe path is to branch by content and create a dedicated top-level render path, rather than overloading the existing function.

- [ ] **Step 4: Implement `startProviderThinking()` minimally**

Add a method that starts a new provider-round status only if one is not already active.

```ts
startProviderThinking() {
  ensureTurnPrelude();
  if (providerStatusActive && !providerStatusResponded) {
    return;
  }

  providerStatusActive = true;
  providerStatusResponded = false;
  providerStatusFrameIndex = 0;
  renderProviderStatus(providerThinkingFrames[providerStatusFrameIndex]);

  if (!stdout.isTTY) {
    return;
  }

  providerStatusInterval = setInterval(() => {
    providerStatusFrameIndex = (providerStatusFrameIndex + 1) % providerThinkingFrames.length;
    renderProviderStatus(providerThinkingFrames[providerStatusFrameIndex]);
  }, 250);
}
```

- [ ] **Step 5: Implement `markResponding()` and `clearProviderStatus()`**

Transition the current provider status to `✓ Responding` once, then clean its transient state.

```ts
markResponding() {
  if (!providerStatusActive || providerStatusResponded) {
    return;
  }

  stopProviderThinkingTimer();
  providerStatusResponded = true;
  renderProviderStatus(respondingLine);
}

clearProviderStatus() {
  stopProviderThinkingTimer();
  providerStatusActive = false;
  providerStatusResponded = false;
  providerStatusFrameIndex = 0;
  providerStatusLineIndex = undefined;
}
```

- [ ] **Step 6: Transition provider status before every real output path**

Update these existing writer methods in `src/cli/main.ts`:
- `writeAssistantLine()`
- `replaceAssistantLine()`
- `writeAssistantTextBlock()`
- `writeFooterLine()`
- `resetTurn()`

Use this pattern:

```ts
writeAssistantLine(text: string, toolCallId?: string) {
  ensureTurnPrelude();
  this.markResponding();
  if (toolCallId) {
    activityLineIndexes.set(toolCallId, renderedActivityLines.length);
  }
  renderedActivityLines.push(text);
  writeRenderedActivityLine(text);
}
```

```ts
writeFooterLine(text: string) {
  ensureTurnPrelude();
  this.markResponding();
  activeActivityLineCount = 0;
  write(`${text}\n\n`);
  this.clearProviderStatus();
}
```

```ts
resetTurn() {
  this.clearProviderStatus();
  hasStartedTurn = false;
  activeActivityLineCount = 0;
  activityLineIndexes.clear();
  renderedActivityLines.length = 0;
}
```

If calling `this.markResponding()` from inside the returned object causes awkward `this` binding, extract local functions `markResponding()` and `clearProviderStatus()` and call those instead.

- [ ] **Step 7: Wire `provider_called` into the CLI observer**

In `createCliObserver()` inside `src/cli/main.ts`, create a lightweight observer that listens for `provider_called` and triggers `assistantBlockWriter.startProviderThinking()`.

```ts
const providerStatusObserver: TelemetryObserver = {
  record(event) {
    if (event.type === 'provider_called') {
      options.assistantBlockWriter.startProviderThinking();
    }
  }
};

const observers: TelemetryObserver[] = [options.metrics, providerStatusObserver];
```

Keep the existing compact observer wiring as-is after this.

- [ ] **Step 8: Run the targeted CLI tests and make them green**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "provider thinking|provider round|waiting provider status|non-tty"
```

Expected: PASS for the four new tests after the implementation is complete.

### Task 3: Reconcile the writer with existing output contracts

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `tests/cli/repl.test.ts`

- [ ] **Step 1: Add a regression test that the provider status line is not indented**

Add one focused test that checks the exact rendered prompt-mode output includes a top-level provider status line between `QiClaw` and the indented body.

```ts
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
    },
    createRuntime: (runtimeOptions) => ({
      provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
      availableTools: [],
      cwd: '/tmp/qiclaw-provider-layout',
      observer: runtimeOptions.observer ?? { record() {} },
      agentSpec: defaultAgentSpec,
      systemPrompt: 'Test prompt',
      maxToolRounds: 3
    }),
    runTurn: async (input) => {
      input.observer?.record(createTelemetryEvent('provider_called', 'provider_decision', {
        turnId: 'turn-1', providerRound: 1, toolRound: 0, messageCount: 2, promptRawChars: 42, toolNames: [], messageSummaries: [], totalContentBlockCount: 2, hasSystemPrompt: true, promptRawPreviewRedacted: '{}'
      }));
      return {
        stopReason: 'completed',
        finalAnswer: 'handled: inspect package.json',
        history: [],
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
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
  expect(writes.join('')).toBe('\nQiClaw\n✓ Responding\n  handled: inspect package.json\n');
});
```

- [ ] **Step 2: Run that single regression test and verify it fails if the line is incorrectly indented**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "renders provider status at top level instead of indenting it into the assistant body"
```

Expected: If provider status was accidentally rendered through `writeRenderedActivityLine()`, the test fails because the output would contain `  ✓ Responding` instead of `✓ Responding`.

- [ ] **Step 3: Adjust `createAssistantBlockWriter()` until this regression test passes**

The final behavior should preserve this output shape exactly:

```text
QiClaw
✓ Responding
  handled: inspect package.json
```

Do not route provider status through the assistant-body indentation path.

- [ ] **Step 4: Run the existing high-value CLI block-layout tests and fix any regressions**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand -t "interactive turns as an indented QiClaw block|keeps exactly one blank line before each assistant block|prompt mode output compact|renders footer output after a multiline answer"
```

Expected: Existing layout tests continue to pass, or fail only where the expected output now intentionally includes top-level `✓ Responding`.

If any existing exact-output test must change, update the expectation to include the new provider status line while preserving:
- exactly one blank line before `QiClaw`
- assistant body indented 2 spaces
- provider status top-level, not indented
- footer not indented

- [ ] **Step 5: Re-run all of `tests/cli/repl.test.ts`**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: PASS.

### Task 4: Verify that telemetry and agent loop contracts remain intact

**Files:**
- Reference: `src/agent/loop.ts`
- Reference: `tests/agent/loop.test.ts`
- Modify only if needed: `tests/cli/repl.test.ts`

- [ ] **Step 1: Confirm no production change is needed in `src/agent/loop.ts`**

Read the existing emit point and keep it unchanged if it still looks like this:

```ts
observer.record(
  createTelemetryEvent('provider_called', 'provider_decision', {
    ...buildTurnContext(telemetry),
    ...promptTelemetry
  })
);

const providerStartedAt = Date.now();
const response = await input.provider.generate({
  messages: prompt.messages,
  availableTools: input.availableTools
});
```

Acceptance: `provider_called` already fires before provider IO, so no loop change is necessary.

- [ ] **Step 2: Run the existing loop telemetry tests to verify the event order remains the same**

Run:
```bash
npm test -- tests/agent/loop.test.ts --runInBand -t "provider_called"
```

Expected: PASS. Event order should still include `provider_called` before `provider_responded` and before tool execution in the first round.

- [ ] **Step 3: Run compact telemetry display tests to verify no accidental formatter regression**

Run:
```bash
npm test -- tests/telemetry/display.test.ts --runInBand
```

Expected: PASS. These tests should not need output changes because provider placeholder rendering lives in CLI writer/observer wiring, not in `src/telemetry/display.ts`.

### Task 5: Final verification and commit

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `tests/cli/repl.test.ts`
- Possibly unchanged but verified: `src/agent/loop.ts`, `src/telemetry/display.ts`

- [ ] **Step 1: Run the focused verification commands in sequence**

Run:
```bash
npm test -- tests/cli/repl.test.ts --runInBand
npm test -- tests/agent/loop.test.ts --runInBand -t "provider_called"
npm test -- tests/telemetry/display.test.ts --runInBand
```

Expected: all PASS.

- [ ] **Step 2: Run the full test suite**

Run:
```bash
npm test
```

Expected: PASS with no new failing tests.

- [ ] **Step 3: Review the final output contract manually from test fixtures**

Confirm these exact UX rules are true from the passing tests:

```text

QiClaw
🧠 Thinking.
✓ Responding
  · read path | done (1ms)
  handled: inspect package.json
─ completed ...
```

Checklist:
- `QiClaw` appears before first provider output.
- `🧠 Thinking...` is top-level.
- `✓ Responding` is top-level.
- assistant body and tool activity remain indented 2 spaces.
- footer remains unindented.
- provider status can repeat on later rounds.

- [ ] **Step 4: Commit the implementation**

Run:
```bash
git add src/cli/main.ts tests/cli/repl.test.ts
git commit -m "feat: show provider thinking state in cli"
```

Expected: commit succeeds with the tested implementation.

## Self-review

- **Spec coverage:**
  - Immediate `QiClaw` on submit/provider round: covered by Task 1 + Task 2.
  - Per-provider-round behavior: covered by Task 1 multi-round test + Task 2 lifecycle state.
  - `🧠 Thinking.`/`..`/`...`: covered by Task 2 state implementation.
  - No 2-space indent on provider status: covered by Task 3 regression test.
  - Replace with `✓ Responding` before output/footer: covered by Task 1 footer-first test + Task 2 output path changes.
  - Non-TTY safety: covered by Task 1 non-TTY test.
- **Placeholder scan:** No `TODO`, `TBD`, or vague “handle later” items remain.
- **Type consistency:** The plan consistently uses `startProviderThinking()`, `markResponding()`, and `clearProviderStatus()` across all tasks.
