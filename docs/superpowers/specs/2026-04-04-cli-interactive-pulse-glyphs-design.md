# CLI interactive pulse glyphs design

## Summary
Replace the interactive telemetry activity animation from a single color-shifting `⚡` into a sequence of colored glyphs. While a tool call is running in interactive mode, the icon should cycle through `✦ → ✧ → ✱ → ✲ → ✳ → ✴`, with each glyph rendered in its own color. Keep compact mode unchanged and preserve the existing timer, redraw, and cleanup behavior.

## Goals
- Animate only the interactive activity icon.
- Replace the current single-glyph color pulse with a multi-glyph colored sequence.
- Preserve same-line redraw behavior through `replaceActivityLine`.
- Preserve completion and turn-end cleanup behavior.

## Non-goals
- No changes to compact mode.
- No changes to tool labels or completion status text.
- No changes to interactive `QiClaw` chrome or layout.
- No changes to animation timing.

## Current state
In [src/telemetry/display.ts](src/telemetry/display.ts), `interactiveToolPulseFrames` is currently a four-frame sequence built from the same `⚡` glyph with different colors. The observer already supports timer-based redraw, per-tool animation state, completion cleanup, and turn cleanup.

## Proposed approach
### Animation frames
Replace the current pulse frame array with this ordered sequence:
- `pc.cyan('✦')`
- `pc.blue('✧')`
- `pc.magenta('✱')`
- `pc.yellow('✲')`
- `pc.green('✳')`
- `pc.white('✴')`

The label text remains unchanged across frames.

### State and timing
Keep the existing per-tool animation state as-is:
- current frame index
- timer handle
- activity label

Keep the current timer interval unchanged. Only the frame contents and frame count should change.

### Start behavior
On `tool_call_started`:
1. Render the first interactive activity line immediately.
2. If `replaceActivityLine` exists, keep using the existing timer-based redraw loop.
3. Advance through the six glyph frames in order and loop back to the start.

### Completion behavior
On `tool_call_completed`:
1. Stop the timer for that `toolCallId`.
2. Remove animation state.
3. Preserve the existing completion rendering path exactly as it works now.

### Turn-finalization behavior
On `turn_completed` or `turn_stopped`, preserve the current cleanup behavior that stops all active animation timers before clearing tracked tool state.

## Data flow
- `tool_call_started` writes the first interactive line.
- The timer advances `frameIndex` across the new six-frame glyph array.
- Each tick redraws the same tool line using the new glyph for that frame.
- Completion and turn-finalization continue to stop timers and clear animation state.

## Error handling
- If `replaceActivityLine` is unavailable, continue to fall back to the existing static interactive line.
- Timer cleanup remains idempotent.

## Testing
### Manual verification
- Run the CLI in interactive mode.
- Trigger a tool call that lasts long enough to observe multiple redraws.
- Confirm the icon cycles through `✦ → ✧ → ✱ → ✲ → ✳ → ✴` on a single line.
- Confirm the animation stops when the tool completes.
- Confirm compact mode remains unchanged.

### Automated verification
Update focused tests around [tests/telemetry/display.test.ts](tests/telemetry/display.test.ts) only where they assert the exact interactive activity glyph. Preserve coverage for:
- no animation setup when `replaceActivityLine` is unavailable
- redraw while tool is running
- completion cleanup
- turn-end cleanup

## Open decisions resolved
- Replace the old `⚡`-based pulse frames entirely.
- Use colored glyphs rather than monochrome glyphs.
- Keep existing timing and lifecycle behavior unchanged.
