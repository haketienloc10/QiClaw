# QiClaw Codex Shell Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa Rust TUI của QiClaw tiến rất gần Codex về visual shell parity: transcript-first, bottom pane tách lớp rõ ràng, transcript đọc như conversation/work log, và small-terminal vẫn ưu tiên transcript height.

**Architecture:** Thực hiện hoàn toàn ở Rust TUI hiện có, giữ nguyên host↔TUI protocol và event model. Thay đổi tập trung vào `transcript/layout.rs`, `transcript/render.rs`, `composer/mod.rs`, `footer/render.rs`, `footer/state.rs`, và phần wiring trong `app.rs`, với test-first cho từng thay đổi layout/render nhỏ để giữ an toàn.

**Tech Stack:** Rust, ratatui, crossterm, serde, cargo test, npm test

---

## File structure map

- `tui/src/transcript/layout.rs` — chia root shell thành transcript / status strip / composer / footer rail; nơi quyết định small-terminal compression.
- `tui/src/app.rs` — draw theo layout mới và tách trách nhiệm render giữa status strip, composer, footer rail.
- `tui/src/footer/render.rs` — render status strip và footer rail thành hai surface khác nhau, nhẹ hơn và đúng hierarchy hơn.
- `tui/src/footer/state.rs` — quyết định text/status rail và key hints theo mode.
- `tui/src/composer/mod.rs` — composer panel và popup overlay, gồm title, border, warning, popup attachment.
- `tui/src/transcript/render.rs` — transcript header/body/spacing/marker styling, giảm cảm giác “flattened log”.
- `tui/src/transcript/mod.rs` — giữ cho scroll math/content height khớp với transcript spacing mới.
- `tests/cli/repl.test.ts` — regression nếu `npm test` lộ ra behavior drift phía host/CLI.
- `tests/agent/loop.test.ts` và `tests/agent/specRegistry.test.ts` — regression suite hiện đã từng fail; giữ trong final verification.

---

### Task 1: Restructure root shell into four visual layers

**Files:**
- Modify: `tui/src/transcript/layout.rs`
- Modify: `tui/src/app.rs`
- Test: `tui/src/transcript/layout.rs`

- [ ] **Step 1: Write the failing layout tests for four-layer shell behavior**

```rust
#[test]
fn splits_root_into_transcript_status_composer_and_footer() {
    let layout = split_root(
        Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 24,
        },
        0,
    );

    assert_eq!(layout.status.height, 1);
    assert_eq!(layout.footer.height, 1);
    assert_eq!(layout.composer.height, 3);
    assert!(layout.transcript.height > layout.composer.height + layout.status.height + layout.footer.height);
}

#[test]
fn keeps_transcript_priority_on_short_terminal() {
    let layout = split_root(
        Rect {
            x: 0,
            y: 0,
            width: 80,
            height: 12,
        },
        0,
    );

    assert!(layout.transcript.height >= 7);
    assert_eq!(layout.status.height, 1);
    assert_eq!(layout.footer.height, 1);
}

#[test]
fn popup_growth_expands_bottom_pane_before_transcript_collapses_too_far() {
    let layout = split_root(
        Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 24,
        },
        5,
    );

    assert_eq!(layout.status.height, 1);
    assert_eq!(layout.footer.height, 1);
    assert!(layout.composer.height >= 4);
    assert!(layout.popup.height >= 5);
    assert!(layout.transcript.height >= 10);
}
```

- [ ] **Step 2: Run the layout tests to verify they fail**

Run: `cargo test --manifest-path tui/Cargo.toml transcript::layout::tests -- --nocapture`
Expected: FAIL because `TranscriptLayout` does not yet expose a separate `status` area and current split only returns transcript/footer/composer/popup.

- [ ] **Step 3: Implement the minimal root layout changes**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranscriptLayout {
    pub transcript: Rect,
    pub status: Rect,
    pub composer: Rect,
    pub footer: Rect,
    pub popup: Rect,
}

