# CLI Interactive Pulse Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animate the interactive telemetry `⚡` icon so active tool lines pulse through `gray → yellow → white → yellow` until completion.

**Architecture:** Extend the compact CLI telemetry observer in `src/telemetry/display.ts` with per-tool animation state keyed by `toolCallId`. Start a redraw timer only in interactive mode when `replaceActivityLine` exists, render the current frame by reusing the existing activity line formatter, and tear down timers on completion or turn end.

**Tech Stack:** TypeScript, Node.js timers, picocolors, Vitest

---

## File structure

- Modify: `src/telemetry/display.ts`
  - Add pulse frame constants and per-tool animation state.
  - Start/stop redraw timers from telemetry events.
  - Update activity line formatting to accept an explicit interactive icon frame.
- Modify: `tests/telemetry/display.test.ts`
  - Add focused tests for interactive animation setup, redraw, fallback, and cleanup.

### Task 1: Add a failing test for interactive pulse redraw

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test near the other `createCompactCliTelemetryObserver` cases:

```ts
it('animates the interactive activity icon with replaceActivityLine while a tool is running', () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const replaced = new Map<string, string[]>();
  const observer = createCompactCliTelemetryObserver({
    mode: 'interactive',
    writeActivityLine(text, toolCallId) {
      lines.push(`${toolCallId ?? 'none'}:${text}`);
    },
    replaceActivityLine(toolCallId, text) {
      const updates = replaced.get(toolCallId) ?? [];
      updates.push(text);
      replaced.set(toolCallId, updates);
    },
    writeFooterLine() {}
  });

  observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
    turnId: 'turn-1',
    providerRound: 1,
    toolRound: 1,
    toolName: 'read_file',
    toolCallId: 'call-1',
    inputPreview: '{"path":"src/cli/main.ts"}',
    inputRawRedacted: { path: 'src/cli/main.ts' }
  }));

  vi.advanceTimersByTime(240);

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('call-1:');
  expect(lines[0]).toContain('read src/cli/main.ts');
  expect(replaced.get('call-1') ?? []).toHaveLength(3);
  expect(new Set((replaced.get('call-1') ?? []).map((line) => stripAnsi(line)))).toEqual(
    new Set([' ⚡ read src/cli/main.ts'])
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "animates the interactive activity icon with replaceActivityLine while a tool is running"
```

Expected: FAIL because no timer-driven redraw happens yet, so `replaced.get('call-1')` is empty.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/telemetry/display.test.ts
git commit -m "test: cover interactive telemetry pulse animation"
```

### Task 2: Implement interactive pulse animation in the telemetry observer

**Files:**
- Modify: `src/telemetry/display.ts:1-207`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Add pulse frames and animation state types**

In `src/telemetry/display.ts`, add the animation constants and state near the existing interfaces:

```ts
const interactivePulseFrames = [
  pc.gray('⚡'),
  pc.yellow('⚡'),
  pc.white('⚡'),
  pc.yellow('⚡')
] as const;

const interactivePulseIntervalMs = 80;

interface InteractiveAnimationState {
  label: string;
  frameIndex: number;
  intervalId: ReturnType<typeof setInterval>;
}
```

- [ ] **Step 2: Add helper functions for rendering and cleanup**

Still in `src/telemetry/display.ts`, add helpers before `createPendingFooterState`:

```ts
function formatToolActivityLine(
  label: string,
  mode: 'compact' | 'interactive',
  interactiveIcon: string = pc.cyan('⚡')
): string {
  if (mode === 'interactive') {
    return ` ${interactiveIcon} ${label}`;
  }

  return `· ${label}`;
}

function stopInteractiveAnimation(
  animations: Map<string, InteractiveAnimationState>,
  toolCallId: string
): void {
  const animation = animations.get(toolCallId);
  if (!animation) {
    return;
  }

  clearInterval(animation.intervalId);
  animations.delete(toolCallId);
}

