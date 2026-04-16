# QiClaw TUI Footer Summary Design

Date: 2026-04-16
Status: Draft approved in terminal, written for review

## Goal

Nâng cấp footer của QiClaw TUI để giữ shell hiện tại nhưng truyền tải trạng thái rõ hơn theo phong cách CLI: status strip phía trên composer trở thành một hàng 2 phía, trong đó phần trái hiển thị trạng thái ngắn gọn của turn gần nhất hoặc session hiện tại, và phần phải luôn hiển thị `provider:model` căn phải.

## Success Criteria

- TUI vẫn giữ cấu trúc đáy màn hình hiện tại: transcript → status strip → composer → footer rail.
- Dòng status strip phía trên composer hiển thị summary ngắn gọn của turn gần nhất thay vì chỉ có status text đơn lẻ.
- `provider:model` luôn nằm ở mép phải của status strip.
- Footer rail dưới cùng vẫn chỉ hiển thị key hints theo mode hiện tại.
- Summary của turn ngắn gọn nhưng đủ thông tin để người dùng biết kết quả turn, verification, số lượt gọi provider, số tool calls, token input/output, và tổng thời gian.
- Patch bám theo kiến trúc hiện tại, không cần thêm hàng mới trong layout.

## Non-Goals

Pass này không bao gồm:

- thêm hàng footer mới vào layout TUI
- thay đổi transcript structure hoặc transcript semantics
- thay đổi key hint rail ở footer dưới cùng
- thiết kế lại protocol lớn hoặc rework host↔TUI event model ngoài phạm vi summary footer
- copy nguyên xi formatter CLI compact footer vào TUI nếu format đó quá dài hoặc chứa thông tin không phù hợp với chiều rộng của TUI

## Current State

- Status strip hiện chỉ render một chuỗi `status_text` đơn tại [tui/src/footer/render.rs](../../../tui/src/footer/render.rs).
- Footer rail hiện render key hints tách riêng ở cùng file và đã đúng vai trò.
- Root layout hiện đã chia transcript, status, composer, footer tại [tui/src/transcript/layout.rs](../../../tui/src/transcript/layout.rs).
- `FooterState` hiện chỉ có `status_text` cùng các flag phục vụ key hints tại [tui/src/footer/state.rs](../../../tui/src/footer/state.rs).
- TUI controller phía TypeScript đã biết khi nào một turn kết thúc và đang có đủ dữ liệu để tạo turn summary tại [src/cli/tuiController.ts](../../../src/cli/tuiController.ts).

## Recommended Approach

Giữ nguyên shell TUI hiện tại và nâng cấp status strip thành một hàng có hai vùng nội dung:

- bên trái: `turn_summary_text` nếu có, ngược lại là `status_text`
- bên phải: `model_text` luôn căn phải

Turn summary nên được tạo ở TypeScript controller layer, không phải ở Rust render layer. Rust chỉ chịu trách nhiệm render state đã được tổng hợp.

### Why this approach

- Đúng với yêu cầu người dùng: giữ giao diện footer TUI hiện tại nhưng bổ sung semantics của CLI.
- Hạn chế thay đổi layout: không cần thêm hàng mới, không làm composer hay transcript bị dời vị trí.
- Giữ ranh giới trách nhiệm rõ ràng: controller tổng hợp state của turn, Rust chỉ render.
- Tránh nhồi logic runtime/observer vào frontend Rust, giúp test formatter phía TypeScript dễ hơn.

## Design

## Section 1 — Footer State Model

### New fields

`FooterState` nên được mở rộng để mô tả rõ ba loại nội dung khác nhau:

- `status_text`: trạng thái session hoặc trạng thái ngắn hạn, ví dụ `Ready`, `Session restored`, `Model updated ...`
- `turn_summary_text`: summary ngắn gọn của turn gần nhất, ví dụ `completed • verified • 1 provider • 2 tools • 12k in • 1.3k out • 18s`
- `model_text`: chuỗi `provider:model` để render ở mép phải

Các flag hiện tại phục vụ key hints (`mode`, `draft_present`, `popup_open`, `busy`, `transcript_scrolled`, `shift_enter_supported`) được giữ nguyên.

### Display precedence

Status strip dùng quy tắc ưu tiên sau:

1. nếu `turn_summary_text` có giá trị thì dùng nó ở phía trái
2. nếu chưa có summary turn thì fallback về `status_text`
3. `model_text` luôn render ở phía phải

