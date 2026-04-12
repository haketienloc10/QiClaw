# CLI tool activity restore design

## Summary
Khôi phục interactive CLI tool activity về hành vi trước regression: hiển thị lại dòng tool đang chạy với icon nhấp nháy, giữ completion line ở dưới, bổ sung thời lượng chạy `(Nms)`, và tránh render trùng giữa telemetry observer với turn-event path. Không thay đổi debug log, telemetry payload, hay mục đích của các observer hiện tại.

## Goals
- Khôi phục interactive tool activity line trong CLI.
- Giữ blinking icon hiện có từ telemetry display.
- Sau khi tool hoàn tất, hiển thị `Success/Fail (Nms)` ở dòng dưới tool activity.
- Tránh duplicate render giữa telemetry path và `handleCliTurnEvent(...)`.
- Không thay đổi debug log output hoặc schema telemetry.

## Non-goals
- Không đổi tool label format hiện tại.
- Không đổi compact footer semantics.
- Không refactor rộng CLI writer hay telemetry pipeline.
- Không thay đổi provider/tool event emission.

## Current state
- [src/cli/main.ts](src/cli/main.ts) đang có hai đường render tool activity:
  1. `handleCliTurnEvent(...)` render từ `TurnEvent`.
  2. `createCompactCliTelemetryObserver(...)` render từ telemetry.
- Animation blinking nằm ở [src/telemetry/display.ts](src/telemetry/display.ts), nhưng telemetry render bị chặn bởi `suppressTelemetryToolActivity` trong CLI observer wiring.
- Kết quả là interactive CLI mất dòng tool activity/blinking như trước; phần turn-event path chỉ còn render completion/preview trong một số luồng.

## Decision
Chọn telemetry observer là nguồn render duy nhất cho tool activity UI. `handleCliTurnEvent(...)` sẽ chỉ tiếp tục xử lý assistant text stream, assistant message completion, và turn failure.

## Proposed changes

### 1. Re-enable telemetry tool activity rendering
Trong [src/cli/main.ts](src/cli/main.ts):
- bỏ việc suppress telemetry tool activity cho CLI runtime thông thường.
- giữ nguyên observer chain và debug logger.

Kết quả:
- `createCompactCliTelemetryObserver(...)` tiếp tục render start/completion của tool như trước.
- blinking icon ở interactive mode hoạt động lại mà không cần đổi logic animation.

### 2. Eliminate duplicate tool rendering from turn events
Trong `handleCliTurnEvent(...)` ở [src/cli/main.ts](src/cli/main.ts):
- giữ:
  - `assistant_text_delta`
  - `assistant_message_completed`
  - `turn_failed`
- bỏ render cho:
  - `tool_call_started`
  - `tool_call_completed`

Kết quả:
- live tool UI chỉ đi qua telemetry path.
- turn-event path vẫn tiếp tục xử lý assistant streaming như hiện tại.
- tránh xung đột giữa line blinking từ telemetry và line tĩnh từ turn events.

### 3. Keep interactive completion below the tool line and add duration
Trong [src/telemetry/display.ts](src/telemetry/display.ts):
- giữ interactive completion là dòng riêng bên dưới tool activity line.
- format completion line ở interactive mode là:
  - success: ` └─ ✔ Success (Nms)`
  - fail: ` └─ ✖ Fail (Nms)`
- compact mode tiếp tục dùng compact summary line hiện có.

### 4. Preserve debug logging behavior
Không thay đổi:
- telemetry event names
- telemetry payload content
- logger wiring
- file output format của debug log

Mọi thay đổi chỉ nằm ở phần render ra terminal.

## Expected interactive transcript
```text
QiClaw
✓ Responding
 ✦ file read src/cli/main.ts
 └─ ✔ Success (12ms)
  Read 120 lines
```

Trong khi tool đang chạy, glyph tiếp tục pulse như hiện tại (`✦`, `✧`, `✱`, ...). Khi tool xong, animation dừng lại, dòng tool activity được giữ nguyên, và completion line xuất hiện ngay bên dưới.

## Error handling
- Nếu tool lỗi, completion line dùng `✖ Fail (Nms)`.
- `turn_failed` vẫn tiếp tục render footer lỗi như hiện tại từ `handleCliTurnEvent(...)`.
- Nếu `replaceActivityLine` không khả dụng, fallback behavior trong telemetry display vẫn giữ nguyên.

## Files to modify
- `src/cli/main.ts`
  - bỏ suppress render telemetry tool activity trong luồng cần khôi phục
  - ngừng render tool start/completion trong `handleCliTurnEvent(...)`
- `src/telemetry/display.ts`
  - đảm bảo interactive completion line có duration `(Nms)`
- `tests/cli/repl.test.ts`
  - cập nhật/đổi expectation cho interactive transcript để khẳng định tool activity quay lại và không bị duplicate
- `tests/telemetry/display.test.ts`
  - khẳng định interactive completion line gồm duration và giữ nguyên compact behavior

## Testing
### Automated
- `tests/telemetry/display.test.ts`
  - interactive animation vẫn hoạt động
  - interactive completion append line có duration
  - compact completion behavior không đổi
- `tests/cli/repl.test.ts`
  - interactive CLI transcript có tool activity line trở lại
  - không duplicate tool line giữa telemetry và turn-event path
  - failure transcript vẫn chỉ render lỗi một lần

### Manual
- chạy CLI interactive với một tool call đủ lâu để thấy icon pulse
- xác nhận tool activity hiển thị lại
- xác nhận sau khi hoàn tất có `Success/Fail (Nms)`
- xác nhận debug log không thay đổi

## Resolved decisions
- Nguồn render duy nhất cho tool activity: telemetry observer.
- Turn-event path không còn render tool call UI.
- Debug log giữ nguyên hoàn toàn.
- Interactive completion line hiển thị thêm thời lượng chạy.