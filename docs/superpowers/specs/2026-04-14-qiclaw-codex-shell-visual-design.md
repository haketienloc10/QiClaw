# QiClaw Codex Shell Visual Design

Date: 2026-04-14
Status: Draft approved in terminal, written for review

## Goal

Make the Rust TUI in QiClaw feel as close as possible to Codex visually, with the primary focus on overall shell parity first. This pass should maximize visual similarity through layout, spacing, hierarchy, and rendering treatment while preserving the current host↔TUI event model as much as possible.

## Success Criteria

- The screen reads transcript-first rather than composer-first.
- The bottom pane is clearly split into status strip, composer, and contextual footer.
- The transcript feels like a conversation + work log rather than a flattened debug log.
- On small terminals, transcript height is prioritized over bottom-pane comfort.
- The implementation stays mostly Rust-side and does not require protocol or controller redesign in this pass.

## Non-Goals

This pass does not include:

- host/protocol schema changes
- deep regrouping of transcript semantics on the TypeScript side
- major rework of auto-follow behavior
- live activity lifecycle redesign
- broad slash/history behavior redesign
- protocol-level transcript grouping or collapsible transcript sections

Those are intentionally deferred to a later behavior parity pass.

## Design Direction

Use a shell-first, density-second approach:

1. Redesign the visual shell so the entire screen reads like Codex.
2. Align transcript lane rendering to that shell through spacing, markers, and hierarchy.
3. Refine the bottom pane to match the shell.
4. Only after this pass, evaluate which remaining gaps are truly behavioral rather than visual.

This is preferred over transcript-first or big-bang redesign because the user explicitly prioritized overall shell parity above all else, and because shell changes provide the strongest visual payoff without immediately forcing model/protocol changes.

## Section 1 — Shell Structure

### Root split

The root shell should be structured so the transcript is visually dominant and the bottom controls are layered instead of collapsed into one dense block.

From top to bottom, the screen should read as:

1. transcript
2. status strip
3. composer
4. contextual footer rail

This ordering keeps “what is happening” above “where I type” and keeps “what can I do now” as the final lightweight interaction rail.

### Layout rules

- Transcript always gets the largest share of vertical space.
- When popup is closed, composer stays as compact as possible.
- When popup opens, the bottom pane may expand, but only enough to support popup readability.
- On short terminals, bottom-pane layers compress before transcript does.
- Popup should feel visually attached to the composer zone rather than like a separate permanent pane.

### Expected implementation shape

This should mostly be implemented by adjusting the root layout split and the heights allocated to popup/composer/footer rows in the Rust TUI.

Primary files:

- `tui/src/transcript/layout.rs`
- `tui/src/app.rs`
- `tui/src/footer/render.rs`
- `tui/src/composer/mod.rs`

## Section 2 — Transcript Lane

### Core visual intent

The transcript should look like a stack of lightweight work items rather than a single flattened paragraph dump.

Entries remain text-first and terminal-native. The design should not introduce heavy cards or box-per-entry rendering. Instead, the transcript should feel more structured through typography, spacing rhythm, and header treatment.

### Hierarchy rules

- Each entry gets a clear header marker and label.
- Detail/status information remains in the header, but lighter than the body.
- `User`, `Assistant`, and `Tool` bodies keep a slight left indent.
- `Status` and other system-ish rows stay visually lighter and less block-like.
- Spacing varies by importance rather than using one rigid rhythm for every entry.

### Header marker treatment

Use distinct markers to make scan patterns clearer:

- User → input cue style
- Assistant → response/work style
- Tool → strongest activity marker
- Status/Summary → light system marker

Markers should improve scannability without turning the transcript into an icon-heavy UI.

### Spacing intent

- User/Assistant entries use primary spacing.
- Tool entries sit a little tighter to nearby context so they read as activity lane content.
- Status/system rows use minimal spacing.
- Context switches should be easier to scan than repeated same-kind rows.

