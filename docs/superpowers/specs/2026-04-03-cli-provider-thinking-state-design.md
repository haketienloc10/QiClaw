# CLI Provider Thinking State Design

## Goal
Hiển thị `QiClaw` ngay khi user submit prompt và mỗi lần turn chuẩn bị bước vào một provider round mới, thay vì chờ provider trả về output đầu tiên. Trong khoảng chờ đó, CLI hiển thị trạng thái `thinking.` → `thinking..` → `thinking...` phù hợp với terminal UX hiện tại.

## Current state
- `src/cli/main.ts` đang quản lý assistant block rendering qua `createAssistantBlockWriter()`.
- `src/agent/loop.ts` đã phát telemetry `provider_called` trước khi await `input.provider.generate(...)`.
- `src/telemetry/display.ts` hiện chỉ format tool activity line và footer line, chưa có khái niệm provider-waiting placeholder.
- `QiClaw` chỉ xuất hiện khi có activity line hoặc final answer đầu tiên được render.

## Requirements
1. Khi user submit trong interactive mode, `QiClaw` phải hiện ngay, không đợi provider trả lời.
2. Mỗi lần turn bắt đầu một provider round mới, nếu chưa có output mới để render, phải hiện lại trạng thái chờ.
3. Trạng thái chờ dùng dấu chấm động: `🧠 Thinking.` → `🧠 Thinking..` → `🧠 Thinking...`.
4. Dòng trạng thái chờ không nằm trong assistant body indent; nó bắt đầu ở đầu dòng, không thụt 2 spaces.
5. Khi có output thật hoặc footer, trạng thái chờ không bị xóa trần mà được thay thế bằng `✓ Responding` với dấu `✓` màu xanh lá trong TTY nếu hỗ trợ.
6. Không làm bẩn output contract của non-TTY và `--prompt` mode.
7. Giữ patch nhỏ, ưu tiên tận dụng telemetry `provider_called` đã có thay vì thêm event mới nếu không cần.

## Recommended approach
Dùng `provider_called` làm trigger cho một pending assistant state ở CLI render layer.

### Why this approach
- `provider_called` đã được emit đúng thời điểm, ngay trước lúc await provider ở `src/agent/loop.ts`.
- Loading/thinking là concern của renderer, không nên nhét vào `repl.ts`.
- Có thể giữ `src/telemetry/display.ts` tập trung vào nội dung compact status, còn `src/cli/main.ts` lo layout, animation, và replacement.
- Tránh phải đổi provider/tool loop semantics nếu event hiện có đã đủ.

## Design

### 1. Add provider waiting state to CLI rendering
Mở rộng writer ở `src/cli/main.ts` để quản lý thêm một loại output tạm thời:
- pending thinking line
- timer/interval để cập nhật text theo chu kỳ ngắn
- transition sang responding state khi output thật bắt đầu

Writer cần thêm các capability sau:
- `startProviderThinking()`
  - đảm bảo prelude `QiClaw` đã hiện
  - nếu TTY: render một dòng `🧠 Thinking.` và cập nhật tuần hoàn giữa `🧠 Thinking.` / `🧠 Thinking..` / `🧠 Thinking...`
  - dòng này bắt đầu ở đầu dòng, không indent 2 spaces như assistant body
  - nếu non-TTY: không animate; hoặc bỏ qua hoàn toàn để giữ output sạch
- `markResponding()`
  - dừng timer
  - thay dòng trạng thái chờ hiện tại thành `✓ Responding`
  - nếu là TTY và terminal hỗ trợ ANSI, render `✓` màu xanh lá
  - đảm bảo chỉ chuyển một lần cho mỗi provider round
- `clearProviderStatus()`
  - reset state tạm sau khi đã transition xong, để round sau có thể bắt đầu lại
- mọi path render output thật (`writeAssistantLine`, `replaceAssistantLine`, `writeAssistantTextBlock`, `writeFooterLine`) phải transition trạng thái chờ sang `✓ Responding` trước khi ghi

### 2. Trigger from telemetry observer wiring
Trong `src/cli/main.ts`, chỗ wiring observer cần xử lý `provider_called` như một tín hiệu UI:
- khi nhận `provider_called`, gọi `assistantBlockWriter.startProviderThinking()`
- khi nhận `provider_responded`, không cần render gì riêng; output thật hoặc tool activity phía sau sẽ tự clear placeholder
- nếu một provider round kết thúc mà không có body/tool line nhưng đi thẳng tới footer/final answer, path render tương ứng vẫn phải clear placeholder an toàn

Nếu observer compact hiện tại chưa xử lý `provider_called`, thêm một observer nhẹ ở CLI layer thay vì ép `src/telemetry/display.ts` format một dòng text giả.

