# OpenAI Provider Streaming Design

## Goal
Thêm streaming support ở mức provider nội bộ cho OpenAI, với `AsyncIterable` là chuẩn nội bộ. `generate()` và `stream()` phải biểu diễn cùng một semantic model để tránh lệch hành vi giữa stream và non-stream.

## Current state
- [src/provider/openai.ts](src/provider/openai.ts) hiện chỉ gọi `client.responses.create(...)` với `stream: false` và tự normalize trực tiếp sang `ProviderResponse`.
- [src/provider/model.ts](src/provider/model.ts) hiện chỉ có contract `generate(request): Promise<ProviderResponse>`.
- OpenAI-compatible streaming đang hoạt động, nhưng non-stream assembly bị rỗng assistant text trong một số endpoint; điều này cho thấy rủi ro khi stream và non-stream đi hai đường normalize khác nhau.
- [tests/provider/openai.test.ts](tests/provider/openai.test.ts) mới phủ request builder và metadata normalization cho non-stream path.

## Requirements
1. Thêm `stream()` ở provider contract nội bộ.
2. `AsyncIterable` là primitive nội bộ chuẩn; callback chỉ là adapter ở lớp trên.
3. `generate()` trả final `ProviderResponse`.
4. `stream()` trả normalized event stream.
5. `generate()` và `stream()` phải cùng semantic model; không được normalize theo hai schema độc lập.
6. OpenAI provider hỗ trợ stream thật bằng Responses API.
7. Provider chưa hỗ trợ stream phải báo lỗi rõ ràng, không silent fallback.
8. Scope của thay đổi này là provider nội bộ; chưa bắt buộc đổi toàn bộ runtime để dùng stream end-to-end ngay.

## Recommended approach
Chuẩn hóa một semantic model event nội bộ trong `src/provider/model.ts`, để `stream()` phát `AsyncIterable<NormalizedEvent>` và `generate()` chỉ là bước collect + assemble từ cùng semantic model đó.

### Why this approach
- Loại bỏ nguy cơ stream đúng nhưng non-stream assemble sai do đi hai codepath normalize khác nhau.
- Giữ `AsyncIterable` làm abstraction trung tâm giúp dễ compose, bridge ra callback, SSE, hoặc final JSON.
- Dễ áp dụng cho các adapter OpenAI-compatible sau này: cùng một luồng normalized events có thể vừa stream ra client vừa collect thành response cuối.
- Tạo capability stream chung ở provider layer mà không ép runtime hiện tại phải chuyển toàn bộ sang streaming ngay lập tức.

## Approaches considered

### 1. Thêm stream riêng cho OpenAI, giữ non-stream normalize cũ
- Ưu điểm: patch nhỏ nhất.
- Nhược điểm: stream/non-stream tiếp tục lệch semantics, tái tạo đúng loại bug đang gặp.
- Kết luận: không chọn.

### 2. Thêm interface stream chung nhưng vẫn để mỗi nhánh assemble riêng
- Ưu điểm: tốt hơn hiện trạng, ít đụng hơn kiến trúc thống nhất hoàn toàn.
- Nhược điểm: vẫn còn hai đường logic tổng hợp kết quả cuối.
- Kết luận: không chọn.

### 3. Một semantic model chung: stream là nguồn chân lý, generate collect từ stream
- Ưu điểm: an toàn nhất về kiến trúc, giảm drift, dễ debug và mở rộng.
- Nhược điểm: phải sửa contract provider và một số callsite/type liên quan.
- Kết luận: chọn.

## Design

### 1. Unified semantic model
`stream()` là nguồn chân lý cho provider output. `generate()` không tự normalize raw provider response riêng nữa, mà sẽ thu thập các event từ cùng semantic model rồi assemble thành `ProviderResponse`.

Luồng dữ liệu mục tiêu:

```text
raw provider response
-> normalize thành AsyncIterable<NormalizedEvent>
-> stream(): expose events
-> generate(): collect events -> ProviderResponse
```

Nguyên tắc bắt buộc:
- mọi text cuối trong `ProviderResponse.message.content` phải là kết quả ghép từ các text events tương ứng
- mọi `toolCalls` cuối trong `ProviderResponse` phải đến từ cùng event stream
- metadata cuối (`finish`, `usage`, `responseMetrics`, `debug`) phải đến từ event kết thúc cùng semantic model đó

### 2. Event model
Thêm một event union tối thiểu nhưng đủ để biểu diễn output hiện tại:

```ts
type NormalizedEvent =
  | { type: 'start'; provider: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'finish';
      finish?: ProviderFinishSummary;
      usage?: ProviderUsageSummary;
      responseMetrics?: ProviderResponseMetrics;
      debug?: ProviderDebugMetadata;
    }
  | { type: 'error'; error: unknown };
```

