# Provider context metrics design

## Mục tiêu

Bổ sung telemetry đo kích thước prompt và metadata response hữu ích hơn cho việc phân tích context usage của CLI runtime.

Thiết kế này phải giúp trả lời ba câu hỏi vận hành:

1. prompt hiện tại lớn cỡ nào ở mức payload ký tự
2. provider đã phản hồi với usage / stop reason / tool activity như thế nào
3. sau này có đủ bằng chứng để tối ưu context, tool call, và tool result hay chưa

Thiết kế tiếp tục bám vào observer pipeline hiện có, giữ event stream chung gọn, và chỉ đẩy chi tiết hơn vào file debug JSONL.

## Bối cảnh hiện tại

Telemetry hiện đã có các event provider cơ bản trong [src/agent/loop.ts](src/agent/loop.ts), nhưng `provider_called` mới chỉ log `messageCount` và danh sách tool names, còn `provider_responded` mới chỉ log số tool call và độ dài text assistant ở mức rất hạn chế.

Điều này chưa đủ để:

- ước lượng kích thước payload prompt theo thời gian
- đối chiếu chars với token usage khi provider có trả về usage
- nhìn ra model đang dừng vì hết ngữ cảnh, chạm max tokens, hay hoàn thành bình thường
- đo xem response thiên về text hay tool use

Codebase đã có sẵn nền tảng phù hợp để mở rộng:

- [src/telemetry/observer.ts](src/telemetry/observer.ts): contract event/observer
- [src/telemetry/logger.ts](src/telemetry/logger.ts): JSONL logger append-only
- [src/telemetry/redaction.ts](src/telemetry/redaction.ts): redaction mặc định cho dữ liệu nhạy cảm
- [src/telemetry/preview.ts](src/telemetry/preview.ts): deterministic serialization cho preview
- [src/provider/model.ts](src/provider/model.ts): normalized provider response chung cho runtime
- [src/provider/anthropic.ts](src/provider/anthropic.ts) và [src/provider/openai.ts](src/provider/openai.ts): nơi gần raw provider response nhất

## Non-goals

Thiết kế này cố ý không làm các phần sau:

- không biến telemetry thành transcript request/response đầy đủ của provider
- không cố xây token estimator nội bộ
- không thêm dashboard, storage backend, hay analytics pipeline mới
- không yêu cầu mọi provider phải có đầy đủ metrics; thiếu field thì để `undefined`
- không thay đổi CLI compact display hiện tại
- không log raw secrets hoặc bypass redaction mặc định

## Approach được chọn

Chọn hướng **event stream chung tối thiểu, file debug đầy đủ hơn**.

Cụ thể:

- event chung vẫn chỉ mang summary nhỏ, đủ để consumer khác dùng mà không bị nặng
- file debug JSONL nhận cùng event đó nhưng có thêm chi tiết debug đã chuẩn hóa và redact
- logic chuẩn hóa dữ liệu provider nằm gần runtime/provider layer, không để CLI tự suy luận

Lý do chọn hướng này:

- đúng với yêu cầu “summary ở stream chung, chi tiết ở file debug”
- giữ observer contract hiện tại ổn định
- vẫn tạo đủ bằng chứng để đo context và tối ưu tool behavior về sau
- tránh phình `TelemetryEvent` chung thành payload quá lớn

## So sánh các approach khác

### Approach A — Summary ở event chung, debug details trong JSONL (**chọn**)

- Ưu điểm:
  - cân bằng tốt giữa chi phí event và giá trị debug
  - không làm consumer chung phải mang payload nặng
  - phù hợp nhất với yêu cầu hiện tại
- Nhược điểm:
  - cần thêm lớp normalize metrics theo provider
  - cần tách rõ field nào là summary, field nào là debug-only

### Approach B — Nhét toàn bộ metadata vào `provider_responded`

- Ưu điểm:
  - nhìn một event là thấy gần hết dữ liệu
- Nhược điểm:
  - event chung nặng nhanh
  - contract khó ổn định giữa các provider
  - tăng nguy cơ rò dữ liệu hoặc log quá tay

### Approach C — Thêm event types mới cho usage/context/tool metrics

- Ưu điểm:
  - semantic rất rõ
  - dễ tách consumer sau này
- Nhược điểm:
  - scope lớn hơn mức cần thiết
  - tăng complexity cho loop, tests, và typings

## Thiết kế kiến trúc

### 1. Mở rộng `provider_called`

`provider_called` tiếp tục được emit trước khi gọi model, nhưng sẽ được enrich thành hai lớp dữ liệu.

#### Event summary chung

Event chung chỉ giữ các field nhỏ và ổn định:

- `messageCount`: số message gửi vào provider
- `promptRawChars`: tổng số ký tự của toàn bộ `prompt.messages` sau khi serialize ổn định
- `toolNames`: danh sách tool runtime cho phép ở turn đó

`promptRawChars` là metric payload-size ở mức ký tự, không phải token, và được giữ như số đo tương đối để theo dõi xu hướng tăng giảm context.

