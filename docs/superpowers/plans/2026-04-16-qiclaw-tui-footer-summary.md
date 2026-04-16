# QiClaw TUI Footer Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a richer TUI status strip that shows a turn summary on the left and a right-aligned `provider:model`, while keeping the existing footer rail and composer layout intact.

**Architecture:** The TypeScript TUI controller will compute per-turn footer summary strings from real turn events and settled results, then publish them through a small host event/state update path. The Rust TUI will keep layout unchanged, extend footer state with explicit summary/model fields, and render the status strip as a two-sided line that truncates the left side before the model.

**Tech Stack:** TypeScript, Vitest, Rust, ratatui, existing QiClaw TUI bridge protocol

---

## File Map

### Existing files to modify

- `src/cli/tuiProtocol.ts`
  - Extend the host event schema with a dedicated footer-summary update event and validation.
- `src/cli/tuiController.ts`
  - Track per-turn provider/tool/duration metrics, format the TUI summary string, and emit summary/model updates.
- `tests/cli/tuiController.test.ts`
  - Add controller-level tests for summary formatting and emitted events after a completed turn.
- `tui/src/protocol.rs`
  - Mirror the new host event in the Rust protocol enum.
- `tui/src/app.rs`
  - Store `status_text`, `turn_summary_text`, and `model_text` separately and update them from host events.
- `tui/src/footer/state.rs`
  - Extend `FooterState` with explicit `turn_summary_text` and `model_text` fields.
- `tui/src/footer/render.rs`
  - Render a split status strip with right-aligned model text and left-side truncation priority.

### Existing files to verify during implementation

- `src/cli/tuiTranscriptMapper.ts`
  - Confirm that no change is needed because turn-summary emission will happen directly from the controller.
- `tui/src/transcript/layout.rs`
  - Confirm the layout stays unchanged.

---

### Task 1: Add a dedicated footer-summary host event

**Files:**
- Modify: `src/cli/tuiProtocol.ts`
- Modify: `tui/src/protocol.rs`
- Test: `tests/cli/tuiController.test.ts`

- [ ] **Step 1: Write the failing TypeScript test for the new emitted event**

Add a new `it(...)` block near the existing controller tests in `tests/cli/tuiController.test.ts` that asserts a completed turn emits a footer summary event.

```ts
it('emits a footer summary update after a completed turn', async () => {
  const emitted: HostEvent[] = [];

  const controller = createTuiController({
    cwd: '/tmp/qiclaw-footer-summary',
    runtime: {
      provider: { name: 'anthropic', model: 'claude-sonnet-4-6' },
      availableTools: [],
      systemPrompt: 'system prompt',
      cwd: '/tmp/qiclaw-footer-summary',
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
        storeSessionId: 'session-footer-summary',
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
        storeSessionId: 'session-footer-summary',
        engine: 'file-session-memory',
        version: 1,
        memoryPath: '/tmp/memory.jsonl',
        metaPath: '/tmp/meta.json',
        totalEntries: 1,
        lastCompactedAt: null
      }
    })),
    createSessionId: () => 'session-footer-summary',
    executeTurn: async () => ({
      stopReason: 'completed',
      finalAnswer: 'done',
      history: [
        { role: 'user', content: 'summarize' },
        { role: 'assistant', content: 'done' }
      ],
      historySummary: undefined,
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 2,
      doneCriteria: {
        goal: 'summarize',
        checklist: ['summarize'],
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
        yield { type: 'assistant_message_completed', text: 'done' };
      })(),
      finalResult: Promise.resolve({
        stopReason: 'completed',
        finalAnswer: 'done',
        history: [
          { role: 'user', content: 'summarize' },
          { role: 'assistant', content: 'done' }
        ],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 2,
        doneCriteria: {
          goal: 'summarize',
          checklist: ['summarize'],
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
    }),
    emit(message) {
      emitted.push(parseBridgeMessage(message));
    }
  });

  await controller.start();
  await controller.handleAction({ type: 'submit_prompt', prompt: 'summarize' });

  expect(emitted).toContainEqual(
    expect.objectContaining({
      type: 'footer_summary',
      text: expect.stringContaining('completed')
    })
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the event type does not exist yet**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: FAIL with a protocol/type error mentioning `footer_summary` or missing host event support.

- [ ] **Step 3: Extend the TypeScript bridge protocol with the new event type**

Update `src/cli/tuiProtocol.ts` so the host event union, validation, and allowed message set all know about `footer_summary`.

```ts
export type HostEvent =
  | { type: 'hello'; protocolVersion: 1; sessionId: string; model: string; cwd: string }
  | { type: 'session_loaded'; restored: boolean; sessionId: string; historySummary?: string }
  | { type: 'transcript_seed'; cells: TranscriptCell[] }
  | { type: 'transcript_append'; cells: TranscriptCell[] }
  | { type: 'assistant_delta'; turnId: string; messageId: string; text: string }
  | { type: 'assistant_completed'; turnId: string; messageId: string; text: string }
  | { type: 'tool_started'; turnId: string; toolCallId: string; toolName: string; label: string }
  | { type: 'tool_completed'; turnId: string; toolCallId: string; toolName: string; status: 'success' | 'error'; resultPreview: string; durationMs?: number }
  | { type: 'status'; text: string }
  | { type: 'footer'; text: string }
  | { type: 'footer_summary'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'error'; text: string }
  | { type: 'turn_completed'; turnId: string; stopReason: string; finalAnswer: string }
  | { type: 'slash_catalog'; commands: SlashCatalogEntry[] };
