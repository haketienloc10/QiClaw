# CLI interactive pulse completion design

## Summary
Adjust interactive tool activity completion so the animated glyph line remains visible when a tool finishes, and render the success line underneath it instead of replacing the tool activity line. At the same time, speed up the interactive glyph pulse interval from 1000ms to 80ms. Keep compact mode unchanged.

## Goals
- Preserve the interactive tool activity line after tool completion.
- Render the interactive completion line as a separate line below the tool activity line.
- Speed up the interactive glyph animation to 80ms per frame.
- Keep existing fallback and turn-end cleanup behavior.

## Non-goals
- No changes to compact mode completion behavior.
- No changes to tool labels or footer formatting.
- No changes to interactive `QiClaw` chrome or layout.
- No changes to the selected glyph sequence itself.

## Current state
In [src/telemetry/display.ts](src/telemetry/display.ts), interactive completion currently uses `replaceActivityLine(...)` in the same way as compact mode. This causes the tool activity line to be overwritten by the success line. The interactive pulse interval is currently 1000ms, which is slower than the desired animated effect.

## Proposed approach
### Completion behavior
On `tool_call_completed` in interactive mode:
1. Stop the animation timer for that `toolCallId`.
2. Remove the tracked activity label.
3. Keep the tool activity line already rendered on screen.
4. Render the completion line through `writeActivityLine(...)` so it appears as a separate line underneath.

On `tool_call_completed` in compact mode:
- Preserve the existing `replaceActivityLine(...)` behavior.

### Pulse timing
Change `interactiveToolPulseIntervalMs` from `1000` to `80`.

This keeps the current redraw mechanism and frame loop intact while making the glyph animation visibly faster.

### Cleanup behavior
Preserve the current cleanup behavior for:
- no animation when `replaceActivityLine` is unavailable
- stopping animation on `turn_completed`
- stopping animation on `turn_stopped`

## Data flow
- `tool_call_started` still writes the first interactive activity line and starts the timer if line replacement is available.
- Each timer tick still redraws the same activity line with the next glyph frame.
- `tool_call_completed` in interactive mode stops the timer, leaves the tool activity line in place, and appends the success line separately.
- `tool_call_completed` in compact mode still replaces the activity line with the completion summary.

## Error handling
- If `replaceActivityLine` is unavailable, the interactive activity line remains static as before.
- Timer cleanup remains idempotent so repeated completion or turn-finalization paths stay safe.

## Testing
### Manual verification
- Run the CLI in interactive mode.
- Trigger a tool call that lasts long enough to observe multiple glyph changes.
- Confirm the glyph animation is visibly faster at 80ms.
- Confirm that when the tool completes, the tool activity line remains visible and the success line appears below it.
- Confirm compact mode still replaces the line as before.

### Automated verification
Update focused tests around [tests/telemetry/display.test.ts](tests/telemetry/display.test.ts) to cover:
- interactive completion preserves the original tool activity line and appends success separately
- fast pulse redraws using the 80ms interval
- fallback path when `replaceActivityLine` is unavailable
- cleanup on `turn_completed` and `turn_stopped`
- compact mode behavior remains unchanged through existing tests

## Open decisions resolved
- Interactive completion should append, not replace.
- Pulse interval should be 80ms.
- Glyph sequence remains unchanged: `✦ → ✧ → ✱ → ✲ → ✳ → ✴`.
