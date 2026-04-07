# CLI Turn Streaming Design

## Goal
Làm CLI interactive/REPL stream được assistant text theo thời gian thực và hiển thị live tool activity trong khi vẫn giữ final answer hiện tại đúng semantics với agent turn hiện có.

## Current state
- [src/provider/openai.ts](src/provider/openai.ts) đã hỗ trợ provider-level stream bằng `AsyncIterable<NormalizedEvent>`.
- [src/agent/loop.ts](src/agent/loop.ts) hiện vẫn vận hành theo model final-result: gọi provider, xử lý tool loop, rồi trả `RunAgentTurnResult` sau khi turn kết thúc.
- [src/cli/repl.ts](src/cli/repl.ts) hiện chờ `runOnce()` hoàn tất rồi mới nhận `finalAnswer`.
- [src/cli/main.ts](src/cli/main.ts) đã có UI state cho provider thinking/responding và writer cho assistant block, nhưng vẫn render chủ yếu ở cuối turn qua `writeAssistantTextBlock(...)`.
- Điều này tạo ra một khoảng trống kiến trúc: provider stream đã tồn tại, nhưng CLI chưa có turn-level event stream để tiêu thụ trực tiếp.

## Requirements
1. CLI interactive/REPL phải render assistant text dần theo thời gian thực.
2. CLI phải hiển thị live tool activity tối thiểu: bắt đầu gọi tool và hoàn tất tool.
3. Final answer sau khi collect xong phải giữ nguyên semantics với `runAgentTurn()` hiện tại.
4. Không để CLI consume raw provider event thô; việc normalize lifecycle của một agent turn phải xảy ra ở agent loop.
5. Không thay đổi provider contract thêm lần nữa; primitive provider vẫn là `AsyncIterable<NormalizedEvent>`.
6. Scope đầu tiên chỉ cần hỗ trợ interactive CLI/REPL; chưa bắt buộc non-interactive format khác.
7. Lỗi stream hoặc vi phạm invariant phải fail rõ ràng; không silently repair ở UI.
8. Live path và final path phải có parity để tránh lỗi kiểu “stream đúng, final sai”.

## Recommended approach
Thêm một tầng event mới ở agent loop: `AsyncIterable<TurnEvent>`. Provider stream vẫn là nguồn dữ liệu ở tầng model provider, còn agent loop sẽ chuyển nó thành turn-level lifecycle event để CLI/REPL render trực tiếp. `runAgentTurn()` trở thành wrapper collect từ `runAgentTurnStream()` để giữ backward compatibility cho callsites đang cần final result.

### Why this approach
- Chạm đúng ranh giới vấn đề: CLI cần stream của cả text lẫn tool activity, đây không còn là concern riêng của provider.
- Giữ CLI đơn giản: CLI chỉ render từ `TurnEvent`, không phải hiểu OpenAI/Anthropic provider event shape.
- Giữ được semantic parity: final result được collect từ cùng turn event flow thay vì đi codepath độc lập.
- Scope vừa đủ: không cần refactor toàn bộ runtime thành stream-first end-to-end ngay lập tức.

## Approaches considered

### 1. CLI consume provider stream trực tiếp
- Ưu điểm: ít đổi ở agent loop.
- Nhược điểm: CLI phải hiểu provider event, tool loop, và quy tắc assemble assistant message.
- Kết luận: không chọn.

### 2. Turn-level event stream ở agent loop, `runAgentTurn()` collect từ đó
- Ưu điểm: đúng layer, dễ test, giữ parity giữa live path và final path.
- Nhược điểm: phải thêm event contract và refactor một phần loop/REPL.
- Kết luận: chọn.

### 3. Refactor toàn runtime thành stream-first duy nhất
- Ưu điểm: sạch nhất dài hạn.
- Nhược điểm: scope lớn hơn đáng kể so với nhu cầu hiện tại.
- Kết luận: chưa chọn ở vòng này.

## Design

### 1. New turn-level semantic model
Thêm một union riêng cho lifecycle của một agent turn, tách biệt với `NormalizedEvent` ở provider layer.

```ts
type TurnEvent =
  | { type: 'turn_started' }
  | { type: 'provider_started'; provider: string; model: string }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'tool_call_started'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_completed'; id: string; name: string; resultPreview: string; isError: boolean }
  | { type: 'assistant_message_completed'; text: string; toolCalls?: ToolCallRequest[] }
  | { type: 'turn_completed'; finalAnswer: string; stopReason?: string }
  | { type: 'turn_failed'; error: unknown };
```

