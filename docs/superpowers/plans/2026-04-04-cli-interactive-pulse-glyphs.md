# CLI Interactive Pulse Glyphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interactive telemetry pulse animation with a colored six-glyph sequence `✦ → ✧ → ✱ → ✲ → ✳ → ✴` while preserving the existing redraw, completion, and cleanup behavior.

**Architecture:** Keep the existing timer-driven interactive tool activity animation in `src/telemetry/display.ts` and swap only the pulse frame contents from a color-shifting `⚡` to a six-frame colored glyph sequence. Update tests in `tests/telemetry/display.test.ts` only where they assert the exact rendered interactive glyph so the current lifecycle guarantees remain covered.

**Tech Stack:** TypeScript, picocolors, Node.js timers, Vitest

---

## File structure

- Modify: `src/telemetry/display.ts`
  - Replace the `interactiveToolPulseFrames` constant with a six-frame colored glyph array.
  - Preserve timing, per-tool animation state, redraw flow, completion handling, and turn-end cleanup.
- Modify: `tests/telemetry/display.test.ts`
  - Update interactive animation assertions that currently expect `⚡` to instead expect the new glyph sequence or a specific initial glyph.
  - Keep fallback and cleanup coverage intact.

### Task 1: Add a failing test for the new initial interactive glyph

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/telemetry/display.test.ts`, update the existing interactive redraw test so it asserts the initial activity line uses the first new glyph `✦` instead of the old `⚡`.

Use this assertion block in the test `redraws the active interactive tool line while the tool is still running`:

```ts
const initialActivityLine = activityLines[0];
expect(initialActivityLine).toContain('✦');
expect(initialActivityLine).toContain('read src/cli/main.ts');
expect(redraws.get('call-1')).toBeUndefined();

const redrawIntervalMs = 1000;
vi.advanceTimersByTime(redrawIntervalMs);

expect(redraws.get('call-1')).toEqual([initialActivityLine!]);
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "redraws the active interactive tool line while the tool is still running"
```

Expected: FAIL because the current initial interactive line still contains `⚡`, not `✦`.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/telemetry/display.test.ts
git commit -m "test: expect interactive pulse glyph frames"
```

### Task 2: Replace the pulse frames in telemetry display

**Files:**
- Modify: `src/telemetry/display.ts:29-86`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Replace the frame array**

In `src/telemetry/display.ts`, replace the current `interactiveToolPulseFrames` constant with:

```ts
const interactiveToolPulseFrames = [
  pc.cyan('✦'),
  pc.blue('✧'),
  pc.magenta('✱'),
  pc.yellow('✲'),
  pc.green('✳'),
  pc.white('✴')
];
```

- [ ] **Step 2: Preserve the existing timing and redraw logic**

Do not change these lines except as needed to keep type-checking valid:

```ts
const interactiveToolPulseIntervalMs = 1000;

options.replaceActivityLine?.(
  toolCallId,
  formatToolActivityLine(activeAnimation.label, mode, activeAnimation.frameIndex)
);
activeAnimation.frameIndex = (activeAnimation.frameIndex + 1) % interactiveToolPulseFrames.length;

frameIndex: 1
```

This preserves the current behavior where the initial render uses the first frame and the timer keeps cycling through the remaining frames.

- [ ] **Step 3: Run the focused test to verify it passes**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "redraws the active interactive tool line while the tool is still running"
```

Expected: PASS, with the initial activity line now containing `✦`.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "feat: use colored glyphs for interactive pulse"
```

### Task 3: Update fallback and completion assertions for the new glyph set

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Update fallback-path assertion**

In the test `does not animate interactive tool activity when replaceActivityLine is unavailable`, replace the current broad content assertion with a glyph-aware one:

```ts
expect(activityLines).toHaveLength(1);
expect(activityLines[0]).toContain('✦');
expect(activityLines[0]).toContain('read src/cli/main.ts');
expect(vi.getTimerCount()).toBe(0);
```

- [ ] **Step 2: Update the completion-path assertion**

In the test `stops interactive animation after tool_call_completed and finalizes the same tool line`, make the first redraw assertion explicit about the first glyph frame:

```ts
vi.advanceTimersByTime(1000);
expect(redraws.get('call-completed')).toEqual([
  expect.stringContaining('✦')
]);
```

Keep the later completion assertion unchanged:

```ts
expect(redraws.get('call-completed')).toEqual([
  activityLines[0]!,
  expect.stringContaining('Success')
]);
```

- [ ] **Step 3: Update turn cleanup assertions**

In both cleanup tests, make the first redraw assertion glyph-aware:

```ts
vi.advanceTimersByTime(1000);
expect(redraws.get('call-turn-completed')).toEqual([
  expect.stringContaining('✦')
]);
```

```ts
vi.advanceTimersByTime(1000);
expect(redraws.get('call-turn-stopped')).toEqual([
  expect.stringContaining('✦')
]);
```

- [ ] **Step 4: Run the focused cleanup tests**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "does not animate interactive tool activity when replaceActivityLine is unavailable|stops interactive animation after tool_call_completed and finalizes the same tool line|stops interactive animation after turn_completed cleanup|stops interactive animation after turn_stopped cleanup"
```

Expected: PASS, confirming the new glyph set does not break fallback, completion, or turn cleanup behavior.

- [ ] **Step 5: Commit the test updates**

```bash
git add tests/telemetry/display.test.ts
git commit -m "test: cover interactive pulse glyph lifecycle"
```

### Task 4: Run the full telemetry display test file

**Files:**
- Modify: none
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Run the full test file**

Run:
```bash
npm test -- tests/telemetry/display.test.ts
```

Expected: PASS with all telemetry display tests green.

- [ ] **Step 2: Inspect the final diff for scope**

Run:
```bash
git diff -- src/telemetry/display.ts tests/telemetry/display.test.ts
```

Expected scope:
- `src/telemetry/display.ts` changes only in `interactiveToolPulseFrames`
- `tests/telemetry/display.test.ts` changes only in glyph-specific assertions

- [ ] **Step 3: Commit if a final cleanup was required**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "chore: verify interactive pulse glyph update"
```

Skip this commit if Task 4 required no file changes.

## Self-review

### Spec coverage
- Replace `⚡` pulse with six colored glyphs: covered by Task 2.
- Keep timing unchanged: covered by Task 2 Step 2.
- Preserve same-line redraw behavior: covered by Tasks 2 and 3.
- Preserve completion and turn cleanup behavior: covered by Task 3.
- Keep compact mode unchanged: covered by Task 4 scope inspection and the existing compact tests in the full file run.
- Do not touch `QiClaw` chrome/layout: no task changes any CLI layout file.

### Placeholder scan
- No `TODO`, `TBD`, or “similar to Task N” placeholders remain.
- Every code-changing step includes explicit code or exact commands.

### Type consistency
- The plan consistently uses `interactiveToolPulseFrames`, `interactiveToolPulseIntervalMs`, `frameIndex`, and the existing test names from `tests/telemetry/display.test.ts`.
- No new helper names or APIs are introduced beyond the existing implementation.
