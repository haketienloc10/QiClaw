# Telemetry debug log design

## Mục tiêu

Bổ sung hai kênh observability riêng biệt cho CLI runtime:

1. **CLI display gọn**: hiển thị tiến trình tool call ngắn gọn, ít rò dữ liệu, gần mức telemetry hiện tại.
2. **Debug JSONL đầy đủ**: ghi file event log chi tiết để debug, ưu tiên giữ ngữ cảnh tool call/tool result giống transcript nội bộ nhưng ở định dạng JSONL, với redaction mặc định cho dữ liệu nhạy cảm.

Thiết kế này phải bám sát kiến trúc telemetry hiện có, không thêm transcript text formatter, không biến REPL thành nơi tự dựng trạng thái từ đầu, và không thay đổi mục tiêu MVP của runtime.

## Bối cảnh hiện tại

Codebase đã có ba khối telemetry nền:

- [src/telemetry/observer.ts](src/telemetry/observer.ts): định nghĩa `TelemetryEvent`, `TelemetryObserver`, `createTelemetryEvent(...)`
- [src/telemetry/logger.ts](src/telemetry/logger.ts): logger JSONL cơ bản ghi nguyên event được nhận
- [src/telemetry/metrics.ts](src/telemetry/metrics.ts): metrics observer in-memory

`runAgentTurn(...)` trong [src/agent/loop.ts](src/agent/loop.ts) đã phát các event mốc chính như `tool_call_started` và `tool_call_completed`, nhưng payload hiện còn quá mỏng để phục vụ debug tool call/result chi tiết. Đồng thời CLI chưa có một lớp hiển thị tiến trình tool gọn kiểu operator-facing.

## Non-goals

Thiết kế này cố ý không làm các phần sau:

- không thêm transcript text log
- không thêm streaming token output
- không thêm dashboard hay tracing backend
- không thêm remote telemetry transport
- không thêm config rotation/truncation cho file log
- không log raw provider secrets hoặc bỏ qua redaction mặc định

## Approach được chọn

Chọn **dual-channel telemetry trong cùng observer pipeline**.

Một stream telemetry duy nhất vẫn được emit từ core loop, nhưng sẽ có hai consumer riêng:

1. **Display observer** cho CLI: chỉ đọc các event cần thiết để in status ngắn gọn
2. **Debug JSONL observer**: ghi event đầy đủ hơn ra file sau khi đã redact

Lý do chọn hướng này:

- giữ `runAgentTurn(...)` là nơi quan sát chính xác nhất về tool call/result
- tránh việc CLI phải tự suy diễn tool activity từ state bên ngoài
- tận dụng contract observer pattern đã có
- cho phép mở rộng thêm consumer khác sau này mà không đổi chỗ phát event

## So sánh các approach khác

### Approach A — Dual-channel telemetry trong cùng observer pipeline (**chọn**)

- Ưu điểm:
  - phù hợp kiến trúc hiện tại nhất
  - giữ logic observability ở đúng lớp `loop.ts`
  - dễ mở rộng thêm logger/metrics/display song song
- Nhược điểm:
  - cần chuẩn hóa payload giàu dữ liệu hơn cho event tool
  - cần thêm observer composition

### Approach B — Tách display logger và debug logger ở lớp CLI

- Ưu điểm:
  - ít thay đổi type event hiện tại
- Nhược điểm:
  - CLI không có đủ dữ liệu gốc của tool input/result để log full debug chuẩn
  - dễ lệch giữa tool execution thật và thứ CLI hiển thị/log lại

### Approach C — Mọi event đều giàu dữ liệu cho tất cả consumer

- Ưu điểm:
  - một stream duy nhất cho mọi nơi dùng
- Nhược điểm:
  - tăng nguy cơ consumer hiển thị quá nhiều dữ liệu nhạy cảm
  - event type trở nên nặng ngay cả khi chỉ cần summary

## Thiết kế kiến trúc

### 1. Event stream trung tâm

`runAgentTurn(...)` tiếp tục là nơi emit telemetry. Các event tổng quát hiện có như `turn_started`, `provider_called`, `provider_responded`, `verification_completed`, `turn_completed`, `turn_stopped`, `turn_failed` vẫn được giữ.

Thay đổi chính là enrich payload của event tool:

- `tool_call_started`
  - `toolName`
  - `toolCallId`
  - `inputPreview`
  - `inputRawRedacted`
- `tool_call_completed`
  - `toolName`
  - `toolCallId`
  - `isError`
  - `resultPreview`
  - `resultRawRedacted`

Trong đó:

- `inputPreview` / `resultPreview` là bản tóm tắt ngắn, phù hợp cho display/UI nếu cần
- `inputRawRedacted` / `resultRawRedacted` là payload debug đã qua redaction, dùng cho file JSONL