### Constraints

This pass should stay within current transcript entry data. Do not require new protocol fields just to get more visual structure.

Primary files:

- `tui/src/transcript/render.rs`
- `tui/src/transcript/cell.rs`
- `tui/src/transcript/mod.rs`

## Section 3 — Bottom Pane

### Composer

The composer should read as a lightweight input surface, not a heavy box.

Design rules:

- title stays short and low-noise
- border treatment is lighter than before
- default height is minimal
- multiline remains supported but should not make the bottom pane feel oversized too quickly
- inline warnings (such as unsupported editor mode) should remain visible but visually secondary

### Status strip

The status strip is a single thin row above the composer.

Its job is only to answer “what is happening now?” Examples include:

- model information
- busy state
- session restored/new session
- scrolled state

It must not also act as a shortcut rail.

### Contextual footer rail

The footer becomes a separate interaction rail with one purpose: “what can I do now?”

Rules:

- key hints are visually grouped like a rail, not mixed into status text
- hint priority depends on current mode
- on narrow terminals, hints reduce before transcript height is sacrificed
- footer should feel supporting, not primary

### Popup

The popup should feel like a lightweight overlay that grows out of the composer area.

Rules:

- contextual title (`Commands`, `Paths`, `History`)
- lighter border/highlight treatment than a traditional panel
- clear selection state
- constrained height on small terminals
- visually attached to composer rather than treated as an independent pane

Primary files:

- `tui/src/composer/mod.rs`
- `tui/src/footer/render.rs`
- `tui/src/footer/state.rs`
- `tui/src/transcript/layout.rs`

## Section 4 — Behavior Boundary For This Pass

This pass may change behavior only when that behavior directly serves the visual shell.

Allowed:

- composer compact/expanded sizing tied to popup and multiline state
- layout compression rules for small terminals
- transcript entry spacing/placement changes
- status/footer responsibility split
- popup placement adjustments to preserve overlay feel

Deferred:

- protocol changes between host and TUI
- regrouping transcript semantics at the host level
- deeper auto-follow redesign
- richer live activity lifecycle transitions
- slash/history behavior overhauls
- event-model changes just to achieve grouping

## Verification Plan

### Automated

- `cargo build --manifest-path tui/Cargo.toml`
- `cargo test --manifest-path tui/Cargo.toml`
- `npm test`

### Manual visual verification

Run the TUI in a real terminal and inspect:

1. default shell with empty draft
2. transcript with assistant output and tool activity
3. popup open for slash commands
4. history search mode
5. shell command entry mode
6. short terminal / narrow terminal behavior
7. scrolled transcript state
8. busy state with live assistant/tool activity

Manual acceptance checks:

- transcript remains the dominant visual region
- bottom pane layers are visually distinct
- popup reads as overlay, not heavy permanent box
- transcript markers and spacing improve scan quality
- small terminals still prioritize readable transcript area

## Risks

### Risk: over-tightening the shell

Making the bottom pane too compact could harm multiline readability or popup usability.

Mitigation: keep compact/default and expanded/popup states explicit in layout tests.

### Risk: transcript becomes over-designed

Adding too much chrome could make the terminal feel less native.

Mitigation: stay text-first, no card-heavy rendering, use spacing and markers rather than decorative blocks.

### Risk: visual improvements accidentally drag in behavior redesign

Once shell and transcript improve, it will be tempting to chase Codex parity through model changes.

Mitigation: keep this pass Rust-side and visual-first; defer controller/protocol changes to a separate follow-up pass.

## Implementation Readiness

This design is intentionally scoped so it can be executed as one focused implementation plan in the Rust TUI without requiring a host-side redesign.

The next step after spec approval should be a writing-plans pass that breaks the work into small testable tasks, likely in this order:

1. shell/layout restructuring
2. transcript hierarchy refinement
3. bottom pane visual refactor
4. regression verification and small-terminal polish
