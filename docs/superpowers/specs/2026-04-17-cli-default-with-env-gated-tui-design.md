# CLI default with env-gated TUI design

## Goal

Đổi hành vi mặc định của QiClaw sang CLI text mode. TUI chỉ được bật khi cấu hình trong `.env` hoặc `.env.local` có `QICLAW_TUI_ENABLED=true`.

## Scope

- Đổi điều kiện chọn interactive/TUI mode trong CLI bootstrap.
- Bỏ cờ dòng lệnh `--plain` khỏi CLI parser.
- Giữ cơ chế tự load `.env` rồi `.env.local`.
- Giữ fallback sang CLI nếu TUI không khởi động được.
- Bổ sung và cập nhật test cho hành vi mới.

## Out of scope

- Thêm cờ mới như `--tui` hoặc `--cli`.
- Hỗ trợ các giá trị truthy khác như `1`, `yes`, `TRUE`.
- Đổi logic tìm binary TUI hoặc giao thức bridge.
- Đổi semantics của prompt mode `--prompt`.

## Chosen approach

Dùng một biến env mới: `QICLAW_TUI_ENABLED`.

Quy tắc chọn mode sau khi đã load `.env` và `.env.local`:

- Nếu có `--prompt`, tiếp tục chạy `compact` như hiện tại.
- Nếu stdout không phải TTY, chạy `plain`.
- Nếu stdout là TTY và `QICLAW_TUI_ENABLED === 'true'`, chạy `interactive` và thử khởi động TUI.
- Trong mọi trường hợp còn lại, chạy `plain`.

Nếu TUI launch thất bại, CLI in thông báo fallback hiện có và tiếp tục chạy `plain` mode.

## Why this approach

- Đáp ứng đúng yêu cầu: mặc định là CLI, TUI chỉ bật bằng config env.
- Giữ thay đổi nhỏ, tập trung ở bootstrap logic trong [src/cli/main.ts](src/cli/main.ts).
- Tận dụng cơ chế env autoload và fallback hiện có, tránh mở rộng bề mặt thay đổi không cần thiết.
- Làm semantics rõ ràng: chỉ đúng chuỗi `true` mới bật TUI, tránh mơ hồ cấu hình.

## Design details

### 1. Env-gated mode selection

Ở [src/cli/main.ts:205-208](src/cli/main.ts#L205-L208), thay logic chọn `displayMode` hiện tại.

Thiết kế mới:

- Tách điều kiện `tuiEnabled = stdout.isTTY && process.env.QICLAW_TUI_ENABLED === 'true'`.
- `displayMode` sẽ là:
  - `compact` khi có `parsed.prompt`
  - `interactive` khi `tuiEnabled`
  - `plain` cho các trường hợp còn lại

Thiết kế này loại bỏ mặc định “TTY thì interactive”, vốn là nguyên nhân khiến QiClaw luôn ưu tiên TUI.

### 2. Remove --plain from CLI args

Ở [src/cli/main.ts:1278-1421](src/cli/main.ts#L1278-L1421):

- Xóa field `plain` khỏi kiểu trả về của `parseArgs`.
- Xóa biến local `plain`.
- Xóa nhánh parse `--plain`.
- Xóa giá trị `plain` khỏi object return.

Không cần thay thế bằng cờ mới vì quyết định mode đã được chuyển hoàn toàn sang env config.

### 3. Keep env file precedence unchanged

Giữ nguyên `loadCliEnvFiles()` ở [src/cli/main.ts:1433-1462](src/cli/main.ts#L1433-L1462):

- `.env` được load trước
- `.env.local` được load sau và override giá trị từ `.env`

Do đó người dùng có thể bật TUI tạm thời bằng `QICLAW_TUI_ENABLED=true` trong `.env.local` mà không cần thay đổi CLI arguments.

### 4. Fallback behavior

Giữ nguyên khối fallback ở [src/cli/main.ts:281-283](src/cli/main.ts#L281-L283).

Điều này đảm bảo:
- Nếu env bật TUI nhưng binary không tồn tại
- Hoặc bridge launch thất bại
- Hoặc TUI startup ném lỗi

thì tiến trình không fail cứng; thay vào đó nó ghi `Falling back to plain mode: ...` và tiếp tục vào CLI text mode.

### 5. User-visible behavior summary

| Điều kiện | Kết quả |
| --- | --- |
| `--prompt` có mặt | `compact` |
| Không TTY | `plain` |
| TTY + `QICLAW_TUI_ENABLED=true` | thử `interactive`/TUI |
| TTY + env thiếu hoặc khác `true` | `plain` |
| TUI startup lỗi | fallback sang `plain` |

## Testing

Cập nhật test trong khu vực CLI, trọng tâm là [tests/cli/tuiLauncher.test.ts](tests/cli/tuiLauncher.test.ts) và/hoặc các test cho `buildCli` nếu đã có coverage ở nơi khác.

Các ca cần có:

1. **Default CLI mode without env**
   - TTY có mặt
   - không có `QICLAW_TUI_ENABLED`
   - không gọi `launchTui`
   - đi vào plain/CLI path

2. **TUI enabled only for exact true**
   - `QICLAW_TUI_ENABLED=true` + TTY
   - gọi `launchTui`

3. **Non-true values do not enable TUI**
   - các giá trị như `TRUE`, `1`, `yes`, `false`, chuỗi rỗng
   - không gọi `launchTui`

4. **No TUI on non-TTY even when enabled**
   - `QICLAW_TUI_ENABLED=true`
   - `stdout.isTTY` falsy
   - vẫn chạy plain

5. **Fallback path remains intact**
   - `QICLAW_TUI_ENABLED=true` + TTY
   - mock `launchTui` throw error
   - xác nhận stderr có thông báo fallback và CLI tiếp tục ở plain mode

6. **Removed --plain parsing**
   - parseArgs không còn chấp nhận `--plain`
   - nếu có test parser trực tiếp, cập nhật kỳ vọng sang `Unknown argument: --plain`

## Risks and mitigations

- **Risk:** Thay đổi hành vi mặc định có thể làm người đang quen TUI nghĩ rằng TUI bị hỏng.
  - **Mitigation:** Semantics env rõ ràng, dễ ghi trong docs hoặc release notes sau này.

- **Risk:** Có test cũ đang ngầm giả định “TTY thì interactive”.
  - **Mitigation:** Cập nhật các assertion để bám vào env-gated behavior thay vì TTY-only behavior.

- **Risk:** Người dùng đặt `QICLAW_TUI_ENABLED=TRUE` và kỳ vọng hoạt động.
  - **Mitigation:** Cố ý không hỗ trợ; chỉ `true` mới bật để tránh nhập nhằng cấu hình.

## Acceptance criteria

- Khi chạy QiClaw trong terminal TTY bình thường và không có `QICLAW_TUI_ENABLED=true`, app vào CLI text mode.
- Khi `.env` hoặc `.env.local` chứa đúng `QICLAW_TUI_ENABLED=true`, app thử khởi động TUI.
- Khi TUI startup thất bại, app tự fallback về CLI text mode.
- `--plain` không còn được parse như một cờ hợp lệ.
- Test suite liên quan đến CLI mode selection phản ánh hành vi mới.