Mục tiêu là giữ một nguồn sự thật duy nhất cho tool activity, nhưng tách rõ dữ liệu hiển thị và dữ liệu debug.

### 2. Observer composition

Cần thêm một composite observer nhỏ trong [src/telemetry/](src/telemetry/) để fan-out event đến nhiều observer con.

Contract đề xuất:

- `createCompositeObserver(observers: TelemetryObserver[]): TelemetryObserver`

Composite này sẽ được dùng để kết hợp:

- metrics observer hiện có
- display observer mới cho CLI
- debug JSONL observer khi được bật

Thiết kế này giữ `createAgentRuntime(...)` và [src/cli/main.ts](src/cli/main.ts) gọn: runtime chỉ nhận một `observer`, còn composition diễn ra trước khi inject.

### 3. CLI display observer

Thêm một observer chuyên cho output operator-facing. Observer này không ghi raw payload; nó chỉ phản ứng với một tập event nhỏ:

- `tool_call_started`
- `tool_call_completed`
- có thể thêm `turn_failed` cho thông báo lỗi ngắn nếu cần

Cách hiển thị đề xuất:

- khi `tool_call_started`: `Tool: <name>`
- khi `tool_call_completed` thành công: `Tool: <name> done`
- khi `tool_call_completed` lỗi: `Tool: <name> failed`

Nguyên tắc:

- không in args/result raw
- không in token, auth header, API key
- không làm CLI bị nhiễu như transcript đầy đủ
- giữ output gần mức telemetry hiện tại nhưng hữu ích hơn cho operator

Display observer nên nhận một callback `writeLine(text)` để CLI truyền `stdout.write(...)` hoặc writer test double.

### 4. Debug JSONL observer

Giữ format JSONL hiện có: mỗi event một dòng JSON.

Khác biệt là file debug giờ sẽ nhận event tool giàu dữ liệu hơn, gồm preview và payload đã redact. Điều này cho phép debug lại flow tool call/tool result mà không cần transcript text riêng.

File log chỉ được bật khi có cấu hình. Nếu không cấu hình, runtime không ghi debug file.

### 5. Redaction pipeline

Cần thêm utility redact trước khi ghi payload chi tiết vào event debug.

Nguyên tắc redaction:

- áp dụng mặc định, không yêu cầu user bật thêm
- chạy đệ quy qua object/array
- match theo tên key case-insensitive cho các nhóm như:
  - `apiKey`
  - `authorization`
  - `token`
  - `accessToken`
  - `refreshToken`
  - `secret`
  - các biến thể tương tự
- giá trị bị thay bằng marker cố định, ví dụ `[REDACTED]`

Các event summary cho CLI không cần dùng raw payload, nên không cần phụ thuộc vào dữ liệu chưa redact.

### 6. Preview policy

Ngoài raw redacted payload, mỗi event tool nên có preview ngắn để tiện đọc nhanh trong log hoặc dùng cho UI tương lai.

Policy đề xuất:

- preview là string ngắn, deterministic
- object/array được serialize có giới hạn độ dài
- result quá dài sẽ bị truncate
- preview không thay thế raw redacted payload mà chỉ bổ sung

Ví dụ:

- inputPreview: `{"path":"package.json"}`
- resultPreview: `{"content":"{\n  \"name\": ..."}`

## CLI configuration design

### Flag CLI

Thêm flag:

- `--debug-log <path>`

Flag này chỉ định file JSONL debug log.

### Env fallback

Thêm env fallback:

- `QICLAW_DEBUG_LOG`

CLI resolve config theo thứ tự ưu tiên:

1. `--debug-log`
2. `QICLAW_DEBUG_LOG`
3. disabled

Thiết kế này phù hợp với nhu cầu “cả hai — ưu tiên flag, env/config làm default fallback”.

### Path handling

- path được resolve ở CLI layer
- parent directory cần được tạo nếu chưa có
- logger dùng file append như hiện tại

Thiết kế hiện tại chưa thêm rotation hay cleanup policy.

## Phân bổ trách nhiệm theo file

### [src/telemetry/observer.ts](src/telemetry/observer.ts)

- mở rộng shape `TelemetryEvent` data cho event tool
- giữ helper `createTelemetryEvent(...)`
- nếu cần, định nghĩa type helper cho payload từng nhóm event để code bớt mơ hồ

### [src/telemetry/logger.ts](src/telemetry/logger.ts)

- giữ `JsonLineWriter` và JSONL append behavior
- có thể giữ nguyên logger core, vì redaction nên diễn ra trước khi event được ghi
- nếu cần, bổ sung constructor/helper dành riêng cho debug logger nhưng không bắt buộc

### Thư mục [src/telemetry/](src/telemetry/)

Thêm các module nhỏ mới nếu cần:

- composite observer
- display observer
- redaction utility
- preview builder