Pass này không thêm một lớp ưu tiên đặc biệt riêng cho warning/error trong render layer. Nếu host muốn thay nội dung phía trái bằng warning/error mới, host có thể cập nhật `status_text` hoặc xóa `turn_summary_text` trước khi render.

## Section 2 — Turn Summary Content

### Summary format

Turn summary của TUI nên ngắn gọn hơn CLI compact footer nhưng vẫn đủ để người dùng hiểu tình trạng turn. Format mục tiêu là:

`completed • verified • 1 provider • 2 tools • 12k in • 1.3k out • 18s`

Thành phần của summary:

- trạng thái chính của turn: `completed`, `stopped`, hoặc `max tools`
- `verified` nếu `settled.verification.isVerified === true`
- số lượt gọi provider thực tế trong turn: `1 provider`, `2 providers`
- số tool calls thực tế trong turn: `1 tool`, `2 tools`
- token input/output của turn: `12k in`, `1.3k out`
- tổng wall-clock duration của turn: `842ms` nếu dưới 1 giây, hoặc `18s` nếu từ 1 giây trở lên

### Specific wording rules

- Dùng `provider/providers` theo số lượng thực tế.
- Dùng `tool/tools` theo số lượng thực tế.
- Dùng `<input> in` và `<output> out` cho token counts.
- Token counts nên được format ngắn gọn theo compact notation khi cần, ví dụ `12k in`, `1.3k out`.
- `max_tool_rounds_reached` nên được rút gọn thành `max tools` để phù hợp không gian hẹp.
- Không đưa model name hay path vào turn summary vì model đã ở cột phải và các thông tin khác không cần thiết cho mục tiêu hiện tại.

### Why not reuse CLI footer verbatim

CLI compact footer đang chứa thêm các thông tin như token counts và wording gắn với mode console output. TUI status strip hẹp hơn và có cột model riêng ở bên phải, nên việc reuse nguyên xi sẽ quá dài và làm giảm tính đọc nhanh.

## Section 3 — Data Collection in Controller

### Where the summary is built

Turn summary cần được tạo trong [src/cli/tuiController.ts](../../../src/cli/tuiController.ts), tại đoạn turn đã settle sau `executeTurn(...)`.

Controller cần thu thập các giá trị sau cho từng turn:

- `stopReason`
- `verification.isVerified`
- số lượt gọi provider trong turn
- số tool calls trong turn
- token input của turn
- token output của turn
- tổng duration của turn

### Counting rules

- **Provider count**: đếm số lần provider thực sự được gọi trong turn, không suy luận từ stop reason.
- **Tool count**: đếm số tool calls thực tế trong turn, không dùng `toolRoundsUsed` vì rounds không đồng nghĩa với số calls.
- **Input/output tokens**: lấy từ nguồn usage đáng tin cậy nhất mà runtime đã có thật cho turn đó; ưu tiên nguồn aggregate nếu có, nếu không thì lấy từ observer/event telemetry với test khóa để tránh double-count.
- **Duration**: đo wall-clock duration từ lúc `runPrompt(...)` bắt đầu cho đến khi final result settle.

### Suggested implementation shape

Tạo một formatter/helper nhỏ trong controller layer để:

1. thu thập turn metrics trong quá trình stream event
2. chuẩn hóa `stopReason` sang text ngắn cho TUI
3. format summary string cuối cùng
4. emit/update state để frontend Rust hiển thị ở status strip

Mục tiêu là giữ logic tổng hợp text ở TypeScript, còn Rust chỉ nhận state đã sẵn sàng để render.

## Section 4 — Render Behavior in Rust TUI

### Status strip layout

`render_status_strip(...)` ở [tui/src/footer/render.rs](../../../tui/src/footer/render.rs) nên chuyển từ render một chuỗi duy nhất sang render một hàng có hai đầu:

- trái: `turn_summary_text || status_text`
- phải: `model_text`

### Width priority

Khi chiều rộng đủ lớn:

- render đầy đủ summary ở bên trái
- render đầy đủ model ở bên phải
- giữ khoảng trắng phân cách giữa hai vùng

Khi chiều rộng hẹp:

1. ưu tiên giữ `model_text` ở phía phải nhiều nhất có thể
2. truncate phần bên trái trước
3. chỉ truncate phần bên phải nếu terminal quá hẹp

### Truncation policy

Pass đầu có thể dùng helper truncate đơn giản theo char/width đang có, miễn là đảm bảo:

- model được ưu tiên giữ lại hơn summary
- summary là phần bị cắt trước
- không chèn footer summary xuống dòng thứ hai