Decision notes:
- Dùng `text_delta` thay vì `delta` chung chung để semantic rõ ràng.
- Không thêm `tool_result` ở provider layer hiện tại vì provider chỉ phát sinh tool call request; tool execution xảy ra ở runtime loop.
- `finish` event là nơi mang metadata cuối để `generate()` assemble ra `ProviderResponse`.
- `error` event dùng `unknown` thay vì `Error` để chịu được raw SDK/transport failure không tuân theo `Error` chuẩn.
- `tool_call.input` giữ là `Record<string, unknown>` vì ở codebase hiện tại tool call arguments đã được parse và validate như object JSON; nếu phát hiện provider nào có thể trả non-object JSON thì sẽ cần nới semantic model ở bước triển khai.

Event invariants:
- `start` được emit tối đa 1 lần cho mỗi provider stream.
- `finish` và `error` loại trừ nhau; mỗi loại tối đa 1 lần.
- Sau `finish` hoặc `error` không được có event nào khác nữa.
- `tool_call` chỉ được emit khi arguments đã parse thành object hợp lệ.
- `generate()` và `collectProviderStream()` phải xem vi phạm invariant là lỗi implementation, không silently sửa nghĩa của stream.

### 3. Provider contract changes
Mở rộng [src/provider/model.ts](src/provider/model.ts):

- giữ `generate(request): Promise<ProviderResponse>` để bảo toàn callsites hiện tại
- thêm `stream(request): AsyncIterable<NormalizedEvent>`
- thêm helper collect, ví dụ `collectProviderStream(stream): Promise<ProviderResponse>`

Contract mong muốn:

```ts
interface ModelProvider {
  name: string;
  model: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest): AsyncIterable<NormalizedEvent>;
}
```

Và helper nội bộ:

```ts
async function collectProviderStream(
  stream: AsyncIterable<NormalizedEvent>
): Promise<ProviderResponse>
```

Quy tắc:
- Provider hỗ trợ stream thật sẽ implement `stream()`.
- `generate()` nên dùng `collectProviderStream(this.stream(request))` hoặc tương đương, không tự normalize schema khác.
- Provider chưa hỗ trợ stream phải throw lỗi rõ ràng từ `stream()`.

### 4. OpenAI provider implementation
Trong [src/provider/openai.ts](src/provider/openai.ts):

#### 4.1. Request path
- Giữ builder request hiện có làm nền tảng.
- Bổ sung request builder hoặc option cho mode `stream: true` khi gọi OpenAI Responses API.
- Không để request schema stream và non-stream drift theo thời gian; hai mode phải dùng cùng cách build instructions, input conversation, tools.

#### 4.2. Event normalization
Map raw OpenAI Responses stream events sang `NormalizedEvent`:
- emit `start` khi stream bắt đầu
- với text output fragments, emit `text_delta`
- khi function call hoàn chỉnh và parse được arguments, emit `tool_call`
- khi stream kết thúc, emit `finish` với `finish`, `usage`, `responseMetrics`, `debug`

Các metadata cuối phải dùng cùng logic semantic với path non-stream hiện có:
- `finish.stopReason`
- `usage.inputTokens`, `outputTokens`, `totalTokens`, `cacheReadInputTokens`
- `responseMetrics.contentBlockCount`, `toolCallCount`, `hasTextOutput`, `contentBlocksByType`
- `debug.providerUsageRawRedacted`, `providerStopDetails`, `toolCallSummaries`, `responseContentBlocksByType`, `responsePreviewRedacted`

Nếu OpenAI streaming SDK phát các event nhỏ hơn block-level, provider sẽ phải giữ state cục bộ để:
- ghép text fragments thành đúng text deltas mong muốn
- chỉ emit `tool_call` khi arguments đã đủ để parse thành object hợp lệ
- tính response metrics và debug snapshot cuối trước khi emit `finish`

#### 4.3. generate() behavior
`generate()` của OpenAI provider không nên tự gọi `client.responses.create(... stream: false)` rồi normalize độc lập như hiện tại. Thay vào đó:
- gọi `stream(request)`
- collect events
- assemble final `ProviderResponse`

Điều này là ràng buộc kiến trúc chính của thay đổi.

### 5. Non-stream assembly from the same model
`collectProviderStream()` sẽ chịu trách nhiệm:
- nối toàn bộ `text_delta` thành `message.content`
- thu toàn bộ `tool_call` thành `toolCalls`
- lấy metadata cuối từ `finish`
- dựng `responseMetrics.hasTextOutput` từ text đã nhận nếu cần kiểm tra consistency
- trả về `normalizeProviderResponse(...)`

