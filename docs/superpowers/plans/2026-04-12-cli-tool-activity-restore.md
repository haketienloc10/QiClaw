# CLI Tool Activity Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khôi phục interactive CLI tool activity như trước regression, gồm blinking icon và completion line có duration, mà không thay đổi debug log.

**Architecture:** Giữ telemetry observer là nguồn render duy nhất cho tool activity UI; `handleCliTurnEvent(...)` chỉ xử lý assistant text stream và turn failure. Sửa tối thiểu ở CLI wiring để bật lại telemetry tool render và cập nhật test transcript để bảo vệ khỏi duplicate render.

**Tech Stack:** TypeScript, Node.js timers, picocolors, Vitest

---

## File structure

- Modify: `src/cli/main.ts`
  - Gỡ chặn render telemetry tool activity trong CLI runtime cần khôi phục.
  - Bỏ render `tool_call_started` / `tool_call_completed` khỏi `handleCliTurnEvent(...)` để tránh duplicate.
- Modify: `src/telemetry/display.ts`
  - Giữ interactive completion line ở dòng dưới và bảo đảm format có `(Nms)`.
- Modify: `tests/cli/repl.test.ts`
  - Cập nhật transcript expectation cho interactive CLI tool activity restored, non-duplicate.
- Modify: `tests/telemetry/display.test.ts`
  - Cập nhật assertion interactive completion để có duration, giữ compact behavior ổn định.

### Task 1: Add failing CLI regression coverage for restored interactive tool activity

**Files:**
- Modify: `tests/cli/repl.test.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Update the interactive failure transcript test to expect the restored tool line**

In `tests/cli/repl.test.ts`, update the test that currently asserts the tool line is absent around [tests/cli/repl.test.ts:3336-3347](tests/cli/repl.test.ts#L3336-L3347).

Replace the ordered markers with:

```ts
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
```

Replace the negative assertion:

```ts
expect(output).not.toContain(' ✦ read src/cli/main.ts\n');
```

with:

```ts
expect(output).toContain(' ✦ file read src/cli/main.ts\n');
```

- [ ] **Step 2: Update the interactive success-before-failure transcript test the same way**

In the neighboring test around [tests/cli/repl.test.ts:3421-3432](tests/cli/repl.test.ts#L3421-L3432), update the ordered markers to include the restored tool line and duration-bearing success line:

```ts
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
```

And replace:

```ts
expect(output).not.toContain(' ✦ read src/cli/main.ts\n');
```

with:

```ts
expect(output).toContain(' ✦ file read src/cli/main.ts\n');
```

- [ ] **Step 3: Add a no-duplicate assertion for the restored tool line**

In both tests, add:

```ts
expect(output.match(/ ✦ file read src\/cli\/main\.ts\n/g)).toHaveLength(1);
```

- [ ] **Step 4: Run the focused CLI tests to verify they fail**

Run:
```bash
npm test -- tests/cli/repl.test.ts -t "renders streamed turn failure once and returns a non-zero exit when the stream throws after turn_failed|renders streamed turn failure with tool completion preview and returns a non-zero exit when the stream throws after turn_failed"
```

Expected: FAIL because the current CLI output still suppresses telemetry tool activity in the interactive path.

### Task 2: Add failing telemetry expectation for interactive duration formatting

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Strengthen the interactive completion assertion to require duration**

In `tests/telemetry/display.test.ts`, update the test `stops interactive animation after tool_call_completed and finalizes the same tool line` around [tests/telemetry/display.test.ts:350-360](tests/telemetry/display.test.ts#L350-L360) to assert the appended completion line includes duration:

```ts
expect(activityLines).toEqual([
  originalToolLine,
  ' └─ ✔ Success (5ms)'
]);
```

And after the post-completion wait:

```ts
expect(activityLines).toEqual([
  originalToolLine,
  ' └─ ✔ Success (5ms)'
]);
```

- [ ] **Step 2: Run the focused telemetry test to verify current behavior**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "stops interactive animation after tool_call_completed and finalizes the same tool line"
```

Expected: PASS if duration formatting is already correct, otherwise FAIL and reveal the remaining formatting gap. Keep this test change anyway as a regression guard.

### Task 3: Re-enable telemetry tool rendering and remove duplicate turn-event tool UI

