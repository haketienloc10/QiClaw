# QiClaw TUI Footer Summary Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing TUI footer turn summary so it includes compact input/output token counts, e.g. `completed • verified • 1 provider • 2 tools • 12k in • 1.3k out • 18s`.

**Architecture:** Keep all token aggregation and string formatting in the TypeScript controller, where turn metrics are already collected and the `footer_summary` event is emitted. Reuse provider telemetry/usage data from the runtime observer path, add explicit per-turn token counters alongside provider/tool/duration counters, and keep the Rust TUI unchanged because it already renders whatever summary string the controller sends.

**Tech Stack:** TypeScript, Vitest, existing QiClaw telemetry observer events, existing TUI bridge protocol

---

## File Map

### Existing files to modify

- `src/cli/tuiController.ts`
  - Extend `TurnSummaryMetrics` with token totals, collect token usage from provider telemetry, add compact token formatting helpers, and emit the richer `footer_summary` string.
- `tests/cli/tuiController.test.ts`
  - Replace the old no-token footer-summary expectations and add regression tests for compact formatting, singular/plural wording, sub-second durations, and no double-counting of token usage.

### Existing files to verify during implementation

- `src/telemetry/observer.ts`
  - Verify the `provider_responded` event carries `usage?: ProviderUsageSummary` so the controller can consume trusted per-call token counts.
- `src/agent/loop.ts`
  - Verify usage totals are built from provider responses, not tool rounds, so the controller can safely aggregate per-turn token input/output from observer events without inventing a second source.
- `docs/superpowers/specs/2026-04-16-qiclaw-tui-footer-summary-design.md`
  - Confirm plan coverage stays aligned with the approved token-in/out wording and counting rules.

---

### Task 1: Lock the token-aware footer summary format with failing controller tests

**Files:**
- Modify: `tests/cli/tuiController.test.ts`
- Verify: `src/cli/tuiController.ts`

- [ ] **Step 1: Replace the existing completed-summary expectation with a token-aware failing assertion**

In `tests/cli/tuiController.test.ts`, update the existing completed-turn footer assertion so it expects input/output token text between tool counts and duration.

```ts
expect(footerSummaries[0]).toEqual({
  type: 'footer_summary',
  text: 'completed • verified • 1 provider • 2 tools • 12k in • 1.3k out • 18s'
});
```

Keep the rest of the test setup intact so the failure isolates the missing token behavior.

- [ ] **Step 2: Replace the existing max-tools summary expectation with a token-aware failing assertion**

Update the current max-tools assertion so it expects token text and still checks the existing stop-reason shortening and singular/plural rules.

```ts
expect(footerSummaries[0]).toEqual({
  type: 'footer_summary',
  text: 'max tools • 2 providers • 1 tool • 842 in • 61 out • 842ms'
});
```

This preserves the current duration contract while extending the same summary with token metrics.

- [ ] **Step 3: Add a focused failing test for compact token formatting and no double-counting across multiple provider responses**

Add a new test near the existing footer-summary tests.