Nếu implementation hiện có thuận tiện, truncate bằng ellipsis là tốt hơn truncate hard-cut, nhưng ellipsis không phải yêu cầu bắt buộc của pass này.

### Footer rail remains unchanged

`render_footer_rail(...)` tiếp tục giữ nguyên trách nhiệm hiện tại: hiển thị key hints theo mode. Turn summary không được trộn vào footer rail.

## Section 5 — Event and State Update Semantics

### Startup behavior

Khi app khởi động:

- `status_text` nhận các trạng thái như `New session` hoặc `Session restored`
- `model_text` nhận giá trị `provider:model`
- `turn_summary_text` ban đầu rỗng

### During normal operation

- các status ngắn hạn như `/model updated`, direct command footer, hoặc session status vẫn có thể cập nhật `status_text`
- `turn_summary_text` giữ summary của turn gần nhất cho đến khi có turn mới hoàn tất

### After turn completion

Khi một turn kết thúc:

- controller tạo summary mới từ metrics của turn
- app cập nhật `turn_summary_text`
- status strip hiển thị summary này ở hàng phía trên composer
- turn kế tiếp sẽ ghi đè summary bằng summary mới khi nó hoàn tất

Điều này đáp ứng yêu cầu “sau mỗi turn thì hiển thị thêm nội dung giống CLI để biết trạng thái” nhưng vẫn giữ TUI shell ổn định.

## Files Likely To Change

- `tui/src/footer/state.rs`
  - thêm `turn_summary_text` và `model_text`
- `tui/src/footer/render.rs`
  - đổi status strip sang layout 2 phía, thêm logic truncate ưu tiên model
- `tui/src/app.rs`
  - lưu/đồng bộ model text và turn summary vào footer state
- `src/cli/tuiController.ts`
  - thu thập turn metrics và format turn summary cho TUI
- có thể cần cập nhật `src/cli/tuiProtocol.ts` hoặc tận dụng event hiện có, tùy cách wiring state được chọn
- tests liên quan cho Rust render và controller behavior

## Testing Strategy

### Rust tests

Bổ sung test quanh [tui/src/footer/render.rs](../../../tui/src/footer/render.rs):

1. status strip render được cả summary phía trái và model phía phải
2. model nằm ở phía phải của dòng render
3. khi width hẹp, summary bị truncate trước model
4. khi chưa có `turn_summary_text`, status strip fallback về `status_text`
5. footer rail vẫn render key hints như cũ

### TypeScript tests

Bổ sung test quanh [src/cli/tuiController.ts](../../../src/cli/tuiController.ts):

1. format `completed • verified • 1 provider • 2 tools • 12k in • 1.3k out • 18s`
2. singular/plural đúng cho `provider/providers` và `tool/tools`
3. compact formatting đúng cho token counts (`12k`, `1.3k`)
4. duration dưới 1 giây hiển thị theo `ms`
5. `max_tool_rounds_reached` được rút gọn thành `max tools`
6. tool count là số calls thực tế, không phải tool rounds
7. token input/output không bị double-count khi có nhiều provider phases hoặc nhiều event nguồn

### Integration behavior tests

Trong các test TUI/controller hiện có:

- sau khi một turn hoàn tất, status strip nhận summary mới
- khi đổi model, phần bên phải cập nhật đúng
- direct commands như `/diff` hoặc shell command không làm hỏng footer render path

## Risks and Mitigations

- **Summary quá dài trên terminal hẹp**
  - giảm bằng cách giữ format ngắn, tách model ra cột phải, và truncate phần trái trước
- **Nhầm tool rounds với tool calls**
  - đếm từ tool events thực tế thay vì reuse `toolRoundsUsed`
- **Logic tổng hợp bị trôi vào Rust render layer**
  - giữ formatter hoàn toàn ở controller TS, Rust chỉ render string
- **Status text và turn summary chồng vai trò**
  - tách `status_text` và `turn_summary_text` thành hai field riêng trong `FooterState`
- **Format TUI bị drift so với CLI**
  - chấp nhận khác biệt có chủ đích: TUI giữ cùng ý nghĩa nhưng wording ngắn gọn hơn để phù hợp không gian status strip

## Open Questions Resolved In This Design

- **Summary nên hiển thị ở đâu?** → ngay trên composer trong status strip hiện tại
- **Có thêm hàng mới không?** → không
- **Model nằm ở đâu?** → căn phải trong status strip
- **Summary có cần giống hệt CLI không?** → không; giữ semantics của CLI nhưng viết gọn cho TUI
- **Summary cần thêm gì ngoài completed/verified/tools?** → thêm provider count và total duration