function stopAllInteractiveAnimations(animations: Map<string, InteractiveAnimationState>): void {
  for (const [toolCallId, animation] of animations) {
    clearInterval(animation.intervalId);
    animations.delete(toolCallId);
  }
}
```

- [ ] **Step 3: Start redraw timers on interactive tool start**

Inside `createCompactCliTelemetryObserver`, add an animation map and update the `tool_call_started` branch:

```ts
const interactiveAnimations = new Map<string, InteractiveAnimationState>();
```

Replace the existing start branch body with:

```ts
if (label) {
  toolActivityLabels.set(event.data.toolCallId, label);
  options.writeActivityLine(formatToolActivityLine(label, mode), event.data.toolCallId);

  if (mode === 'interactive' && options.replaceActivityLine) {
    stopInteractiveAnimation(interactiveAnimations, event.data.toolCallId);

    const animation: InteractiveAnimationState = {
      label,
      frameIndex: 0,
      intervalId: setInterval(() => {
        const current = interactiveAnimations.get(event.data.toolCallId);
        if (!current) {
          return;
        }

        current.frameIndex = (current.frameIndex + 1) % interactivePulseFrames.length;
        options.replaceActivityLine?.(
          event.data.toolCallId,
          formatToolActivityLine(label, mode, interactivePulseFrames[current.frameIndex])
        );
      }, interactivePulseIntervalMs)
    };

    interactiveAnimations.set(event.data.toolCallId, animation);
  }
}
```

- [ ] **Step 4: Stop redraw timers on completion and turn finalization**

Update the completion and turn-finalization branches in `createCompactCliTelemetryObserver`:

```ts
if (event.type === 'tool_call_completed') {
  stopInteractiveAnimation(interactiveAnimations, event.data.toolCallId);
  const activityLabel = toolActivityLabels.get(event.data.toolCallId);
  const line = formatToolCompletionLine(event.data, activityLabel, mode);
  toolActivityLabels.delete(event.data.toolCallId);

  if (line) {
    if (options.replaceActivityLine && mode === 'compact') {
      options.replaceActivityLine(event.data.toolCallId, line);
    } else {
      options.writeActivityLine(line);
    }
  }
  return;
}

if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
  stopAllInteractiveAnimations(interactiveAnimations);
  toolActivityLabels.clear();
  pendingFooter = createPendingFooterState(event.data, pendingFooter?.summary);
  return;
}
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "animates the interactive activity icon with replaceActivityLine while a tool is running"
```

Expected: PASS, with exactly one initial write and multiple same-line replacements after timer advancement.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "feat: animate interactive telemetry activity icon"
```

### Task 3: Add failing tests for fallback and cleanup paths

**Files:**
- Modify: `tests/telemetry/display.test.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these two tests in `tests/telemetry/display.test.ts`:

```ts
it('does not animate interactive activity lines when replaceActivityLine is unavailable', () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const observer = createCompactCliTelemetryObserver({
    mode: 'interactive',
    writeActivityLine(text) {
      lines.push(stripAnsi(text));
    },
    writeFooterLine() {}
  });

  observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
    turnId: 'turn-1',
    providerRound: 1,
    toolRound: 1,
    toolName: 'search',
    toolCallId: 'call-2',
    inputPreview: '{"pattern":"promptLabel"}',
    inputRawRedacted: { pattern: 'promptLabel' }
  }));

  vi.advanceTimersByTime(240);

  expect(lines).toEqual([' ⚡ search promptLabel']);
});

it('stops interactive pulse redraw after tool completion and turn completion', () => {
  vi.useFakeTimers();
  const replaced = new Map<string, string[]>();
  const lines: string[] = [];
  const observer = createCompactCliTelemetryObserver({
    mode: 'interactive',
    writeActivityLine(text) {
      lines.push(stripAnsi(text));
    },
    replaceActivityLine(toolCallId, text) {
      const updates = replaced.get(toolCallId) ?? [];
      updates.push(stripAnsi(text));
      replaced.set(toolCallId, updates);
    },
    writeFooterLine() {}
  });

  observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
    turnId: 'turn-1',
    providerRound: 1,
    toolRound: 1,
    toolName: 'read_file',
    toolCallId: 'call-3',
    inputPreview: '{"path":"src/cli/main.ts"}',
    inputRawRedacted: { path: 'src/cli/main.ts' }
  }));

  vi.advanceTimersByTime(160);
  const beforeCompletion = (replaced.get('call-3') ?? []).length;

  observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
    turnId: 'turn-1',
    providerRound: 1,
    toolRound: 1,
    toolName: 'read_file',
    toolCallId: 'call-3',
    isError: false,
    resultPreview: 'ok',
    resultRawRedacted: { content: 'ok' },
    durationMs: 7,
    resultSizeChars: 2,
    resultSizeBucket: 'small'
  }));

  vi.advanceTimersByTime(160);

  expect((replaced.get('call-3') ?? []).length).toBe(beforeCompletion);
  expect(lines.at(-1)).toBe(' └─ ✔ Success (7ms)');

  observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
    turnId: 'turn-2',
    providerRound: 1,
    toolRound: 1,
    toolName: 'search',
    toolCallId: 'call-4',
    inputPreview: '{"pattern":"mode"}',
    inputRawRedacted: { pattern: 'mode' }
  }));

  vi.advanceTimersByTime(80);
  const beforeTurnStop = (replaced.get('call-4') ?? []).length;

  observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
    turnId: 'turn-2',
    providerRound: 1,
    toolRound: 1,
    stopReason: 'completed',
    toolRoundsUsed: 1,
    isVerified: true,
    durationMs: 200
  }));

  vi.advanceTimersByTime(160);

  expect((replaced.get('call-4') ?? []).length).toBe(beforeTurnStop);
});
```

- [ ] **Step 2: Run tests to verify at least one fails before cleanup is finished**

Run:
```bash
npm test -- tests/telemetry/display.test.ts -t "interactive"
```

Expected: FAIL if any cleanup path is incomplete or if the fallback path still schedules redraws.

- [ ] **Step 3: Commit the failing cleanup tests**

```bash
git add tests/telemetry/display.test.ts
git commit -m "test: cover interactive telemetry cleanup paths"
```

### Task 4: Finish cleanup behavior and run the full targeted test file

**Files:**
- Modify: `src/telemetry/display.ts`
- Test: `tests/telemetry/display.test.ts`

- [ ] **Step 1: Adjust the observer until the new cleanup tests pass**

Keep the implementation minimal. The final `record()` control flow in `src/telemetry/display.ts` should satisfy all of these behaviors:

```ts
if (event.type === 'tool_call_started') {
  // write initial line
  // only schedule interval in interactive mode when replaceActivityLine exists
}