#### Debug details cho JSONL

Khi event được ghi vào file debug, phần `provider_called` sẽ có thêm chi tiết như:

- `messageSummaries`
  - `role`
  - `rawChars`
  - `contentBlockCount`
- `totalContentBlockCount`
- `hasSystemPrompt`
- `promptRawPreviewRedacted` nếu cần preview ngắn để debug

Không ghi full raw prompt transcript vào event chung. Nếu có preview/debug payload thì phải redact trước khi emit.

### 2. Mở rộng `provider_responded`

`provider_responded` tiếp tục là event sau khi provider trả về, nhưng sẽ có summary chuẩn hóa hữu ích hơn cho việc đo context và tối ưu tool behavior.

#### Event summary chung

Event chung nên có các field sau khi lấy được:

- `stopReason`
- `usage.inputTokens`
- `usage.outputTokens`
- `usage.totalTokens`
- `responseContentBlockCount`
- `toolCallCount`
- `hasTextOutput`

Các field này đủ để nhìn nhanh:

- response có text hay chỉ tool use
- model đang gọi tool nhiều hay ít
- usage tokens có tương quan thế nào với `promptRawChars`
- stop reason có gợi ý giới hạn context/max tokens hay không

#### Debug details cho JSONL

Debug log có thể giữ thêm metadata đã normalize như:

- `responseContentBlocksByType`
- `toolCallSummaries`
- `providerUsageRawRedacted`
- `providerStopDetails`
- `responsePreviewRedacted`

Mục tiêu là giữ các field phục vụ debug context/tool behavior, chứ không dump toàn bộ raw provider response không chọn lọc.

### 3. Chuẩn hóa dữ liệu theo provider

Cần mở rộng normalized provider response trong [src/provider/model.ts](src/provider/model.ts) để runtime có thể đọc metadata chung thay vì đoán theo từng provider tại [src/agent/loop.ts](src/agent/loop.ts).

Đề xuất thêm metadata normalized vào `ProviderResponse`, ví dụ theo nhóm sau:

- `finish`
  - `stopReason`
- `usage`
  - `inputTokens`
  - `outputTokens`
  - `totalTokens`
- `responseMetrics`
  - `contentBlockCount`
  - `toolCallCount`
  - `hasTextOutput`
  - `contentBlocksByType`
- `debug`
  - `providerRawMetadataRedacted`
  - `toolCallSummaries`

Anthropic và OpenAI adapter sẽ tự map dữ liệu raw sang shape chung này khi provider SDK có trả field tương ứng. Nếu provider không có field nào đó thì để `undefined` thay vì bịa số.

### 4. Helper đo prompt payload

Cần thêm helper telemetry nhỏ trong [src/telemetry/](src/telemetry/) để tính `promptRawChars` và summary message-level một cách deterministic.

Helper này nên:

- serialize toàn bộ `prompt.messages` bằng deterministic ordering giống hướng preview hiện có
- trả về `promptRawChars`
- tạo `messageSummaries[]`
- đếm `totalContentBlockCount`
- xác định `hasSystemPrompt`

Điểm quan trọng là metric phải ổn định giữa các lần chạy cùng payload. Mục tiêu ở đây không phải tối ưu CPU tuyệt đối mà là số đo nhất quán để so sánh trend.

### 5. Redaction boundary

Mọi debug detail lấy từ provider response hoặc prompt preview đều phải đi qua redaction utility hiện có trước khi đưa vào telemetry event.

Nguyên tắc:

- event summary chung không chứa raw prompt/raw response
- debug details chỉ giữ những phần phục vụ debug context/tool optimization
- bất kỳ field nhạy cảm nào trong provider metadata cũng bị mask theo rule mặc định hiện có

Điều này giữ nhất quán với hướng dual-channel telemetry đã chốt trước đó.

## Data flow

### Khi emit `provider_called`

1. [src/agent/loop.ts](src/agent/loop.ts) build prompt như hiện tại
2. helper mới tính prompt payload metrics từ `prompt.messages`
3. loop emit `provider_called` với summary chung
4. nếu observer debug logger đang bật, cùng event đó sẽ mang thêm debug detail đã redact

### Khi emit `provider_responded`

1. provider adapter trả `ProviderResponse` đã normalize thêm metadata
2. [src/agent/loop.ts](src/agent/loop.ts) đọc metadata normalized này
3. loop emit `provider_responded` với summary fields nhỏ
4. debug logger ghi thêm detail fields đã redact nếu có

## Phân bổ trách nhiệm theo file

### [src/provider/model.ts](src/provider/model.ts)

- mở rộng `ProviderResponse` để mang metadata normalized
- thêm typed interfaces cho usage, finish, response metrics, debug metadata
- giữ `normalizeProviderResponse(...)` là điểm tạo shape thống nhất

### [src/provider/anthropic.ts](src/provider/anthropic.ts)

