# CLI REPL Cyber/Devtool Design

## Goal
Nâng cấp riêng interactive REPL UI của QiClaw theo phong cách cyber/devtool bằng `picocolors`, với output cuối bám sát mockup đã chốt: có top chrome `QiClaw` + model, prompt `»`, thinking line, tool activity line có status con, separator rõ ràng, answer body ở giữa, và footer `DONE` ở cuối. Mục tiêu là làm terminal trông như một ứng dụng agent chuyên dụng mà không thay đổi flow xử lý turn hiện tại.

## Scope
Chỉ áp dụng cho REPL trong [src/cli/repl.ts](src/cli/repl.ts).

Bao gồm:
- prompt thường
- prompt multiline
- `/help`
- thông báo bật/tắt multiline
- `Goodbye.`
- render kết quả sau mỗi turn

Không bao gồm:
- prompt mode ngoài REPL
- telemetry formatter toàn cục
- thay đổi business logic của agent loop
- thay đổi sang thư viện UI terminal khác

## Current State
Trong [src/cli/repl.ts](src/cli/repl.ts):
- prompt là plain text (`options.promptLabel` hoặc `… `)
- `/help` chỉ in một dòng text thường
- multiline mode chỉ có thông báo text thường
- final answer được render trực tiếp qua `renderFinalAnswer(result.finalAnswer)`
- `stopReason` hiện chưa được dùng để tạo status UI

Kết quả là REPL chạy được nhưng giao diện còn phẳng, khó phân tách trạng thái và không tạo được hierarchy thị giác giữa info, command, mode, và final result.

## Requirements
1. Dùng `picocolors` để tô màu, không thêm dependency mới.
2. Phong cách cyber/devtool, bám sát mockup người dùng đã chốt.
3. `DONE` hiển thị màu xanh; các trạng thái thất bại vẫn cần có palette đỏ/cam để dùng khi xảy ra lỗi.
4. Có thể dùng Unicode (`✔`, `✖`, `ℹ`, `⚡`, `»`, `─`, `┌`, `┐`, `└`, `┘`, `│`).
5. Output cuối phải có đủ các vùng: top chrome, prompt, thinking/tool activity, separator, answer body, footer.
6. Top chrome phải có `QiClaw` ở bên trái và model ở bên phải theo kiểu app header.
7. Prompt nhập lệnh dùng `»` và giữ cảm giác gọn sạch.
8. Thinking/tool activity phải có hierarchy giống mockup: dòng thinking riêng, tool line riêng, dòng con success riêng.
9. Giữ REPL dễ đọc với output dài nhiều dòng.
10. Patch gọn, tập trung ở render layer của REPL và các điểm wiring trực tiếp liên quan.

## Recommended Approach
Thêm một lớp presentation nhỏ ngay trong REPL để chuẩn hóa mọi terminal string trước khi ghi ra stdout, thay vì thay đổi `runTurn` hay phần agent logic.

### Why this approach
- REPL hiện đã có các điểm vào rõ ràng để format text: prompt labels, help text, mode notices, và final answer rendering.
- Không cần đưa styling xuống provider/agent layer.
- Giữ blast radius nhỏ: chủ yếu sửa [src/cli/repl.ts](src/cli/repl.ts) và test liên quan.
- Có thể dùng lại `stopReason` để gắn nhãn trạng thái mà không đổi contract chính của `runTurn`.

## Alternatives Considered

### 1. Minimal color only
Chỉ tô màu prompt, help, và status text.
- Ưu: ít sửa nhất
- Nhược: không đạt mockup đã chốt, thiếu top chrome và hierarchy tool output

### 2. Structured REPL chrome nhẹ
Thêm prompt có theme, divider, status header và body.
- Ưu: khá cân bằng
- Nhược: vẫn chưa đủ giống mockup vì thiếu app-header và tool tree con

### 3. Full framed REPL shell
Render REPL như một ứng dụng agent hoàn chỉnh: top chrome, prompt riêng, thinking/tool hierarchy, answer section, footer completion.
- Ưu: khớp mockup người dùng đã đưa ra, tạo cảm giác cyber/devtool rõ nhất
- Nhược: cần sửa nhiều hơn ở render/wiring
- **Khuyến nghị chọn**

## Design

### 1. Color palette and symbols
Sử dụng palette sau:
- primary chrome/info: cyan hoặc electric blue
- success: green
- fail: red với orange accent cho nhánh lỗi
- secondary text: dim gray
- body text chính: trắng/default để giữ khả năng đọc dài

Biểu tượng:
- `⚡` cho app identity hoặc action line
- `🧠` cho thinking state
- `✔` cho success/DONE
- `✖` cho fail
- `»` cho prompt
- `─` cho section separator
- `┌ ┐ └ ┘ │` cho top chrome

### 2. Top chrome
REPL sẽ render một app header khi khởi động interactive mode, theo tinh thần mockup:

```text
┌────────────────────────────────────────────────────┐
│  ⚡QiClaw                               🤖 Model: X │
└────────────────────────────────────────────────────┘
```

Nguyên tắc:
- `QiClaw` nằm bên trái với accent cyber
- model nằm bên phải ở dạng secondary badge/text
- chiều rộng header nên được tính ổn định theo terminal width nếu có thể; nếu chưa có terminal width abstraction thì dùng width cố định hợp lý cho REPL hiện tại
- header chỉ render một lần khi vào interactive mode, không lặp lại mỗi turn

### 3. Prompt styling
Prompt nhập lệnh dùng prefix `»` theo mockup, với màu cyan/bright blue và spacing rõ ràng:

```text
» đọc commit gần nhất và cho tôi biết message là gì?
```

