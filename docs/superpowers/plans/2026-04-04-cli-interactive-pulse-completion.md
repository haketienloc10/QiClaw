# CLI Interactive Pulse Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the interactive tool-call glyph line visible after completion, append the success line underneath it, and speed up the glyph pulse interval to 80ms.

**Architecture:** Preserve the existing interactive glyph animation lifecycle in `src/telemetry/display.ts`, but split completion behavior by mode: compact mode still replaces the activity line, while interactive mode appends a separate completion line after stopping the animation. Update `tests/telemetry/display.test.ts` to assert the faster 80ms redraw cadence and the restored interactive completion behavior without touching unrelated CLI layout code.

**Tech Stack:** TypeScript, picocolors, Node.js timers, Vitest

---

## File structure

- Modify: `src/telemetry/display.ts`
  - Change `interactiveToolPulseIntervalMs` from `1000` to `80`.
  - Adjust `tool_call_completed` handling so interactive mode appends the completion line instead of replacing the activity line.
- Modify: `tests/telemetry/display.test.ts`
  - Update interactive redraw/cleanup tests to use the 80ms cadence.
  - Restore the completion test to verify the tool activity line remains in `activityLines` and the success line is appended separately.

### Task 1: Add a failing test for interactive completion append behavior

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Write the failing test updates**

In `tests/telemetry/display.test.ts`, update `stops interactive animation after tool_call_completed and finalizes the same tool line` so it asserts the interactive completion line is appended to `activityLines` instead of replacing the original tool line through `redraws`.

Use this assertion block after the completion event:

```ts
expect(vi.getTimerCount()).toBe(0);
expect(redraws.get('call-completed')).toEqual([
  expect.stringContaining('✦')
]);
expect(activityLines).toEqual([
  initialActivityLine!,
  expect.stringContaining('Success')
]);

vi.advanceTimersByTime(240);

expect(redraws.get('call-completed')).toHaveLength(1);
expect(activityLines).toHaveLength(2);
```

Also update the redraw timing in that test from `1000` to `80`:

```ts
vi.advanceTimersByTime(80);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "stops interactive animation after tool_call_completed and finalizes the same tool line"
```

Expected: FAIL because the current interactive completion path still uses `replaceActivityLine(...)`, so the success line is not appended to `activityLines`.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/telemetry/display.test.ts
git commit -m "test: expect appended interactive completion line"
```

### Task 2: Implement interactive completion append behavior and 80ms interval

**Files:**
- Modify: `src/telemetry/display.ts:35-119`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Change the pulse interval**

In `src/telemetry/display.ts`, update:

```ts
const interactiveToolPulseIntervalMs = 80;
```

- [ ] **Step 2: Split completion behavior by mode**

In the `tool_call_completed` branch, replace the current completion rendering block with:

```ts
if (line) {
  if (options.replaceActivityLine && mode === 'compact') {
    options.replaceActivityLine(event.data.toolCallId, line);
  } else {
    options.writeActivityLine(line);
  }
}
```

This preserves compact replacement while restoring separate-line completion for interactive mode.

- [ ] **Step 3: Run the focused completion test to verify it passes**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "stops interactive animation after tool_call_completed and finalizes the same tool line"
```

Expected: PASS, with the original tool activity line preserved and the success line appended separately.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "fix: append interactive completion line below pulse"
```

### Task 3: Update the remaining interactive pulse tests to 80ms cadence

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Update redraw timing in the running-tool test**

In `redraws the active interactive tool line while the tool is still running`, change:

```ts
const redrawIntervalMs = 80;
vi.advanceTimersByTime(redrawIntervalMs);
```

- [ ] **Step 2: Update fallback test wait time**

In `does not animate interactive tool activity when replaceActivityLine is unavailable`, change:

```ts
vi.advanceTimersByTime(240);
```

This keeps the test checking multiple fast pulse intervals without starting a timer.

- [ ] **Step 3: Update cleanup test timing**

In both cleanup tests, change the first redraw wait from `1000` to `80` and the post-cleanup wait from `3000` to `240`:

```ts
vi.advanceTimersByTime(80);
expect(redraws.get('call-turn-completed')).toEqual([
  expect.stringContaining('✦')
]);

vi.advanceTimersByTime(240);
expect(redraws.get('call-turn-completed')).toHaveLength(1);
```

```ts
vi.advanceTimersByTime(80);
expect(redraws.get('call-turn-stopped')).toEqual([
  expect.stringContaining('✦')
]);

vi.advanceTimersByTime(240);
expect(redraws.get('call-turn-stopped')).toHaveLength(1);
```

- [ ] **Step 4: Run the focused interactive tests**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "redraws the active interactive tool line while the tool is still running|does not animate interactive tool activity when replaceActivityLine is unavailable|stops interactive animation after tool_call_completed and finalizes the same tool line|stops interactive animation after turn_completed cleanup|stops interactive animation after turn_stopped cleanup"
```

Expected: PASS, confirming the faster 80ms cadence and restored interactive completion behavior.

- [ ] **Step 5: Commit the test timing updates**

```bash
git add tests/telemetry/display.test.ts src/telemetry/display.ts
git commit -m "test: cover fast interactive pulse completion flow"
```

### Task 4: Run the full telemetry display test file and inspect final scope

**Files:**
- Modify: none
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Run the full telemetry display test file**

Run:
```bash
npm test -- tests/telemetry/display.test.ts
```

Expected: PASS with all telemetry display tests green.

- [ ] **Step 2: Inspect the final diff**

Run:
```bash
git diff -- src/telemetry/display.ts tests/telemetry/display.test.ts
```

Expected final scope:
- `src/telemetry/display.ts`
  - pulse interval changed to `80`
  - interactive completion path appends instead of replacing
- `tests/telemetry/display.test.ts`
  - interactive timing assertions updated to `80` / `240`
  - completion assertion updated to keep the original tool line and append `Success`

- [ ] **Step 3: Commit if a final cleanup was needed**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "chore: verify interactive pulse completion behavior"
```

Skip this commit if Task 4 required no file changes.

## Self-review

### Spec coverage
- Interactive completion preserves the tool activity line: covered by Tasks 1-2.
- Interactive success line is appended separately: covered by Tasks 1-2.
- Pulse interval changes to 80ms: covered by Tasks 2-3.
- Fallback and turn cleanup behavior remain intact: covered by Task 3.
- Compact mode replacement behavior remains unchanged: covered by Task 2 implementation and Task 4 full test file run.
- No changes to `QiClaw` chrome/layout or glyph sequence: no task edits any CLI layout file or the glyph list.

### Placeholder scan
- No `TODO`, `TBD`, or vague placeholders remain.
- Each code change or verification step includes explicit code or exact commands.

### Type consistency
- The plan consistently uses `interactiveToolPulseIntervalMs`, `writeActivityLine`, `replaceActivityLine`, `activityLines`, and the current interactive test names.
- No new API names are introduced outside the existing telemetry display observer surface.