```ts
it('formats compact token counts and does not double-count tool rounds as provider usage', async () => {
  const emitted: HostEvent[] = [];

  const controller = createTuiController({
    cwd: '/tmp/qiclaw-token-summary',
    runtime: {
      provider: { name: 'anthropic', model: 'claude-sonnet-4-6' },
      availableTools: [],
      systemPrompt: 'system prompt',
      cwd: '/tmp/qiclaw-token-summary',
      maxToolRounds: 4,
      observer: { record() {} }
    },
    checkpointStore: {
      getLatest() {
        return undefined;
      },
      save() {}
    },
    prepareSessionMemory: vi.fn(async () => ({
      memoryText: '',
      store: { stub: true },
      recalled: [],
      checkpointState: {
        storeSessionId: 'session-token-summary',
        engine: 'file-session-memory',
        version: 1,
        memoryPath: '/tmp/memory.jsonl',
        metaPath: '/tmp/meta.json',
        totalEntries: 0,
        lastCompactedAt: null
      }
    })),
    captureTurnMemory: vi.fn(async () => ({
      saved: true,
      checkpointState: {
        storeSessionId: 'session-token-summary',
        engine: 'file-session-memory',
        version: 1,
        memoryPath: '/tmp/memory.jsonl',
        metaPath: '/tmp/meta.json',
        totalEntries: 1,
        lastCompactedAt: null
      }
    })),
    createSessionId: () => 'session-token-summary',
    executeTurn: async ({ observer }) => {
      observer?.record({
        type: 'provider_called',
        timestamp: '2026-04-16T10:00:00.000Z',
        source: 'provider_decision',
        data: {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          messageCount: 2,
          promptRawChars: 120,
          toolNames: [],
          messageSummaries: [],
          totalContentBlockCount: 2,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: 'prompt'
        }
      });
      observer?.record({
        type: 'provider_responded',
        timestamp: '2026-04-16T10:00:01.000Z',
        source: 'provider_response',
        data: {
          turnId: 'turn-1',
          providerRound: 1,
          toolRound: 0,
          durationMs: 320,
          responseContentBlockCount: 1,
          toolCallCount: 1,
          hasTextOutput: false,
          usage: {
            inputTokens: 12_000,
            outputTokens: 900,
            totalTokens: 12_900,
            cacheReadInputTokens: 0
          }
        }
      });
      observer?.record({
        type: 'provider_called',
        timestamp: '2026-04-16T10:00:02.000Z',
        source: 'provider_decision',
        data: {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 1,
          messageCount: 4,
          promptRawChars: 260,
          toolNames: ['read_file'],
          messageSummaries: [],
          totalContentBlockCount: 4,
          hasSystemPrompt: true,
          promptRawPreviewRedacted: 'prompt'
        }
      });
      observer?.record({
        type: 'provider_responded',
        timestamp: '2026-04-16T10:00:03.000Z',
        source: 'provider_response',
        data: {
          turnId: 'turn-1',
          providerRound: 2,
          toolRound: 1,
          durationMs: 280,
          responseContentBlockCount: 1,
          toolCallCount: 0,
          hasTextOutput: true,
          usage: {
            inputTokens: 345,
            outputTokens: 400,
            totalTokens: 745,
            cacheReadInputTokens: 0
          }
        }
      });

      return {
        stopReason: 'completed',
        finalAnswer: 'done',
        history: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'done' }
        ],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'question',
          checklist: ['question'],
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
        },
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { filePath: 'a' } };
          yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', resultPreview: 'ok', isError: false, durationMs: 10 };
          yield { type: 'assistant_message_completed', text: 'done' };
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'done',
          history: [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'done' }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: 'question',
            checklist: ['question'],
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
        })
      };
    },
    emit(message) {
      emitted.push(parseBridgeMessage(message));
    }
  });

  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-16T10:00:00.000Z'));

  await controller.start();
  vi.setSystemTime(new Date('2026-04-16T10:00:18.000Z'));
  await controller.handleAction({ type: 'submit_prompt', prompt: 'question' });

  const footerSummaries = emitted.filter((event): event is Extract<HostEvent, { type: 'footer_summary' }> => event.type === 'footer_summary');

  expect(footerSummaries[0]).toEqual({
    type: 'footer_summary',
    text: 'completed • verified • 2 providers • 1 tool • 12k in • 1.3k out • 18s'
  });
});
```

The important part is that `12_000 + 345` becomes `12k in` and `900 + 400` becomes `1.3k out`, with no extra token inflation from tool rounds.

- [ ] **Step 4: Add a focused failing test for small counts and non-verified turns**

Add another test so the formatter cannot hard-code compact notation for every number or always include `verified`.

```ts
it('formats raw token counts and omits verified when verification is false', async () => {
  expect(
    formatFooterSummary({
      stopReason: 'stopped',
      isVerified: false,
      providerCalls: 1,
      toolCalls: 0,
      inputTokens: 842,
      outputTokens: 61,
      durationMs: 842
    })
  ).toBe('stopped • 1 provider • 0 tools • 842 in • 61 out • 842ms');
});
```

If the helper is not exported today, keep the test black-box by driving it through controller emission instead of exporting new surface area just for tests.

- [ ] **Step 5: Run the focused controller test file and verify it fails for the expected reason**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: FAIL because the current footer formatter still emits `completed • verified • 1 provider • 2 tools • 18s` and does not yet include token counts.

- [ ] **Step 6: Commit the failing test lock-in**