if (event.type === 'tool_call_completed') {
  // stop interval first
  // then render completion line
}

if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
  // stop all active intervals before clearing activity labels
}
```

- [ ] **Step 2: Run the full telemetry display test file**

Run:
```bash
npm test -- tests/telemetry/display.test.ts
```

Expected: PASS for existing compact-mode tests and the new interactive animation tests.

- [ ] **Step 3: Commit the finished telemetry observer changes**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts
git commit -m "test: verify interactive telemetry pulse cleanup"
```

### Task 5: Verify the CLI integration manually

**Files:**
- Modify: none
- Test: `src/cli/main.ts:512-538`, `src/telemetry/display.ts`, `tests/telemetry/display.test.ts`

- [ ] **Step 1: Confirm the integration point still passes replacements through the assistant block writer**

Inspect `src/cli/main.ts:512-538` and verify the observer wiring remains:

```ts
compactObserver = createCompactCliTelemetryObserver({
  mode: options.mode,
  writeActivityLine(text, toolCallId) {
    options.assistantBlockWriter.writeAssistantLine(text, toolCallId);
  },
  replaceActivityLine(toolCallId, text) {
    options.assistantBlockWriter.replaceAssistantLine(toolCallId, text);
  },
  writeFooterLine(text) {
    options.assistantBlockWriter.writeFooterLine(renderedText);
  }
});
```

No code change is required here unless the observer API was accidentally broken.

- [ ] **Step 2: Run the CLI or existing REPL path long enough to see the pulse**

Run a local interactive flow that triggers a visible tool call. Example:

```bash
npm test -- tests/telemetry/display.test.ts && npm test -- tests/cli/repl.test.ts
```

Then run the CLI manually using the repo's normal interactive entrypoint and trigger a tool call that lasts long enough to observe the pulse.

Expected:
- The active line stays on one row.
- The `⚡` cycles `gray → yellow → white → yellow`.
- Completion replaces or appends exactly as before once the tool ends.

- [ ] **Step 3: Commit if any final test-only adjustment was needed**

```bash
git add src/telemetry/display.ts tests/telemetry/display.test.ts src/cli/main.ts
git commit -m "chore: verify interactive telemetry pulse integration"
```

Skip this commit if no files changed in this verification task.

## Self-review

### Spec coverage
- Interactive-only animation: covered by Tasks 1-4.
- Exact pulse frame order: covered by Task 2 implementation constants and Task 5 manual verification.
- Fallback when `replaceActivityLine` is absent: covered by Task 3.
- Cleanup on completion and turn end: covered by Tasks 2-4.
- Compact mode unchanged: covered by Task 4 full file run, which preserves existing compact tests.

### Placeholder scan
- No `TODO`, `TBD`, or “similar to above” placeholders remain.
- Each code-changing step includes concrete code or exact commands.

### Type consistency
- Plan uses `InteractiveAnimationState`, `interactivePulseFrames`, `interactivePulseIntervalMs`, `stopInteractiveAnimation`, and `stopAllInteractiveAnimations` consistently.
- Formatter signature is updated once and reused consistently.