Nguyên tắc:
- giữ prompt ngắn, sạch, không thêm quá nhiều ký tự nhiễu
- multiline mode vẫn là biến thể của cùng prompt system, nhưng có dấu hiệu phân biệt rõ ràng bằng màu hoặc marker phụ
- không thay đổi semantics của `readLine`, chỉ đổi string promptLabel truyền vào

### 4. Thinking and tool activity area
Sau khi user submit, REPL sẽ render khu vực tiến trình giống mockup:

```text
 🧠 Thinking...
 ⚡ Turn 1: shell:read git log -1 --pretty=%B
 └─ ✔ Success (14ms)
```

Nguyên tắc:
- `Thinking...` là dòng riêng, dim/cyan để thể hiện đang xử lý
- tool activity là dòng riêng, ưu tiên giữ nội dung thật từ runtime nếu có observer tương ứng
- dòng con `└─ ✔ Success (14ms)` là summary line cho tool result; nếu turn không có tool nào thì bỏ vùng tool tree nhưng vẫn có separator + answer/footer
- hierarchy phải dễ scan: parent action ở trên, child result ở dưới

### 5. Answer section
Sau vùng thinking/tool activity là một separator rồi đến final answer body:

```text
──────────────────────────────────────────────────────

Message của commit gần nhất: "test cli"
```

Nguyên tắc:
- answer body không nằm trong box
- preserve line breaks nguyên bản trong `finalAnswer`
- body chủ yếu giữ màu mặc định để dễ đọc nội dung dài
- separator là mốc thị giác giữa execution trace và user-facing answer

### 6. Footer section
Sau final answer sẽ có separator cuối và dòng footer completion theo mockup:

```text
──────────────────────────────────────────────────────
 ✔ DONE  ⏱ 8.0s • 2 providers • 1 tool
```

Nguyên tắc:
- `DONE` màu xanh nổi bật
- khi failure, footer chuyển sang `✖ FAIL` với palette đỏ/cam
- metrics như thời gian, providers, tools dùng dim/secondary style
- footer là dòng tổng kết ngắn, không lặp lại stop reason nếu phần đó đã thể hiện ở execution area

### 7. Status mapping
REPL sẽ suy ra footer badge từ `stopReason`:
- `DONE`: các trạng thái hoàn tất bình thường
- `FAIL`: các trạng thái còn lại

Việc map cụ thể phải phản ánh enum thật đang dùng trong codebase. Nếu enum có nhiều trạng thái thành công hợp lệ, nhóm chúng vào `DONE`; các trạng thái lỗi, interrupted, hoặc exhausted sẽ vào `FAIL`.

### 8. Implementation shape
Dự kiến thay đổi ở các điểm liên quan trực tiếp đến REPL render:
- [src/cli/repl.ts](src/cli/repl.ts)
  - thêm import `picocolors`
  - thêm formatter cho top chrome, prompt, help/mode messages, thinking line, tool line, answer separator, footer
  - thay `renderFinalAnswer(result.finalAnswer)` bằng renderer đầy đủ cho execution block + answer + footer
  - render top chrome khi bắt đầu `runInteractive()`
- caller/wiring trực tiếp liên quan nếu cần truyền thêm metadata render cho REPL, nhưng giữ blast radius nhỏ nhất có thể

Mục tiêu là gom presentation logic thành các helper rõ ràng, đủ nhỏ để không cần framework terminal mới.

## 9. Tests
Cập nhật test cho REPL để xác nhận:
1. interactive mode render top chrome đúng một lần khi khởi động
2. prompt dùng prefix `»`
3. help/multiline notices có style string đúng cấu trúc mong muốn
4. final render có thinking/tool area, separator, answer body, và footer `DONE` hoặc `FAIL`
5. `FAIL` xuất hiện đúng khi stopReason không thuộc nhóm thành công
6. multiline body vẫn giữ line breaks
7. `/exit` và EOF flow vẫn hoạt động đúng

Do `picocolors` có thể tắt màu trong một số môi trường, test nên tập trung vào cấu trúc string, symbol, và thứ tự section; không phụ thuộc tuyệt đối vào escape code nếu môi trường test không đảm bảo màu được bật.

## Risks and mitigations
- **Rủi ro over-styling:** giữ body câu trả lời sạch, chỉ nhấn màu ở chrome, thinking, tool rows, separator, footer.
- **Rủi ro mapping sai stopReason:** đọc enum thật trước khi implement và test cả success/failure cases.
- **Rủi ro top chrome lệch hàng:** dùng helper pad/truncate ổn định cho phần title/model.
- **Rủi ro patch lan rộng:** ưu tiên giữ thay đổi ở [src/cli/repl.ts](src/cli/repl.ts) và chỉ chạm wiring trực tiếp nếu bắt buộc để lấy metadata hiển thị.

## Files Expected To Change
- [src/cli/repl.ts](src/cli/repl.ts)
- file wiring CLI liên quan trực tiếp nếu cần truyền tool/thinking/footer metadata vào REPL renderer
- test REPL liên quan, nhiều khả năng là [tests/cli/repl.test.ts](tests/cli/repl.test.ts) hoặc file test tương đương sau khi xác minh path thực tế

## Done Criteria
Được coi là xong khi:
1. interactive REPL render top chrome giống tinh thần mockup đã chốt
2. prompt dùng `»`
3. execution trace có thinking line, tool line, child success/fail line
4. answer body nằm giữa hai separator như mockup
5. footer `DONE` xanh, `FAIL` đỏ/cam
6. chỉ REPL và wiring hiển thị trực tiếp liên quan bị ảnh hưởng
7. test liên quan được cập nhật và pass