pub fn split_root(area: Rect, popup_height: u16) -> TranscriptLayout {
    let composer_height = if popup_height == 0 {
        3
    } else {
        4 + popup_height.min(6)
    };

    let vertical = Layout::vertical([
        Constraint::Min(5),
        Constraint::Length(1),
        Constraint::Length(composer_height),
        Constraint::Length(1),
    ])
    .split(area);

    let composer = vertical[2];
    let popup = Rect {
        x: composer.x,
        y: composer.y.saturating_sub(popup_height.min(composer.y)),
        width: composer.width,
        height: popup_height.min(composer.height.saturating_sub(1)).max(popup_height.min(7)),
    };

    TranscriptLayout {
        transcript: vertical[0],
        status: vertical[1],
        composer,
        footer: vertical[3],
        popup,
    }
}
```

```rust
terminal.draw(|frame| {
    let layout = transcript::layout::split_root(frame.area(), composer::popup_height(&self.composer));
    transcript::render::render(
        frame,
        layout.transcript,
        &self.transcript.entries,
        self.transcript.render_scroll(layout.transcript.height.saturating_sub(2)),
    );
    crate::footer::render::render_status_strip(frame, layout.status, &self.footer);
    composer::render(frame, layout.composer, &self.composer, &self.slash_catalog);
    crate::footer::render::render_footer_rail(frame, layout.footer, &self.footer);
})?;
```

- [ ] **Step 4: Run the layout tests again to verify they pass**

Run: `cargo test --manifest-path tui/Cargo.toml transcript::layout::tests -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tui/src/transcript/layout.rs tui/src/app.rs
git commit -m "refactor(tui): split shell into four visual layers"
```

### Task 2: Split footer rendering into status strip and contextual footer rail

**Files:**
- Modify: `tui/src/footer/render.rs`
- Modify: `tui/src/footer/state.rs`
- Test: `tui/src/footer/render.rs`
- Test: `tui/src/footer/state.rs`

- [ ] **Step 1: Write the failing tests for separate status strip and footer rail responsibilities**

```rust
#[test]
fn renders_status_strip_without_key_hints() {
    let backend = TestBackend::new(40, 1);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let state = FooterState {
        status_text: "Ready".into(),
        ..FooterState::default()
    };

    terminal
        .draw(|frame| render_status_strip(frame, frame.area(), &state))
        .expect("draw");

    let buffer = terminal.backend().buffer();
    let rendered = (0..40)
        .map(|x| buffer[(x, 0)].symbol())
        .collect::<String>();

    assert!(rendered.contains("Ready"));
    assert!(!rendered.contains("shortcuts"));
}

#[test]
fn renders_footer_rail_hints_without_status_text() {
    let backend = TestBackend::new(40, 1);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let state = FooterState::default();

    terminal
        .draw(|frame| render_footer_rail(frame, frame.area(), &state))
        .expect("draw");

    let buffer = terminal.backend().buffer();
    let rendered = (0..40)
        .map(|x| buffer[(x, 0)].symbol())
        .collect::<String>();

    assert!(rendered.contains("[?] shortcuts"));
    assert!(!rendered.contains("Ready"));
}