Mỗi module chỉ nên có một trách nhiệm rõ ràng, tránh gộp tất cả vào `logger.ts`.

### [src/agent/loop.ts](src/agent/loop.ts)

- enrich telemetry payload cho `tool_call_started` và `tool_call_completed`
- lấy dữ liệu từ `toolCall.input` và `toolResult.content`/`toolResult.isError`
- đảm bảo payload debug được redact trước khi đưa vào event

### [src/cli/main.ts](src/cli/main.ts)

- parse `--debug-log`
- đọc fallback từ `QICLAW_DEBUG_LOG`
- compose observer:
  - metrics
  - display observer
  - debug JSONL observer khi bật
- inject composite observer vào runtime

## Data flow

### Khi chạy bình thường, không bật debug file

1. CLI parse args/env
2. CLI tạo metrics observer
3. CLI tạo display observer
4. CLI compose thành một observer
5. runtime dùng observer đó
6. `runAgentTurn(...)` emit event
7. display observer in status gọn, metrics observer cập nhật counters

### Khi bật debug file

1. CLI parse được `--debug-log` hoặc `QICLAW_DEBUG_LOG`
2. CLI tạo thêm file JSONL writer + debug logger observer
3. CLI compose metrics + display + debug logger
4. `runAgentTurn(...)` emit event tool có payload chi tiết đã redact
5. display observer chỉ in status gọn
6. debug logger ghi toàn bộ event ra file JSONL

## Error handling

- nếu `--debug-log` thiếu value: CLI báo lỗi parse như các flag hiện có
- nếu path log không ghi được: CLI fail fast khi set up logger, in lỗi ra `stderr`, trả exit code `1`
- lỗi trong tool execution vẫn được chuẩn hóa như hiện tại; `tool_call_completed` phải phản ánh `isError`
- `turn_failed` tiếp tục là event terminal cho lỗi bất ngờ

## Testing strategy

### Unit tests cho telemetry helpers

Thêm test cho:

- composite observer fan-out đúng số observer
- display observer chỉ in message gọn đúng event cần thiết
- redaction utility redact đúng các key nhạy cảm, kể cả lồng nhau
- preview builder truncate/serialize deterministic

### Loop integration tests

Mở rộng test ở [tests/agent/loop.test.ts](tests/agent/loop.test.ts) để assert:

- `tool_call_started` có `inputPreview` và `inputRawRedacted`
- `tool_call_completed` có `resultPreview` và `resultRawRedacted`
- dữ liệu nhạy cảm trong input/result bị redact trước khi vào event

### CLI tests

Mở rộng test ở [tests/cli/repl.test.ts](tests/cli/repl.test.ts) hoặc test CLI tương ứng để assert:

- parse `--debug-log`
- env fallback `QICLAW_DEBUG_LOG`
- precedence flag > env
- CLI display chỉ in summary, không in raw payload
- debug logger ghi JSONL event đầy đủ khi bật

## Trade-offs và quyết định

### Vì sao không để debug logger tự redact trong logger layer

Nếu logger tự redact, các observer khác vẫn có thể vô tình nhận raw payload. Redact sớm khi xây event debug giúp giảm nguy cơ rò dữ liệu và giữ semantics nhất quán hơn cho dữ liệu chi tiết.

### Vì sao không chỉ log preview mà bỏ raw redacted payload

Chỉ preview thì không đủ để debug những case tool input/result phức tạp. Cần giữ payload đầy đủ đã redact trong JSONL để có thể truy vết chính xác hơn.

### Vì sao không cho CLI hiển thị preview luôn

Yêu cầu của user là giao diện CLI phải gọn và ít rò dữ liệu. Hiển thị preview có thể hữu ích nhưng tăng nguy cơ lộ dữ liệu file path, snippets, hoặc token-like content. Vì vậy bản đầu nên chỉ hiển thị tên tool và trạng thái.

## Scope check

Thiết kế này vẫn đủ nhỏ cho một implementation plan duy nhất vì chỉ mở rộng telemetry pipeline hiện có, không thêm subsystem độc lập mới. Công việc chủ yếu nằm trong năm vùng: event shape, redaction/preview helper, observer composition, CLI config, và test coverage.

## Kết luận

Thiết kế được chốt là một **dual-channel telemetry pipeline**:

- một kênh summary cho CLI để hiển thị tool activity gọn
- một kênh JSONL debug file để lưu event đầy đủ đã redact

Cả hai cùng dựa trên observer pipeline hiện có và được drive bởi `runAgentTurn(...)` trong [src/agent/loop.ts](src/agent/loop.ts). Đây là cách gần nhất với mục tiêu “CLI gọn như telemetry hiện tại, nhưng debug log đầy đủ như transcript nội bộ” mà vẫn giữ codebase nhỏ, deterministic và testable.