Decision notes:
- `assistant_text_delta` là event UI-level cho text đã sẵn sàng render, không lộ raw provider delta shape.
- `assistant_message_completed` đánh dấu kết thúc một assistant message trong turn hiện tại, giúp CLI biết khi nào chốt block/render state.
- `tool_call_completed.resultPreview` chỉ là preview an toàn cho UI, không thay thế tool result thật trong conversation state.
- `turn_completed.finalAnswer` là giá trị chuẩn cuối cùng tương đương `RunAgentTurnResult.finalAnswer` hiện tại.
- `turn_failed.error` dùng `unknown` để chịu được mọi lỗi runtime/provider/tool.

### 2. Event invariants
Các invariant sau là bắt buộc:
- `turn_started` được emit đúng 1 lần cho mỗi turn stream.
- `provider_started` được emit tối đa 1 lần cho mỗi provider call trong round hiện tại.
- `assistant_text_delta` chỉ được emit sau `turn_started` và trước terminal event của turn.
- `tool_call_started` và `tool_call_completed` phải theo cặp cùng `id`; không được emit completed trước started.
- `assistant_message_completed.text` phải đúng bằng phép nối của toàn bộ `assistant_text_delta` đã emit cho assistant message đó.
- `turn_completed` và `turn_failed` loại trừ nhau; sau terminal event không được có event nào khác.
- Giá trị `turn_completed.finalAnswer` phải đúng bằng final answer mà đường non-stream hiện tại sẽ trả cho cùng input.

Nếu vi phạm invariant, agent loop phải throw lỗi implementation. CLI không tự sửa nghĩa event stream.

### 3. Loop architecture
Trong [src/agent/loop.ts](src/agent/loop.ts):
- thêm primitive mới, ví dụ `runAgentTurnStream(input): AsyncIterable<TurnEvent>`
- function này chịu trách nhiệm:
  - emit `turn_started`
  - gọi `provider.stream(...)`
  - map provider events thành `provider_started`, `assistant_text_delta`, `tool_call_started`
  - khi có tool call thì chạy tool như hiện tại, append tool result vào conversation, emit `tool_call_completed`
  - khi một assistant round hoàn tất, emit `assistant_message_completed`
  - sau khi toàn bộ tool loop kết thúc, emit `turn_completed`
- giữ `runAgentTurn(input)` như wrapper collect từ `runAgentTurnStream(input)` để trả `RunAgentTurnResult`

Luồng dữ liệu mục tiêu:

```text
provider.stream()
-> agent loop consumes provider events
-> emits AsyncIterable<TurnEvent>
-> branch A: CLI/REPL render live
-> branch B: runAgentTurn() collect -> RunAgentTurnResult
```

### 4. Message assembly rules
Agent loop phải là nơi assemble assistant message từ provider events.

Rules:
- Text của assistant message được tạo bằng cách nối mọi `assistant_text_delta` trong round hiện tại.
- Tool calls gắn với assistant message phải là đúng danh sách tool call đã emit trong round đó.
- Khi emit `assistant_message_completed`, loop phải đồng thời commit cùng message vào conversation state dùng cho round tiếp theo.
- `runAgentTurn()` khi collect từ turn stream phải dùng chính data đã commit này để dựng final result, không recompute từ nguồn khác.

Mục tiêu là một nguồn chân lý duy nhất cho cả live rendering và final result.

### 5. Tool activity model
CLI cần live tool activity nhưng không cần toàn bộ tool payload đầy đủ như log/debug.

Thiết kế đề xuất:
- `tool_call_started`: phát ngay khi provider yêu cầu tool, mang `id`, `name`, `input`
- `tool_call_completed`: phát sau khi tool chạy xong, mang:
  - `id`, `name`
  - `isError`
  - `resultPreview`: bản preview text đã serialize/rút gọn từ tool result hoặc error

`resultPreview` chỉ phục vụ UX. Conversation state vẫn lưu full tool result message như hiện tại.

### 6. REPL and CLI integration
Trong [src/cli/repl.ts](src/cli/repl.ts):
- mở rộng `runTurn` contract để có thể nhận turn stream hoặc callback nhận `TurnEvent`
- `runOnce()` không chỉ chờ final result, mà phải forward event cho caller/UI trong lúc turn đang chạy
- vẫn trả `ReplTurnResult` cuối cùng để giữ behavior hiện tại cho caller không cần live rendering

Trong [src/cli/main.ts](src/cli/main.ts):
- consume `TurnEvent` thay vì chỉ chờ `RunAgentTurnResult`
- mapping UI:
  - `turn_started` -> reset state cho assistant block mới
  - `provider_started` -> `startProviderThinking()`
  - first `assistant_text_delta` hoặc `tool_call_started` -> `markResponding()` nếu cần
  - `assistant_text_delta` -> append incremental text vào block hiện tại
  - `tool_call_started` / `tool_call_completed` -> render live activity/status
  - `assistant_message_completed` -> chốt block text hiện tại nếu writer cần flush
  - `turn_completed` -> đảm bảo final block nhất quán, kết thúc turn
  - `turn_failed` -> hiển thị lỗi và đóng trạng thái responding