Nếu stream kết thúc mà không có text, không có tool call, và cũng không có finish hợp lệ đủ để mô tả completion, helper phải báo lỗi rõ ràng thay vì trả response rỗng khó debug.

### 6. Unsupported providers
Trong [src/provider/anthropic.ts](src/provider/anthropic.ts):
- thêm `stream()` nhưng tạm thời throw lỗi như `Anthropic provider does not support streaming yet.`
- không fallback sang `generate()` một cách im lặng

Mục tiêu là capability rõ ràng, tránh caller tưởng đang dùng stream thật trong khi thực tế không phải.

### 7. Adapters above provider layer
Không đưa callback vào core provider contract.

Core giữ:
- `AsyncIterable<NormalizedEvent>`

Lớp trên hoặc utility layer có thể thêm sau:
- `consumeWithCallback(stream, handlers)`
- `collectProviderStream(stream)`
- `toOpenAIStream(stream)`
- `toNonStreamResponse(stream)`

Những adapter này không thuộc primitive chính của provider contract.

## Files to modify
- `src/provider/model.ts`
  - thêm `NormalizedEvent`
  - thêm method `stream()` vào `ModelProvider`
  - thêm helper collect stream thành `ProviderResponse`
- `src/provider/openai.ts`
  - thêm implementation `stream()`
  - refactor `generate()` để assemble từ stream semantic model
  - giữ request builder stream/non-stream thống nhất semantics
- `src/provider/anthropic.ts`
  - thêm `stream()` báo lỗi chưa hỗ trợ
- `src/provider/factory.ts`
  - cập nhật type nếu cần
- `src/agent/runtime.ts`
  - chỉ cập nhật nếu cần để tương thích contract mới
- `src/agent/loop.ts`
  - chỉ cập nhật nếu cần để tương thích type, chưa bắt buộc dùng stream path mới ngay
- `tests/provider/openai.test.ts`
  - thêm tối thiểu 1 parity test nhỏ xác nhận `collectProviderStream(provider.stream(req))` tương đương `provider.generate(req)` cho cùng một request đại diện

## Error handling
1. Nếu caller gọi `stream()` trên provider chưa hỗ trợ: throw lỗi rõ ràng.
2. Nếu OpenAI stream không phát được text/tool calls/finish hợp lệ: throw lỗi incomplete stream.
3. Nếu arguments của function call parse lỗi trong lúc normalize: fail stream rõ ràng, không nuốt lỗi.
4. Nếu finish metadata mâu thuẫn với dữ liệu đã collect, ưu tiên báo lỗi hoặc tối thiểu giữ invariant assemble nhất quán thay vì silently trả response méo.

## Verification strategy
Verification tối thiểu gồm:
1. build/typecheck sạch
2. xác nhận `generate()` của OpenAI assemble từ cùng semantic model với `stream()`
3. rà type/provider contract để provider chưa hỗ trợ stream fail rõ ràng
4. đảm bảo không còn hai schema normalize độc lập cho OpenAI provider
5. thêm ít nhất 1 parity test nhỏ xác nhận `collectProviderStream(provider.stream(req))` tương đương `provider.generate(req)` cho cùng request đại diện

Không cần mở rộng test suite lớn trong đợt này, nhưng parity test trên là điểm chốt hành vi của thiết kế.

## Risks and mitigations
- **Rủi ro drift giữa raw event mapping và final response assembly:** giảm bằng cách dùng `stream()` làm nguồn chân lý và `generate()` chỉ collect.
- **Rủi ro event model quá nghèo cho nhu cầu tương lai:** giữ union nhỏ nhưng có thể mở rộng bằng variant mới mà không phá primitive hiện tại.
- **Rủi ro OpenAI stream event shape phức tạp:** chấp nhận state cục bộ trong provider để chỉ emit semantic event ổn định.
- **Rủi ro caller nhầm provider nào cũng support stream:** contract `stream()` trên provider chưa hỗ trợ phải throw lỗi rõ ràng.
- **Rủi ro runtime hiện tại chưa tiêu thụ stream:** scope lần này giới hạn ở provider layer, nên chỉ yêu cầu tương thích type và nền móng adapter.

## Explicit decisions
- `AsyncIterable` là primitive nội bộ chuẩn.
- Callback không là primitive chính; chỉ là adapter.
- `generate()` và `stream()` phải chia sẻ cùng semantic model.
- OpenAI là provider đầu tiên hỗ trợ stream thật.
- Provider chưa hỗ trợ stream phải báo lỗi rõ ràng, không silent fallback.
- Non-stream về kiến trúc là kết quả collect từ cùng normalized event stream.