### 3. Preserve round-by-round behavior
Thinking state là per provider round, không phải one-shot per turn:
- provider round 1 bắt đầu → hiện thinking ngay sau Enter
- tool round chạy xong, agent quay lại provider → hiện thinking lại
- nếu provider round kế tiếp tới rất nhanh, placeholder có thể chỉ lóe ngắn; đó là chấp nhận được miễn cleanup đúng

### 4. TTY vs non-TTY behavior
- **TTY interactive mode:** animate dấu chấm động bằng line replacement và đổi sang `✓ Responding` khi output thật bắt đầu.
- **non-TTY / prompt mode:** không dùng animation lặp để tránh spam transcript.
- Có thể chọn một trong hai policy cho non-TTY:
  1. không hiển thị provider status
  2. hiển thị đúng một dòng tĩnh `🧠 Thinking...` rồi `✓ Responding`

Khuyến nghị: **không animate trong non-TTY**, và chỉ hiển thị status nếu output contract test cho phép. Nếu không cần, bỏ hẳn status ở non-TTY để giảm rủi ro.

### 5. Interaction with existing activity/footer rendering
- Tool activity line đầu tiên phải đến sau khi dòng trạng thái đã được chuyển sang `✓ Responding`, không để trạng thái chờ còn treo.
- Final answer block đầu tiên cũng phải transition trạng thái trước khi render body.
- Footer flush phải luôn transition trạng thái trước nếu provider round đang chờ.
- `resetTurn()` cần đảm bảo timer bị dọn kể cả trong case error/stop sớm.

## Files to modify
- `src/cli/main.ts`
  - mở rộng `createAssistantBlockWriter()` với provider thinking state và cleanup
  - thêm observer wiring cho `provider_called`
- `src/telemetry/display.ts`
  - chỉ sửa nếu cần hook nhỏ hỗ trợ observer contract; tránh biến file này thành nơi render placeholder
- `src/agent/loop.ts`
  - chỉ sửa nếu thực tế cần signal sớm hơn `provider_called`; mặc định kỳ vọng **không cần đổi** vì event đã emit trước `await input.provider.generate(...)`
- `tests/cli/repl.test.ts`
  - thêm assertions cho việc `QiClaw` xuất hiện sớm ở interactive flow
- `tests/telemetry/display.test.ts`
  - chỉ cập nhật nếu contract observer compact thay đổi
- có thể cần test ở `tests/cli/main*.test.ts` nếu codebase đã có test bao cho assistant block writer/CLI wiring

## Testing strategy
1. Interactive TTY flow:
   - submit prompt → `QiClaw` xuất hiện ngay trước khi có provider output
   - dòng `🧠 Thinking.` / `..` / `...` xuất hiện trong khi chờ và không bị indent 2 spaces
   - khi final answer hoặc tool activity tới, dòng trạng thái được thay bằng `✓ Responding`
2. Multi-round flow:
   - round 1 provider wait có thinking
   - sau tool execution, round 2 provider wait có thinking lại
   - mỗi round đều transition đúng sang `✓ Responding`
3. Footer safety:
   - không còn thinking line dư khi turn kết thúc
   - nếu footer là output đầu tiên sau waiting state, trạng thái vẫn phải đổi sang `✓ Responding` trước
4. Non-TTY/prompt mode:
   - không bị spam animation frames
   - output contract cũ vẫn ổn, hoặc được cập nhật tối thiểu nếu cố ý thêm status tĩnh
5. Existing compact tool activity/footer tests vẫn pass.

## Risks and mitigations
- **Rủi ro timer leak:** dừng interval trong mọi path `markResponding()`/`clearProviderStatus()` và `resetTurn()`.
- **Rủi ro flicker khi provider trả lời quá nhanh:** chấp nhận mức flicker nhỏ; ưu tiên correctness hơn debounce phức tạp.
- **Rủi ro làm bẩn non-TTY transcript:** giới hạn animation cho TTY.
- **Rủi ro đan xen sai với tool activity replacement:** luôn transition sang `✓ Responding` trước mọi output thật.
- **Rủi ro ANSI màu gây lỗi hiển thị:** chỉ tô xanh `✓` khi là TTY hỗ trợ ANSI; fallback text thường ở môi trường khác.
- **Rủi ro trùng trách nhiệm giữa telemetry formatter và writer:** giữ formatter chỉ format text compact; writer quản lý lifecycle provider status.

## Explicit decisions
- Thinking state là **per provider round**.
- Trigger ưu tiên dùng telemetry `provider_called` hiện có.
- Animation chọn **dấu chấm động** với prefix `🧠 Thinking`.
- Dòng provider status bắt đầu ở đầu dòng, **không indent 2 spaces**.
- Khi output thật hoặc footer bắt đầu, trạng thái được **thay bằng** `✓ Responding`, không xóa trần.
- Không chuyển sang full-screen TUI; tiếp tục bám streamed CLI hiện tại.