CLI writer hiện có có thể cần thêm method append text theo delta thay vì chỉ `writeAssistantTextBlock(text)` nguyên khối.

### 7. Backward compatibility
- `runAgentTurn()` vẫn tồn tại và tiếp tục trả `Promise<RunAgentTurnResult>`.
- Callsite chưa dùng live streaming không phải đổi ngay.
- `runAgentTurn()` nội bộ sẽ collect từ `runAgentTurnStream()` để giữ semantics một nguồn chân lý.
- Provider contract hiện tại giữ nguyên phần đã thêm ở đợt trước; thay đổi mới nằm ở turn layer.

### 8. Error handling
1. Nếu provider stream ném lỗi: emit `turn_failed`, rồi kết thúc stream.
2. Nếu tool execution lỗi: emit `tool_call_completed` với `isError: true`, đồng thời đưa tool error message vào conversation như hiện tại để agent tiếp tục quyết định bước sau.
3. Nếu turn stream vi phạm invariant: fail fast ở agent loop.
4. CLI không swallow terminal error; chỉ render nó dưới dạng UX phù hợp.
5. Sau `turn_failed` hoặc `turn_completed`, writer phải đóng trạng thái responding/thinking ngay.

### 9. Verification strategy
Verification tối thiểu gồm 3 tầng:

#### 9.1. Agent loop tests
Thêm test cho turn stream:
- emit `assistant_text_delta` đúng thứ tự
- emit `tool_call_started` và `tool_call_completed` đúng thứ tự
- `assistant_message_completed.text` khớp text đã stream
- `turn_completed.finalAnswer` khớp final result collect path
- tool error path vẫn emit completion event với `isError: true`
- invariant violation gây lỗi rõ ràng

#### 9.2. CLI/REPL tests
- REPL/CLI nhận event và render incremental thay vì chờ final text
- tool activity hiển thị live
- turn fail đóng state đúng

#### 9.3. Parity regression tests
- cùng một input đại diện, `runAgentTurn()` và collect từ `runAgentTurnStream()` phải cho cùng `finalAnswer`
- đây là guard chính chống drift giữa live path và final path

## Files to modify
- `src/agent/loop.ts`
  - thêm `TurnEvent`
  - thêm `runAgentTurnStream(...)`
  - refactor `runAgentTurn(...)` thành wrapper collect
- `src/cli/repl.ts`
  - mở rộng REPL run contract để chuyển tiếp live turn events
- `src/cli/main.ts`
  - consume turn stream và render text/tool activity incremental
  - có thể cần cập nhật writer API hiện tại
- `src/cli/*` writer-related files nếu logic render được tách riêng
- `tests/agent/*`
  - thêm test cho turn event ordering/parity
- `tests/cli/*`
  - thêm test cho REPL/CLI live rendering nếu đã có harness phù hợp

Nếu việc định nghĩa `TurnEvent` làm [src/agent/loop.ts](src/agent/loop.ts) phình quá mức, tách type sang file riêng như [src/agent/turn-events.ts](src/agent/turn-events.ts).

## Explicit non-goals for this iteration
- Không thêm streaming cho mọi output mode non-interactive.
- Không redesign toàn bộ CLI writer/UI.
- Không thay đổi provider semantic model thêm lần nữa.
- Không thêm progress UI phức tạp, animation mới, hay transcript protocol mới.
- Không refactor toàn runtime thành stream-first ở mọi API public.

## Risks and mitigations
- **Rủi ro live path và final path lệch nhau:** giảm bằng cách để `runAgentTurn()` collect từ `runAgentTurnStream()`.
- **Rủi ro CLI writer hiện tại chỉ hợp với full block text:** giảm bằng cách thêm incremental append API nhỏ thay vì viết lại toàn bộ writer.
- **Rủi ro tool activity làm event contract phình to:** giữ event tối thiểu, chỉ thêm preview cho UI.
- **Rủi ro nhiều round tool loop làm event ordering rối:** khóa invariant rõ ở agent loop tests.
- **Rủi ro REPL contract đổi quá rộng:** giữ `ReplTurnResult` cuối cùng, thêm live event như capability bổ sung.

## Explicit decisions
- Primitive provider vẫn là `AsyncIterable<NormalizedEvent>`.
- Primitive mới cho CLI turn là `AsyncIterable<TurnEvent>`.
- Agent loop là nơi normalize lifecycle của một turn.
- CLI chỉ render từ `TurnEvent`, không consume provider event thô.
- `runAgentTurn()` được giữ lại như wrapper collect từ stream path.
- Scope đầu tiên chỉ nhắm interactive CLI/REPL với streamed text + live tool activity tối thiểu.