#[test]
fn busy_mode_prioritizes_observation_hints_over_editing_hints() {
    let state = FooterState {
        busy: true,
        ..FooterState::default()
    };

    assert_eq!(
        state.primary_hints(),
        vec!["↑↓ scroll", "PgDn bottom", "Ctrl+C quit"]
    );
}
```

- [ ] **Step 2: Run footer tests to verify they fail**

Run: `cargo test --manifest-path tui/Cargo.toml footer:: -- --nocapture`
Expected: FAIL because only a single `render()` function exists today and it mixes status text with hints.

- [ ] **Step 3: Implement separate renderers for status strip and footer rail**

```rust
pub fn render_status_strip(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let line = Line::from(vec![
        Span::styled(state.status_text.clone(), Style::default().fg(Color::Cyan)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

pub fn render_footer_rail(frame: &mut Frame<'_>, area: Rect, state: &FooterState) {
    let hints = join_key_hints(area.width as usize, &state.primary_hints());
    let line = Line::from(vec![
        Span::styled(hints, Style::default().fg(Color::DarkGray)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}
```

```rust
impl FooterState {
    pub fn primary_hints(&self) -> Vec<&'static str> {
        if self.transcript_scrolled {
            return vec!["↓ follow live", "PgDn bottom", "↑↓ scroll"];
        }

        if self.busy {
            return vec!["↑↓ scroll", "PgDn bottom", "Ctrl+C quit"];
        }

        match self.mode {
            ComposerMode::HistorySearch => vec!["Type query", "↑↓ choose", "Enter restore", "Esc cancel"],
            ComposerMode::Shell => vec!["Enter run shell", "Shift+Enter newline", "Esc clear"],
            ComposerMode::Slash | ComposerMode::FileCompletion if self.popup_open => {
                vec!["Tab accept", "↑↓ choose", "Enter send", "Esc close"]
            }
            _ if !self.draft_present => vec!["? shortcuts", "Enter send", "/ slash", "Ctrl+R history"],
            _ => vec!["Enter send", "Shift+Enter newline", "Ctrl+R history", "Esc clear"],
        }
    }
}
```

- [ ] **Step 4: Run footer tests again to verify they pass**

Run: `cargo test --manifest-path tui/Cargo.toml footer:: -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tui/src/footer/render.rs tui/src/footer/state.rs
git commit -m "refactor(tui): separate status strip from footer rail"
```

### Task 3: Lighten composer shell and attach popup as overlay

**Files:**
- Modify: `tui/src/composer/mod.rs`
- Modify: `tui/src/transcript/layout.rs`
- Test: `tui/src/composer/mod.rs`

- [ ] **Step 1: Write the failing composer tests for lighter shell and overlay attachment**

```rust
#[test]
fn renders_minimal_prompt_title_in_normal_mode() {
    let backend = TestBackend::new(40, 5);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let state = ComposerState::default();
    let catalog = Vec::<SlashCatalogEntry>::new();

    terminal
        .draw(|frame| render(frame, frame.area(), &state, &catalog))
        .expect("draw");

    let buffer = terminal.backend().buffer().clone();
    let rendered = (0..5)
        .map(|y| (0..40).map(|x| buffer[(x, y)].symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");

    assert!(rendered.contains("Prompt"));
    assert!(!rendered.contains("Prompt • normal"));
}

#[test]
fn popup_renders_above_composer_with_contextual_title() {
    let backend = TestBackend::new(40, 8);
    let mut terminal = Terminal::new(backend).expect("terminal");
    let mut state = ComposerState::default();
    let catalog = vec![SlashCatalogEntry {
        name: "/status".into(),
        description: "Show status".into(),
        usage: Some("/status".into()),
        kind: SlashCatalogKind::Direct,
    }];
    state.textarea.set_text("/st".into());
    state.refresh_modes(&catalog, std::path::Path::new("."));

    terminal
        .draw(|frame| render(frame, frame.area(), &state, &catalog))
        .expect("draw");

    let buffer = terminal.backend().buffer().clone();
    let rendered = (0..8)
        .map(|y| (0..40).map(|x| buffer[(x, y)].symbol()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");

    assert!(rendered.contains("Commands"));
    assert!(rendered.contains("Prompt • slash"));
}
```

- [ ] **Step 2: Run composer tests to verify they fail**

Run: `cargo test --manifest-path tui/Cargo.toml composer::tests -- --nocapture`
Expected: FAIL if the title/border/popup placement still reflects the older heavier panel behavior.

- [ ] **Step 3: Implement the lighter composer shell and popup overlay treatment**

```rust
let title = match state.mode {
    ComposerMode::Shell => "Prompt • shell",
    ComposerMode::Slash => "Prompt • slash",
    ComposerMode::FileCompletion => "Prompt • file",
    ComposerMode::HistorySearch => "Prompt • history",
    ComposerMode::Normal => "Prompt",
};

let paragraph = Paragraph::new(state.textarea.text.as_str())
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(title),
    )
    .wrap(Wrap { trim: false });
```

```rust
let popup_area = Rect {
    x: area.x,
    y: area.y.saturating_sub(height.min(area.y)),
    width: area.width,
    height,
};
frame.render_widget(Clear, popup_area);
render_popup(frame, popup_area, state, catalog);
```

```rust
let list = List::new(items)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray))
            .title(popup_title),
    )
    .highlight_style(Style::default().bg(Color::Blue).fg(Color::Black))
    .highlight_symbol("> ");
```

- [ ] **Step 4: Run composer tests again to verify they pass**

Run: `cargo test --manifest-path tui/Cargo.toml composer::tests -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tui/src/composer/mod.rs tui/src/transcript/layout.rs
git commit -m "style(tui): lighten composer shell and popup overlay"
```

### Task 4: Refine transcript hierarchy into conversation/work-log rhythm

**Files:**
- Modify: `tui/src/transcript/render.rs`
- Modify: `tui/src/transcript/mod.rs`
- Test: `tui/src/transcript/render.rs`
- Test: `tui/src/transcript/mod.rs`

- [ ] **Step 1: Write the failing transcript tests for hierarchy, markers, and spacing rhythm**

```rust
#[test]
fn tool_entries_keep_tighter_spacing_than_primary_conversation_entries() {
    let lines = render_entry_lines(&TranscriptEntry {
        id: "tool-1".into(),
        kind: TranscriptCellKind::Tool,
        title: Some("git status · completed".into()),
        text: "On branch main".into(),
        tool_name: Some("shell".into()),
        is_error: false,
        streaming: false,
        turn_id: None,
        tool_call_id: None,
    });

    assert_eq!(lines[0].to_string(), "● Tool git status · completed");
    assert_eq!(lines[1].to_string(), "  On branch main");
    assert_eq!(lines.last().unwrap().to_string(), "");
}

#[test]
fn status_rows_render_as_lightweight_system_lines() {
    let lines = render_entry_lines(&TranscriptEntry {
        id: "status-1".into(),
        kind: TranscriptCellKind::Status,
        title: Some("Status".into()),
        text: "Indexing workspace".into(),
        tool_name: None,
        is_error: false,
        streaming: false,
        turn_id: None,
        tool_call_id: None,
    });

    assert_eq!(lines[0].to_string(), "∙ Status");
    assert_eq!(lines[1].to_string(), "Indexing workspace");
}

#[test]
fn content_height_matches_entry_spacing_rules() {
    let mut transcript = TranscriptState::default();
    transcript.apply(&HostEvent::TranscriptAppend {
        cells: vec![
            TranscriptCell {
                id: "user-1".into(),
                kind: TranscriptCellKind::User,
                text: "ship it".into(),
                title: Some("User".into()),
                tool_name: None,
                is_error: None,
            },
            TranscriptCell {
                id: "tool-1".into(),
                kind: TranscriptCellKind::Tool,
                text: "cargo test".into(),
                title: Some("shell · running".into()),
                tool_name: Some("shell".into()),
                is_error: None,
            },
        ],
    });

    assert!(transcript.content_height() >= 5);
}
```

- [ ] **Step 2: Run transcript tests to verify they fail**

Run: `cargo test --manifest-path tui/Cargo.toml transcript:: -- --nocapture`
Expected: FAIL where current spacing/content-height math does not yet reflect the intended primary-vs-secondary rhythm.

- [ ] **Step 3: Implement transcript spacing and hierarchy refinements**

```rust
fn render_entry_lines(entry: &TranscriptEntry) -> Vec<Line<'static>> {
    let label = label_for_entry(entry);
    let detail = detail_for_entry(entry);
    let mut lines = Vec::new();

    if uses_primary_spacing(entry) {
        lines.push(Line::default());
    }

    lines.push(header_line(&label, detail.as_deref(), entry));

    if entry.text.is_empty() {
        lines.push(Line::default());
    } else {
        let indent_body = should_indent_body(entry);
        for line in body_lines(&entry.text) {
            let rendered = if indent_body && !line.is_empty() {
                format!("  {line}")
            } else {
                line.to_string()
            };
            lines.push(Line::from(rendered));
        }
    }

    if needs_trailing_spacing(entry) {
        lines.push(Line::default());
    }

    lines
}

fn uses_primary_spacing(entry: &TranscriptEntry) -> bool {
    matches!(
        entry.kind,
        crate::protocol::TranscriptCellKind::User | crate::protocol::TranscriptCellKind::Assistant
    )
}

fn needs_trailing_spacing(entry: &TranscriptEntry) -> bool {
    !matches!(
        entry.kind,
        crate::protocol::TranscriptCellKind::Status | crate::protocol::TranscriptCellKind::Summary
    )
}
```

```rust
fn content_height(&self) -> u16 {
    self.entries
        .iter()
        .map(|entry| render::render_entry_lines(entry).len() as u16)
        .sum()
}
```

- [ ] **Step 4: Run transcript tests again to verify they pass**

Run: `cargo test --manifest-path tui/Cargo.toml transcript:: -- --nocapture`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tui/src/transcript/render.rs tui/src/transcript/mod.rs
git commit -m "style(tui): refine transcript hierarchy and spacing"
```

### Task 5: Polish small-terminal behavior and full regression verification

**Files:**
- Modify: `tui/src/transcript/layout.rs`
- Modify: `tui/src/app.rs`
- Test: `tui/src/transcript/layout.rs`
- Test: `tests/cli/repl.test.ts`
- Test: `tests/agent/loop.test.ts`
- Test: `tests/agent/specRegistry.test.ts`

- [ ] **Step 1: Write the failing small-terminal regression test**

```rust
#[test]
fn short_terminal_compresses_bottom_layers_before_transcript() {
    let layout = split_root(
        Rect {
            x: 0,
            y: 0,
            width: 70,
            height: 10,
        },
        0,
    );

    assert!(layout.transcript.height >= 6);
    assert_eq!(layout.status.height, 1);
    assert_eq!(layout.footer.height, 1);
    assert!(layout.composer.height <= 2 || layout.composer.height == 3);
}
```

- [ ] **Step 2: Run the focused Rust layout test to verify it fails**

Run: `cargo test --manifest-path tui/Cargo.toml transcript::layout::tests::short_terminal_compresses_bottom_layers_before_transcript -- --nocapture`
Expected: FAIL if current split still over-allocates bottom space on 10-row terminals.

- [ ] **Step 3: Implement the small-terminal compression rule**

```rust
pub fn split_root(area: Rect, popup_height: u16) -> TranscriptLayout {
    let compact = area.height <= 10;
    let composer_height = if popup_height == 0 {
        if compact { 2 } else { 3 }
    } else {
        let base = if compact { 3 } else { 4 };
        base + popup_height.min(if compact { 4 } else { 6 })
    };

    // keep status/footer at 1 row each, let transcript own the rest
    // ... rest of split_root
}
```

- [ ] **Step 4: Run Rust TUI build and test suites**

Run: `cargo build --manifest-path tui/Cargo.toml && cargo test --manifest-path tui/Cargo.toml`
Expected: PASS

- [ ] **Step 5: Run CLI/agent regression suites**

Run: `npm test -- tests/cli/repl.test.ts tests/agent/loop.test.ts tests/agent/specRegistry.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full project test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Manual visual verification in a real terminal**

Run:

```bash
npm run build:tui
npm run dev
```

Check all of the following manually:
- default shell with empty draft
- transcript with assistant output and tool activity
- slash popup open
- history search mode
- shell command entry mode
- scrolled transcript state
- busy state with live activity
- narrow/short terminal behavior

Expected:
- transcript is visually dominant
- status strip, composer, and footer rail read as separate layers
- popup feels attached to composer, not a heavy permanent pane
- transcript markers and spacing improve scan quality
- short terminals still preserve readable transcript height

- [ ] **Step 8: Commit**

```bash
git add tui/src/transcript/layout.rs tui/src/app.rs tests/cli/repl.test.ts tests/agent/loop.test.ts tests/agent/specRegistry.test.ts
git commit -m "test(tui): verify codex-like shell polish across layouts"
```

---

## Spec coverage check

- Shell structure: Task 1 + Task 5 cover root split, transcript dominance, popup growth, and small-terminal compression.
- Transcript lane: Task 4 covers markers, body indent, hierarchy, and spacing rhythm.
- Bottom pane: Task 2 + Task 3 cover status strip, footer rail, composer shell, and popup overlay.
- Behavior boundary for this pass: all tasks stay Rust-side and avoid protocol/controller redesign.
- Verification plan: Task 5 includes Rust build/tests, npm tests, and manual real-terminal verification.

## Placeholder scan

- No `TODO` / `TBD` placeholders remain.
- Every task includes explicit files, commands, and expected outcomes.
- Code steps include concrete snippets to implement or adapt.

## Type consistency check

- `TranscriptLayout` in this plan consistently includes `transcript`, `status`, `composer`, `footer`, and `popup`.
- Footer rendering consistently uses `render_status_strip` and `render_footer_rail`.
- Transcript spacing changes reference `render_entry_lines()` and `content_height()` consistently.