```bash
git add tests/cli/tuiController.test.ts
git commit -m "test: lock tui footer token summary format"
```

---

### Task 2: Collect per-turn token usage and format compact token text in the controller

**Files:**
- Modify: `src/cli/tuiController.ts`
- Verify: `src/telemetry/observer.ts`
- Verify: `src/agent/loop.ts`

- [ ] **Step 1: Extend the per-turn metrics shape with input/output token counters**

Update the existing `TurnSummaryMetrics` interface in `src/cli/tuiController.ts`.

```ts
interface TurnSummaryMetrics {
  providerCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
```

Also update the `turnSummaryMetrics` initializer inside `runPrompt(...)`.

```ts
const turnSummaryMetrics: TurnSummaryMetrics = {
  providerCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0
};
```

- [ ] **Step 2: Add compact token formatting helpers next to the existing summary helpers**

In `src/cli/tuiController.ts`, keep the existing formatter-local structure and add explicit helpers for token text.

```ts
function formatCompactCount(value: number): string {
  if (value < 1000) {
    return `${value}`;
  }

  const compact = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: value < 10_000 ? 1 : 0
  }).format(value);

  return compact.toLowerCase();
}

function formatTokenCount(value: number, suffix: 'in' | 'out'): string {
  return `${formatCompactCount(value)} ${suffix}`;
}
```

Use `toLowerCase()` so environments that produce `12K` normalize to the spec’s `12k`.

- [ ] **Step 3: Extend the existing footer-summary formatter to include token text in the approved position**

Replace the current helper signature and `parts` assembly in `src/cli/tuiController.ts`.

```ts
function formatFooterSummary(args: {
  stopReason: string;
  isVerified: boolean;
  providerCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}): string {
  const parts = [
    summarizeStopReason(args.stopReason),
    ...(args.isVerified ? ['verified'] : []),
    pluralize(args.providerCalls, 'provider', 'providers'),
    pluralize(args.toolCalls, 'tool', 'tools'),
    formatTokenCount(args.inputTokens, 'in'),
    formatTokenCount(args.outputTokens, 'out'),
    formatTurnDuration(args.durationMs)
  ];

  return parts.join(' • ');
}
```

This keeps the wording order aligned with the approved spec.

- [ ] **Step 4: Aggregate token usage from trusted provider telemetry events, not from tool rounds**

Update the existing `countingObserver` inside `runPrompt(...)` so it consumes `provider_responded` usage totals.

```ts
const countingObserver = {
  record(event: Parameters<NonNullable<typeof options.runtime.observer>['record']>[0]) {
    if (event.type === 'provider_called') {
      turnSummaryMetrics.providerCalls += 1;
    }

    if (event.type === 'provider_responded') {
      turnSummaryMetrics.inputTokens += event.data.usage?.inputTokens ?? 0;
      turnSummaryMetrics.outputTokens += event.data.usage?.outputTokens ?? 0;
    }

    options.runtime.observer?.record(event);
  }
};
```

Do not derive tokens from `toolRoundsUsed`, transcript events, or final-answer text. The trusted source for this plan is provider response usage telemetry.

- [ ] **Step 5: Emit the richer footer summary after the turn settles**

Update the existing `emit({ type: 'footer_summary', ... })` call inside `runPrompt(...)`.

```ts
emit({
  type: 'footer_summary',
  text: formatFooterSummary({
    stopReason: settled.stopReason,
    isVerified: settled.verification.isVerified,
    providerCalls: turnSummaryMetrics.providerCalls,
    toolCalls: turnSummaryMetrics.toolCalls,
    inputTokens: turnSummaryMetrics.inputTokens,
    outputTokens: turnSummaryMetrics.outputTokens,
    durationMs: turnSummaryMetrics.durationMs
  })
});
```

No protocol change is needed because `footer_summary` already carries plain text.

- [ ] **Step 6: Verify the telemetry contract before relying on it**

Read the existing types in `src/telemetry/observer.ts` and the usage accumulation in `src/agent/loop.ts`, then confirm these facts in the implementation notes or commit message:

```ts
export interface ProviderRespondedTelemetryData extends TelemetryEventContextData {
  stopReason?: string;
  usage?: ProviderUsageSummary;
  responseContentBlockCount: number;
  toolCallCount: number;
  hasTextOutput: boolean;
  durationMs: number;
}
```