```

Add `footer_summary` to the validation switch and `bridgeMessageTypes` set.

```ts
case 'status':
case 'footer':
case 'footer_summary':
case 'warning':
case 'error':
  return typeof value.text === 'string';
```

```ts
const bridgeMessageTypes = new Set<string>([
  'hello',
  'session_loaded',
  'transcript_seed',
  'transcript_append',
  'assistant_delta',
  'assistant_completed',
  'tool_started',
  'tool_completed',
  'status',
  'footer',
  'footer_summary',
  'warning',
  'error',
  'turn_completed',
  'slash_catalog',
  'submit_prompt',
  'run_slash_command',
  'run_shell_command',
  'request_status',
  'clear_session',
  'quit'
]);
```

- [ ] **Step 4: Mirror the new event in the Rust protocol enum**

Update `tui/src/protocol.rs` to add the new host event variant.

```rust
    Status {
        text: String,
    },
    Footer {
        text: String,
    },
    FooterSummary {
        text: String,
    },
    Warning {
        text: String,
    },
```

No new frontend action is needed.

- [ ] **Step 5: Run the focused TypeScript test again**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: still FAIL, but now on missing controller emission/formatting rather than unknown protocol shape.

- [ ] **Step 6: Commit the protocol groundwork**

```bash
git add src/cli/tuiProtocol.ts tui/src/protocol.rs tests/cli/tuiController.test.ts
git commit -m "feat: add tui footer summary bridge event"
```

### Task 2: Compute and emit turn summary strings in the TUI controller

**Files:**
- Modify: `src/cli/tuiController.ts`
- Test: `tests/cli/tuiController.test.ts`

- [ ] **Step 1: Add failing tests for summary formatting and metrics counting**

Extend `tests/cli/tuiController.test.ts` with a focused test that simulates provider calls, tool calls, and elapsed time, then asserts the emitted footer summary string.

```ts
it('formats completed footer summary with verification, provider count, tool count, and seconds', async () => {
  const emitted: HostEvent[] = [];

  const recordObserverEvents: Array<(event: { type: string; data?: Record<string, unknown> }) => void> = [];
  const observer = {
    record(event: { type: string; data?: Record<string, unknown> }) {
      for (const listener of recordObserverEvents) {
        listener(event);
      }
    }
  };

  const controller = createTuiController({
    cwd: '/tmp/qiclaw-footer-summary-format',
    runtime: {
      provider: { name: 'anthropic', model: 'claude-sonnet-4-6' },
      availableTools: [],
      systemPrompt: 'system prompt',
      cwd: '/tmp/qiclaw-footer-summary-format',
      maxToolRounds: 4,
      observer
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
        storeSessionId: 'session-format',
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
        storeSessionId: 'session-format',
        engine: 'file-session-memory',
        version: 1,
        memoryPath: '/tmp/memory.jsonl',
        metaPath: '/tmp/meta.json',
        totalEntries: 0,
        lastCompactedAt: null
      }
    })),
    createSessionId: () => 'session-format',
    executeTurn: async () => ({
      stopReason: 'completed',
      finalAnswer: 'done',
      history: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'done' }
      ],
      historySummary: undefined,
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 2,
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
        yield { type: 'tool_call_started', id: 'tool-2', name: 'grep', input: { pattern: 'x' } };
        yield { type: 'tool_call_completed', id: 'tool-2', name: 'grep', resultPreview: 'ok', isError: false, durationMs: 10 };
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
        toolRoundsUsed: 2,
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
    }),
    emit(message) {
      emitted.push(parseBridgeMessage(message));
    }
  });

  await controller.start();
  await controller.handleAction({ type: 'submit_prompt', prompt: 'question' });

  expect(emitted).toContainEqual({
    type: 'footer_summary',
    text: 'completed • verified • 1 provider • 2 tools • 18s'
  });
});
```

In the test body, replace the hard-coded `18s` by using fake timers and controlled `Date.now()` values so the assertion is deterministic.

- [ ] **Step 2: Run the focused test and verify it fails because formatting logic is missing**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: FAIL because `footer_summary` is not emitted or text does not match the expected string.

- [ ] **Step 3: Add controller-local helpers for summary formatting**

In `src/cli/tuiController.ts`, add explicit helper types and formatting utilities near `formatProviderModel()`.

```ts
interface TurnSummaryMetrics {
  providerCalls: number;
  toolCalls: number;
  durationMs: number;
}

