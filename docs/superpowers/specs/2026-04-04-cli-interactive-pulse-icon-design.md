# CLI interactive pulse icon design

## Summary
Add a real animation for the interactive telemetry activity icon so the `⚡` glyph cycles through `gray → yellow → white → yellow` while a tool call is running. Keep compact mode unchanged and preserve existing completion rendering.

## Goals
- Animate only the interactive activity icon.
- Update the existing activity line in place instead of writing new lines.
- Stop animation immediately when the tool call completes.
- Preserve current fallback behavior when in-place replacement is unavailable.

## Non-goals
- No changes to compact mode.
- No changes to tool labels or completion status text.
- No global animation system for unrelated terminal output.

## Current state
In [src/telemetry/display.ts](src/telemetry/display.ts), `formatToolActivityLine()` renders a single cyan `⚡` for interactive mode. The observer already tracks tool activity labels by `toolCallId` and can replace lines on completion when `replaceActivityLine` is available.

## Proposed approach
### Animation frames
Define a small ordered frame list for the icon colors:
- gray `⚡`
- yellow `⚡`
- white `⚡`
- yellow `⚡`

The label text remains unchanged across frames.

### Per-tool animation state
Store animation state per active `toolCallId` inside the compact CLI telemetry observer. Each entry should contain:
- the current frame index
- the timer handle used to advance frames
- the activity label needed to redraw the line

This keeps concurrent tool calls isolated and allows each active line to animate independently.

### Start behavior
On `tool_call_started`:
1. Compute the activity label as today.
2. Render the first interactive line immediately.
3. If mode is `interactive` and `replaceActivityLine` exists, start a timer for that `toolCallId`.
4. On each tick, advance the frame index and redraw the same activity line via `replaceActivityLine(toolCallId, ...)`.

If `replaceActivityLine` is not provided, keep the current static rendering and do not start animation.

### Completion behavior
On `tool_call_completed`:
1. Stop and clear any running timer for that `toolCallId`.
2. Remove the stored animation state.
3. Render the completion line using the existing logic.

This guarantees animation does not continue after completion and avoids leaking timers.

### Clear behavior on turn end
When the observer handles `turn_completed` or `turn_stopped`, stop all active animation timers before clearing state. This ensures there is no orphaned redraw loop if the turn ends unexpectedly.

## Data flow
- `tool_call_started` creates or reuses the activity label.
- Interactive mode optionally attaches a redraw timer keyed by `toolCallId`.
- Each timer tick recomputes only the colored icon portion and replaces the existing line.
- `tool_call_completed` or turn-finalization tears down the timer and removes associated state.

## Error handling
- If animation cannot run because `replaceActivityLine` is absent, gracefully fall back to the existing static icon.
- Timer cleanup must be idempotent so repeated completion or turn-finalization paths are safe.

## Testing
### Manual verification
- Run the CLI in interactive mode.
- Trigger a tool call that lasts long enough to observe multiple frame changes.
- Confirm the `⚡` cycles through `gray → yellow → white → yellow` on a single line.
- Confirm the animation stops immediately when the tool finishes.
- Confirm compact mode output is unchanged.

### Automated verification
Add or update focused tests around [src/telemetry/display.ts](src/telemetry/display.ts) to cover:
- no animation setup in compact mode
- no animation setup when `replaceActivityLine` is unavailable
- animation timer setup and cleanup in interactive mode
- completion and turn-end cleanup paths

## Open decisions resolved
- Use per-tool timers instead of a single global timer.
- Animate only interactive mode.
- Use the exact frame order `gray → yellow → white → yellow` supplied by the user.