**Files:**
- Modify: `src/cli/main.ts:438-478`
- Modify: `src/cli/main.ts:942-985`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Stop rendering tool start/completion from `handleCliTurnEvent(...)`**

In `src/cli/main.ts`, reduce `handleCliTurnEvent(...)` to:

```ts
function handleCliTurnEvent(
  event: TurnEvent,
  assistantBlockWriter: AssistantBlockWriter | undefined,
  _mode: CliDisplayMode
): void {
  if (event.type === 'assistant_text_delta') {
    assistantBlockWriter?.writeAssistantTextDelta(event.text);
    return;
  }

  if (event.type === 'assistant_message_completed') {
    assistantBlockWriter?.finishAssistantTextBlock();
    return;
  }

  if (event.type === 'turn_failed') {
    assistantBlockWriter?.writeFooterLine(`${pc.dim('─'.repeat(54))}\n${pc.red('✖')} ${pc.red(pc.bold(`FAIL: ${formatCliError(event.error)}`))}`);
  }
}
```

Delete the now-unused helpers:
- `formatTurnEventToolActivityLine(...)`
- `formatTurnEventToolCompletionLine(...)`
- `formatTurnEventToolPreviewLine(...)`
- `formatTurnEventToolLabel(...)`
- `formatTurnEventCommandLabel(...)`
- `formatTurnEventPathLabel(...)`
- `formatTurnEventSearchLabel(...)`

- [ ] **Step 2: Re-enable telemetry tool activity writes in `createCliObserver(...)`**

In `src/cli/main.ts`, remove the suppress guard from all three telemetry write callbacks:

```ts
writeActivityLine(text, toolCallId) {
  options.assistantBlockWriter.writeAssistantLine(text, toolCallId);
},
writeActivityLineBelow(toolCallId, text) {
  options.assistantBlockWriter.writeAssistantLineBelow(toolCallId, text);
},
replaceActivityLine(toolCallId, text) {
  options.assistantBlockWriter.replaceAssistantLine(toolCallId, text);
},
```

And remove this option at CLI observer construction:

```ts
suppressTelemetryToolActivity: !options.runTurn,
```

Also remove `suppressTelemetryToolActivity?: boolean;` from the observer options type if nothing else uses it.

- [ ] **Step 3: Run the focused CLI regression tests to verify they pass**

Run:
```bash
npm test -- tests/cli/repl.test.ts -t "renders streamed turn failure once and returns a non-zero exit when the stream throws after turn_failed|renders streamed turn failure with tool completion preview and returns a non-zero exit when the stream throws after turn_failed"
```

Expected: PASS with exactly one ` ✦ file read src/cli/main.ts` line in each transcript.

### Task 4: Verify telemetry formatting remains correct and debug-log behavior is untouched

**Files:**
- Modify: none or `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Run the focused telemetry display tests**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "replaces shell tool activity lines with completion lines that reuse the original command|replaces completion lines for file actions using the original compact labels|stops interactive animation after tool_call_completed and finalizes the same tool line"
```

Expected: PASS, confirming compact mode still uses compact summaries and interactive mode still appends the completion line with duration.

- [ ] **Step 2: Run the debug-log regression test**

Run:
```bash
npm test -- tests/cli/repl.test.ts -t "writes telemetry events to the selected debug log path when enabled"
```

Expected: PASS with no changes required to log content or file structure.

- [ ] **Step 3: Run the broader CLI render regression tests**

Run:
```bash
npm test -- tests/cli/repl.test.ts -t "streams real runtime tool activity in prompt mode without duplicate telemetry render|renders streamed tool activity inline when the stream includes both assistant text and tool events"
```

Expected: PASS, confirming prompt mode stays non-duplicated and live tool activity behavior remains stable.

- [ ] **Step 4: Inspect the final diff**

Run:
```bash
git diff -- src/cli/main.ts src/telemetry/display.ts tests/cli/repl.test.ts tests/telemetry/display.test.ts
```

Expected final scope:
- `src/cli/main.ts`
  - telemetry tool render suppression removed
  - turn-event tool UI rendering removed
- `src/telemetry/display.ts`
  - no debug-log changes; interactive completion still includes duration
- `tests/cli/repl.test.ts`
  - restored interactive tool-line expectations
  - duplicate guard assertions
- `tests/telemetry/display.test.ts`
  - explicit interactive duration assertion