function summarizeStopReason(stopReason: string): string {
  if (stopReason === 'completed') {
    return 'completed';
  }
  if (stopReason === 'max_tool_rounds_reached') {
    return 'max tools';
  }
  return 'stopped';
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTurnDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }

  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

function formatFooterSummary(args: {
  stopReason: string;
  isVerified: boolean;
  providerCalls: number;
  toolCalls: number;
  durationMs: number;
}): string {
  const parts = [
    summarizeStopReason(args.stopReason),
    ...(args.isVerified ? ['verified'] : []),
    pluralize(args.providerCalls, 'provider', 'providers'),
    pluralize(args.toolCalls, 'tool', 'tools'),
    formatTurnDuration(args.durationMs)
  ];

  return parts.join(' • ');
}
```

- [ ] **Step 4: Collect real per-turn metrics and emit `footer_summary` after final result settles**

Update `runPrompt(...)` in `src/cli/tuiController.ts` to track summary metrics from the start of the turn through settled completion.

```ts
async function runPrompt(prompt: string): Promise<void> {
  turnOrdinal += 1;
  assistantMessageOrdinal += 1;
  const liveTranscriptState = createLiveTurnTranscriptState();
  const turnStartedAt = Date.now();
  const turnSummaryMetrics: TurnSummaryMetrics = {
    providerCalls: 0,
    toolCalls: 0,
    durationMs: 0
  };
  let preparedMemory: PrepareInteractiveSessionMemoryResult | undefined;
```

Increment counts from actual events:

```ts
      if (resultWithSummary.turnStream) {
        for await (const event of resultWithSummary.turnStream) {
          if (event.type === 'tool_call_completed') {
            turnSummaryMetrics.toolCalls += 1;
          }

          const mapped = mapTurnEventToBridgeEvent(event, {
            turnOrdinal,
            assistantMessageOrdinal
          });
```

Wrap the runtime observer to count provider calls without changing global telemetry behavior:

```ts
      const countingObserver = {
        record(event: Parameters<NonNullable<typeof options.runtime.observer>['record']>[0]) {
          if (event.type === 'provider_called') {
            turnSummaryMetrics.providerCalls += 1;
          }
          options.runtime.observer?.record(event);
        }
      };
```

Pass `countingObserver` into `executeTurn(...)` instead of `options.runtime.observer`.

After `settled` resolves, compute and emit the final summary:

```ts
      turnSummaryMetrics.durationMs = Date.now() - turnStartedAt;

      emit({
        type: 'footer_summary',
        text: formatFooterSummary({
          stopReason: settled.stopReason,
          isVerified: settled.verification.isVerified,
          providerCalls: turnSummaryMetrics.providerCalls,
          toolCalls: turnSummaryMetrics.toolCalls,
          durationMs: turnSummaryMetrics.durationMs
        })
      });
```

- [ ] **Step 5: Ensure direct status updates do not accidentally overwrite the dedicated summary path**

Keep existing `status` and `footer` emission behavior intact. Do not replace them with `footer_summary`; only emit `footer_summary` after a turn settles.

No code block is needed here beyond confirming the existing direct-command branches stay unchanged:

```ts
if (result.footer) {
  emit({ type: 'status', text: result.footer });
}
```

- [ ] **Step 6: Run the focused controller test and make it pass**

Run: `npm test -- --run tests/cli/tuiController.test.ts`

Expected: PASS, including the new summary-format assertions.

- [ ] **Step 7: Commit the controller summary logic**

```bash
git add src/cli/tuiController.ts tests/cli/tuiController.test.ts
git commit -m "feat: emit tui footer turn summaries"
```

### Task 3: Extend Rust footer state and render the split status strip

**Files:**
- Modify: `tui/src/footer/state.rs`
- Modify: `tui/src/footer/render.rs`

- [ ] **Step 1: Write the failing Rust tests for split rendering and truncation behavior**

Add these tests to `tui/src/footer/render.rs`.

```rust
#[test]
fn status_strip_renders_turn_summary_on_left_and_model_on_right() {
    let state = FooterState {
        status_text: "Ready".into(),
        turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
        model_text: "anthropic:claude-sonnet-4-6".into(),
        ..FooterState::default()
    };

    let rendered = rendered_line(80, render_status_strip, &state);

    assert!(rendered.contains("completed • verified"));
    assert!(rendered.contains("anthropic:claude-sonnet-4-6"));
    assert!(rendered.trim_end().ends_with("anthropic:claude-sonnet-4-6"));
}

#[test]
fn status_strip_falls_back_to_status_text_when_no_turn_summary_exists() {
    let state = FooterState {
        status_text: "Session restored".into(),
        model_text: "openai:gpt-test".into(),
        ..FooterState::default()
    };

    let rendered = rendered_line(48, render_status_strip, &state);

    assert!(rendered.contains("Session restored"));
    assert!(rendered.contains("openai:gpt-test"));
}

#[test]
fn status_strip_truncates_left_side_before_model() {
    let state = FooterState {
        status_text: "Ready".into(),
        turn_summary_text: Some("completed • verified • 1 provider • 2 tools • 18s".into()),
        model_text: "anthropic:claude-sonnet-4-6".into(),
        ..FooterState::default()
    };

    let rendered = rendered_line(36, render_status_strip, &state);

    assert!(rendered.contains("claude-sonnet-4-6") || rendered.contains("anthropic:"));
    assert!(!rendered.contains("completed • verified • 1 provider • 2 tools • 18s"));
}
```

- [ ] **Step 2: Run the Rust footer tests and verify they fail because the state fields and render logic do not exist yet**

Run: `cargo test --manifest-path tui/Cargo.toml footer::render`

Expected: FAIL with unknown struct fields or missing render behavior.

- [ ] **Step 3: Extend `FooterState` with explicit summary and model fields**

Update `tui/src/footer/state.rs`.

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FooterState {
    pub status_text: String,
    pub turn_summary_text: Option<String>,
    pub model_text: String,
    pub mode: ComposerMode,
    pub draft_present: bool,
    pub popup_open: bool,
    pub busy: bool,
    pub transcript_scrolled: bool,
    pub shift_enter_supported: bool,
}

impl Default for FooterState {
    fn default() -> Self {
        Self {
            status_text: "Ready".into(),
            turn_summary_text: None,
            model_text: String::new(),
            mode: ComposerMode::Normal,
            draft_present: false,
            popup_open: false,
            busy: false,
            transcript_scrolled: false,
            shift_enter_supported: false,
        }
    }
}
```

- [ ] **Step 4: Implement split status rendering with left-side truncation priority**

Replace `render_status_strip(...)` in `tui/src/footer/render.rs` with logic that reserves room for the model first, then truncates the left side.

```rust
pub fn render_status_strip(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let model = state.model_text.as_str();
    let left_source = state.turn_summary_text.as_deref().unwrap_or(&state.status_text);
    let width = area.width as usize;

    let rendered = if model.is_empty() || width == 0 {
        truncate(left_source, width)
    } else {
        let model_width = model.chars().count();
        if model_width >= width {
            truncate(model, width)
        } else {
            let gap = 1;
            let left_width = width.saturating_sub(model_width + gap);
            let left = truncate(left_source, left_width);
            let padding = " ".repeat(width.saturating_sub(left.chars().count() + model_width));
            format!("{left}{padding}{model}")
        }
    };

    let line = Line::from(Span::styled(rendered, Style::default().fg(Color::DarkGray)));
    frame.render_widget(Paragraph::new(line), area);
}
```

Keep `render_footer_rail(...)` unchanged.

- [ ] **Step 5: Run the focused Rust footer tests and make them pass**

Run: `cargo test --manifest-path tui/Cargo.toml footer::render`

Expected: PASS for the new status-strip tests and the existing footer-rail tests.

- [ ] **Step 6: Commit the Rust footer state/render changes**

```bash
git add tui/src/footer/state.rs tui/src/footer/render.rs
git commit -m "feat: render split tui status strip"
```

### Task 4: Wire host events into the Rust app state and verify end-to-end behavior

**Files:**
- Modify: `tui/src/app.rs`
- Test: `tests/cli/tuiController.test.ts`
- Verify: `tui/src/transcript/layout.rs`

- [ ] **Step 1: Add a failing controller assertion that the model still appears in hello/startup state and summary updates do not replace it**

Extend `tests/cli/tuiController.test.ts` with assertions on startup and post-turn events.

```ts
expect(emitted[0]).toMatchObject({
  type: 'hello',
  protocolVersion: 1,
  sessionId: 'session-restored',
  model: 'gpt-test'
});

expect(emitted).toContainEqual(
  expect.objectContaining({
    type: 'footer_summary',
    text: expect.stringContaining('completed')
  })
);
```

This will initially still fail on the Rust side until the frontend consumes the event.

- [ ] **Step 2: Update `App` state to keep `status_text`, `turn_summary_text`, and `model` distinct**

Modify the `App` struct and initialization in `tui/src/app.rs`.

```rust
pub struct App {
    bridge: ActionWriter,
    rx: Receiver<HostEvent>,
    transcript: TranscriptState,
    composer: ComposerState,
    footer: FooterState,
    slash_catalog: Vec<SlashCatalogEntry>,
    cwd: PathBuf,
    spinner: Spinner,
    session_id: Option<String>,
    model: Option<String>,
    status_text: String,
    turn_summary_text: Option<String>,
    should_quit: bool,
}
```

Initialize it in `App::new(...)`:

```rust
            model: None,
            status_text: "Ready".into(),
            turn_summary_text: None,
            should_quit: false,
```

- [ ] **Step 3: Update host-event handling so startup/model/status/summary semantics are separate**

Modify the `match` in `handle_host_event(...)`.

```rust
            HostEvent::Hello {
                session_id,
                model,
                cwd,
                ..
            } => {
                self.session_id = Some(session_id.clone());
                self.model = Some(model.clone());
                self.cwd = PathBuf::from(cwd);
            }
            HostEvent::SessionLoaded { restored, .. } => {
                self.status_text = if *restored {
                    "Session restored".into()
                } else {
                    "New session".into()
                };
            }
            HostEvent::FooterSummary { text } => {
                self.turn_summary_text = Some(text.clone());
            }
            HostEvent::Status { text }
            | HostEvent::Footer { text }
            | HostEvent::Warning { text } => {
                self.status_text = text.clone();
            }
            HostEvent::Error { text } => {
                self.status_text = text.clone();
                self.composer.set_busy(false);
            }
```

Do not overwrite `status_text` with the model on `Hello`; the model belongs in `model_text` now.

- [ ] **Step 4: Push the new fields into `FooterState` from `update_footer()`**

Update the existing footer-sync method in `tui/src/app.rs` so it assigns the new fields.

```rust
fn update_footer(&mut self) {
    self.footer.status_text = self.status_text.clone();
    self.footer.turn_summary_text = self.turn_summary_text.clone();
    self.footer.model_text = self.model.clone().unwrap_or_default();
    self.footer.mode = self.composer.mode();
    self.footer.draft_present = self.composer.has_draft();
    self.footer.popup_open = self.composer.popup.visible;
    self.footer.busy = self.composer.busy;
    self.footer.transcript_scrolled = self.transcript.is_scrolled();
}
```

Match the exact composer/transcript accessors that already exist in the current `update_footer()` implementation; keep those lines unchanged except for the added state assignments.

- [ ] **Step 5: Verify no layout change is needed**

Open `tui/src/transcript/layout.rs` and confirm no code change is required because the design still uses the existing one-line status row.

No code edit is expected in this step.

- [ ] **Step 6: Run the targeted test suites**

Run:

```bash
npm test -- --run tests/cli/tuiController.test.ts
cargo test --manifest-path tui/Cargo.toml footer::render
cargo test --manifest-path tui/Cargo.toml
```

Expected:
- Vitest controller tests PASS
- footer render tests PASS
- full Rust TUI test suite PASS

- [ ] **Step 7: Run the full project verification for the touched surfaces**

Run:

```bash
npm test
cargo test --manifest-path tui/Cargo.toml
cargo build --manifest-path tui/Cargo.toml
```

Expected:
- all existing JS/TS tests PASS
- all Rust TUI tests PASS
- Rust TUI build succeeds

- [ ] **Step 8: Commit the wiring and verification pass**

```bash
git add src/cli/tuiController.ts tests/cli/tuiController.test.ts tui/src/app.rs tui/src/footer/state.rs tui/src/footer/render.rs src/cli/tuiProtocol.ts tui/src/protocol.rs
git commit -m "feat: surface turn summaries in tui footer"
```

---

## Self-Review Against Spec

### Spec coverage

- **Keep current shell/layout** → Task 3 preserves footer rail; Task 4 explicitly confirms no `tui/src/transcript/layout.rs` change is needed.
- **Status strip shows turn summary on left** → Task 2 emits `footer_summary`; Task 3 renders left text from `turn_summary_text`.
- **Model right-aligned** → Task 3 reserves width for `model_text` and tests right-edge placement.
- **Summary includes stop state, verification, provider count, tool calls, total duration** → Task 2 defines formatter helpers and metrics tracking from real events plus elapsed wall-clock time.
- **Summary should be shorter than CLI and not copy token counts** → Task 2’s formatter omits tokens and uses compact labels only.
- **Footer rail unchanged** → Task 3 keeps `render_footer_rail(...)` as-is.
- **Architecture stays close to current host↔TUI flow** → Task 1 adds a small bridge event; Tasks 2 and 4 keep controller/render responsibilities separated.

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” steps remain.
- Each code-changing step includes concrete code snippets.
- Each verification step includes exact commands and expected outcomes.

### Type consistency

- New event name is consistently `footer_summary` in TypeScript and `FooterSummary` in Rust.
- Footer state field names are consistently `turn_summary_text` and `model_text`.
- Summary formatter uses `providerCalls`, `toolCalls`, and `durationMs` consistently across helper definitions and emission sites.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-16-qiclaw-tui-footer-summary.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