- map usage/stop reason/content block metrics từ Anthropic SDK response
- tạo tool call summaries và content-block counts phù hợp
- redact trước khi đưa raw metadata hữu ích vào debug payload

### [src/provider/openai.ts](src/provider/openai.ts)

- map usage/finish reason/output structure từ OpenAI Responses API
- đếm output content blocks, tool calls, hasTextOutput
- chuẩn hóa usage/debug metadata giống contract chung

### [src/agent/loop.ts](src/agent/loop.ts)

- tính `promptRawChars` và prompt summaries trước khi gọi provider
- emit `provider_called` với summary + debug details
- emit `provider_responded` với summary fields chuẩn hóa từ provider response

### [src/telemetry/observer.ts](src/telemetry/observer.ts)

- thay `Record<string, unknown>` bằng typed payload interfaces cho `provider_called` và `provider_responded`
- vẫn giữ event creation API hiện tại

### Thư mục [src/telemetry/](src/telemetry/)

Thêm helper mới, ví dụ:

- `providerMetrics.ts`
  - prompt char counting
  - prompt message summaries
  - helper normalize debug detail boundaries nếu cần

Không cần thêm observer mới hay đổi logger format.

## Error handling

- nếu prompt metrics helper gặp giá trị serialize không ra string, phải fallback an toàn giống policy preview hiện có
- nếu provider không trả usage/finish metadata, event vẫn được emit với các field còn lại
- nếu provider metadata có shape lạ, adapter phải normalize phần biết được và bỏ qua phần còn lại thay vì throw
- telemetry enrichment không được làm hỏng luồng chính của agent turn chỉ vì thiếu metric phụ

## Testing strategy

### Unit tests cho prompt metrics helper

Thêm test để verify:

- `promptRawChars` ổn định với nested payload
- `messageSummaries` đếm đúng chars theo từng message
- `contentBlockCount` đúng cho cả content string và content arrays nếu có
- `hasSystemPrompt` phản ánh đúng presence của system messages

### Provider adapter tests

Mở rộng test cho [src/provider/anthropic.ts](src/provider/anthropic.ts) và [src/provider/openai.ts](src/provider/openai.ts) để assert:

- usage được map đúng khi provider có trả về
- stop/finish reason được normalize đúng
- response block metrics đúng với message/tool-call mix
- thiếu metadata không làm adapter fail

### Loop integration tests

Mở rộng [tests/agent/loop.test.ts](tests/agent/loop.test.ts) để assert:

- `provider_called` có `promptRawChars`
- `provider_called` debug details có `messageSummaries`
- `provider_responded` có `stopReason`, usage summary, `responseContentBlockCount`, `toolCallCount`, `hasTextOutput`
- debug detail fields chỉ xuất hiện trong event payload theo contract đã định

### CLI / JSONL tests

Mở rộng [tests/cli/repl.test.ts](tests/cli/repl.test.ts) để assert:

- JSONL log chứa metric mới trong `provider_called` và `provider_responded`
- CLI compact display không thay đổi output contract
- prompt mode vẫn không in thêm telemetry summary ngoài final answer

## Trade-offs và quyết định

### Vì sao dùng `promptRawChars` thay vì token estimate nội bộ

Token estimate nội bộ dễ gây nhầm là số usage chính xác. `promptRawChars` rõ ràng hơn: đây là số đo payload-size tương đối, ổn định, rẻ, và hữu ích để so xu hướng với token usage thật mà provider trả về.

### Vì sao normalize metadata ở provider layer

Provider adapters là nơi gần raw SDK response nhất. Chuẩn hóa ở đây giúp [src/agent/loop.ts](src/agent/loop.ts) chỉ tiêu thụ một contract chung, tránh đầy `if provider === ...` trong loop.

### Vì sao không log toàn bộ raw provider response

Raw dump tạo nhiều nhiễu, tăng nguy cơ lộ dữ liệu, và khó giữ stable contract giữa providers. Chỉ log metadata liên quan trực tiếp đến context/tool optimization là đủ cho mục tiêu hiện tại.

## Scope check

Phạm vi này vẫn phù hợp cho một implementation plan đơn:

- mở rộng typed provider response
- thêm helper đo prompt payload
- enrich 2 event provider
- cập nhật test coverage ở helper/provider/loop/CLI

Nó chưa đủ lớn để cần tách thành subsystem riêng.

## Kết luận

Thiết kế được chốt là:

- `provider_called` có summary chung gồm `messageCount`, `promptRawChars`, `toolNames`
- `provider_responded` có summary chung gồm stop reason, usage summary, response/tool metrics
- file debug JSONL giữ thêm detail fields đã normalize và redact
- provider adapters chịu trách nhiệm trích xuất metadata hữu ích từ SDK response
- runtime loop vẫn là nơi emit event trung tâm

Kết quả là telemetry sẽ trả lời tốt hơn câu hỏi về kích thước prompt, usage thực tế, và hành vi tool/text của model, đồng thời vẫn giữ event stream chung gọn và an toàn.