```ts
function accumulateUsageTotals(telemetry: TurnTelemetryState, usage?: ProviderUsageSummary): void {
  if (!usage) {
    return;
  }

  telemetry.inputTokensTotal += usage.inputTokens ?? 0;
  telemetry.outputTokensTotal += usage.outputTokens ?? 0;
  telemetry.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
}
```

The point of this step is to explicitly verify that `provider_responded` is the correct source and that the controller is not fabricating a new metric path.

- [ ] **Step 7: Run the focused controller test file and make it pass**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: PASS for the updated completed/max-tools summaries plus the new token-format regression tests.

- [ ] **Step 8: Commit the controller token aggregation logic**

```bash
git add src/cli/tuiController.ts tests/cli/tuiController.test.ts
git commit -m "feat: add token usage to tui footer summary"
```

---

### Task 3: Run broader verification so the token-aware summary does not break existing TUI/controller behavior

**Files:**
- Verify: `tests/cli/tuiController.test.ts`
- Verify: `src/cli/tuiController.ts`
- Verify: `tui/src/app.rs`
- Verify: `tui/src/footer/render.rs`

- [ ] **Step 1: Re-run the targeted controller suite after the implementation commit**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: PASS with the token-aware footer summary text and no regressions in direct-command or transcript-event tests.

- [ ] **Step 2: Run the full JavaScript/TypeScript test suite**

Run: `npm test`

Expected: PASS so the controller telemetry changes do not break other CLI flows.

- [ ] **Step 3: Run the Rust TUI tests to confirm the richer summary string still renders through the existing footer path**

Run: `cargo test --manifest-path tui/Cargo.toml`

Expected: PASS because Rust should remain unchanged and keep treating `footer_summary.text` as opaque rendered content.

- [ ] **Step 4: Verify there is no Rust change required for this token-only enhancement**

Inspect the existing footer rendering and app wiring at [tui/src/footer/render.rs](tui/src/footer/render.rs) and [tui/src/app.rs](tui/src/app.rs) and confirm both still only depend on the already-existing summary string.

```rust
let left_source = state.turn_summary_text.as_deref().unwrap_or(&state.status_text);
```

```rust
HostEvent::FooterSummary { text } => {
    self.turn_summary_text = Some(text.clone());
}
```

No edit is expected in this step.

- [ ] **Step 5: Commit the verification pass**

```bash
git add src/cli/tuiController.ts tests/cli/tuiController.test.ts
git commit -m "test: verify token-aware tui footer summary"
```

---

## Self-Review Against Spec

### Spec coverage

- **Summary includes token input/output** → Task 1 locks token-aware expectations; Task 2 adds `inputTokens` and `outputTokens` to the formatter and emission path.
- **Formatting order is `... tools • <input> in • <output> out • <duration>`** → Task 2 Step 3 hard-codes the exact part ordering.
- **Compact token formatting** → Task 1 adds regression tests for `12k` and `1.3k`; Task 2 adds `formatCompactCount()` and `formatTokenCount()`.
- **Tool count is actual tool calls, not tool rounds** → Existing `tool_call_completed` counting remains intact and Task 1’s multi-provider test preserves that distinction.
- **Provider count is actual provider calls** → Existing `provider_called` counting remains intact.
- **No token double-count across multiple provider phases** → Task 1 adds a two-provider-response regression test; Task 2 aggregates once per `provider_responded` event.
- **Duration behavior unchanged** → Task 1 preserves both `18s` and `842ms` expectations.
- **No Rust/layout rework needed** → Task 3 explicitly verifies the current `footer_summary` render path remains sufficient.

### Placeholder scan

- No `TODO`, `TBD`, or “similar to above” placeholders remain.
- Every code-changing step includes concrete code snippets.
- Every verification step includes exact commands and expected outcomes.

### Type consistency

- Metric names are consistently `inputTokens` and `outputTokens` in tests, helpers, and controller emission.
- Token suffix wording is consistently `in` and `out`.
- The trusted telemetry source is consistently `provider_responded.data.usage`.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-16-qiclaw-tui-footer-summary-token-usage.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**