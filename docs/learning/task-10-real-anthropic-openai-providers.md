# Task 10 - Real Anthropic/OpenAI providers cho single-agent CLI runtime

## Mục tiêu của task này

Sau Task 9, QiClaw đã có một interactive CLI runtime khá hoàn chỉnh ở mức local orchestration:

- có `CLI -> REPL -> runtime -> runAgentTurn(...)`
- có session-aware interactive mode
- có checkpoint/resume
- có tool loop
- có verification
- có telemetry

Tuy nhiên ở lớp model/provider vẫn còn một khoảng trống rất lớn:

- runtime chỉ biết hardcode Anthropic
- Anthropic provider chỉ là stub
- OpenAI provider chưa tồn tại thật sự
- CLI chưa thật sự có ý nghĩa “chọn vendor/model rồi gọi live API”

Nói cách khác, toàn bộ runtime đã sẵn sàng để chạy agent thật, nhưng “bộ não” vẫn chỉ là giả lập.

Task 10 giải quyết đúng chỗ đó bằng cách:

1. bỏ hardcode provider ở runtime
2. cho CLI chọn `provider` và `model`
3. thêm provider factory
4. thay stub bằng live adapter cho Anthropic
5. thêm live adapter cho OpenAI
6. chuẩn hóa response của hai vendor về cùng `ProviderResponse`
7. giữ `src/agent/loop.ts` gần như không cần biết sự khác nhau giữa Anthropic và OpenAI

Đây là bước chuyển rất quan trọng: codebase đi từ “agent runtime mô phỏng” sang “agent runtime có thể gọi model thật”.

---

## Phạm vi implementation đã hoàn thành

### File mới

- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/provider/config.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/provider/factory.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/provider/openai.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/tests/provider/factory.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/docs/learning/task-10-real-anthropic-openai-providers.md`

### File được chỉnh sửa

- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/package.json`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/package-lock.json`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/agent/runtime.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/cli/main.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/provider/anthropic.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/src/provider/model.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/tests/agent/loop.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers/tests/cli/repl.test.ts`

---

## Kết quả chức năng mà Task 10 mang lại

Sau task này, runtime có thêm các capability sau:

1. Có thể chọn provider qua CLI:
   - `anthropic`
   - `openai`
2. Có thể chọn model theo vendor
3. Nếu không truyền model, hệ thống tự dùng default model theo provider
4. Runtime không còn hardcode Anthropic
5. Anthropic provider đã gọi API thật qua SDK
6. OpenAI provider đã gọi API thật qua SDK
7. Cả hai provider đều support text completion và tool-call extraction
8. Tool loop tiếp tục chạy qua `ProviderResponse { message, toolCalls }`
9. Thiếu API key sẽ fail sớm bằng error rõ ràng
10. Response parsing của OpenAI được siết chặt ở boundary JSON/tool-call

Điểm rất quan trọng là phần core loop vẫn giữ được boundary cũ:

- loop không cần biết Anthropic dùng `messages.create`
- loop không cần biết OpenAI dùng `responses.create`
- loop chỉ cần biết provider trả `message` và `toolCalls`

Đây chính là lợi ích lớn nhất của lớp adapter/provider abstraction.

---

## Kiến trúc sau Task 10

Sau task này, lớp provider có cấu trúc như sau:

### `src/provider/model.ts`

Đây là source of truth cho contract dùng chung:

- `ProviderId = 'anthropic' | 'openai'`
- `ProviderRequest`
- `ProviderResponse`
- `ToolCallRequest`
- `ModelProvider`
- `normalizeProviderResponse(...)`

Điểm quan trọng nhất của file này là: nó định nghĩa ngôn ngữ trung gian giữa vendor SDK và agent loop.

Từ góc nhìn của `runAgentTurn(...)`, không tồn tại “Anthropic response” hay “OpenAI response”. Chỉ tồn tại:

- assistant message đã normalize
- danh sách tool calls đã normalize

### `src/provider/config.ts`

File này giữ policy config nhỏ nhưng quan trọng:

- parse provider id hợp lệ
- resolve default model theo provider

Current defaults sau Task 10:

- `anthropic -> claude-opus-4-6`
- `openai -> gpt-4.1`

Lợi ích của việc tách file này ra khỏi CLI:

- CLI không ôm provider-specific knowledge
- test default-model logic độc lập hơn
- sau này nếu thêm config file/env precedence sâu hơn thì có chỗ để mở rộng

### `src/provider/factory.ts`

Factory chịu trách nhiệm chọn provider concrete:

- `anthropic -> createAnthropicProvider(...)`
- `openai -> createOpenAIProvider(...)`
- provider lạ -> throw error rõ ràng

Điểm đáng chú ý là task này đã bỏ fallback ngầm sang OpenAI. Đây là một cải tiến nhỏ nhưng rất quan trọng về boundary safety: provider resolution không còn dựa vào giả định âm thầm.

### `src/provider/anthropic.ts`

File này là live adapter cho Anthropic.

Nó làm 4 việc chính:

1. đọc `ANTHROPIC_API_KEY`
2. chuyển internal transcript/tool schema sang `messages.create(...)`
3. gọi live API qua `@anthropic-ai/sdk`
4. parse response thành text + tool calls chuẩn của runtime

### `src/provider/openai.ts`

File này là live adapter cho OpenAI.

Nó cũng làm 4 việc tương tự:

1. đọc `OPENAI_API_KEY`
2. chuyển transcript/tool schema sang `responses.create(...)`
3. gọi live API qua `openai`
4. parse response về text + tool calls chuẩn của runtime

Task này chủ động dùng `responses.create` cho OpenAI vì nó map khá sạch vào contract hiện tại mà không cần đụng tới `src/agent/loop.ts`.

### Cập nhật thêm sau đó: custom provider / custom endpoint

Sau khi hoàn tất bản provider thật đầu tiên, scope đã được làm rõ thêm: hệ thống không chỉ cần gọi endpoint first-party của Anthropic/OpenAI, mà còn phải support **custom endpoint tương thích protocol Anthropic hoặc OpenAI**.

Điểm quan trọng của cập nhật này:

- không thêm provider ID `custom`
- vẫn chỉ có hai provider families:
  - `anthropic`
  - `openai`
- thứ được custom hóa là:
  - `apiKey`
  - `baseUrl`
- phần protocol mapping vẫn giữ nguyên theo từng vendor-compatible adapter

Cách wiring sau cập nhật:

1. CLI parse thêm:
   - `--base-url`
   - `--api-key`
2. `src/provider/config.ts` resolve config theo precedence:
   - CLI flags
   - env vars theo provider (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`)
   - default model theo provider
3. runtime nhận full resolved config
4. factory pass `model/baseUrl/apiKey` xuống provider concrete
5. Anthropic/OpenAI SDK clients được khởi tạo với `baseURL` override nếu có
6. `src/agent/loop.ts` vẫn không cần biết endpoint đang là first-party hay custom

Ý nghĩa kiến trúc của thay đổi này rất lớn:

- custom endpoint support được giữ gọn ở boundary config/provider construction
- runtime loop không bị nhiễm khái niệm transport-specific
- code vẫn nói theo “Anthropic-compatible” và “OpenAI-compatible” thay vì nảy sinh protocol thứ ba mơ hồ

---

## Giải thích chi tiết từng phần implementation

## 1. `src/agent/runtime.ts` - bỏ hardcode provider

Trước Task 10, runtime luôn tạo Anthropic provider.

Điều đó có nghĩa là dù CLI có cho chọn model đi nữa, runtime vẫn ngầm mặc định vendor là Anthropic.

Sau Task 10, `CreateAgentRuntimeOptions` nhận rõ:

- `provider`
- `model`
- `cwd`
- `observer`

và runtime gọi `createProvider(...)` thay vì `createAnthropicProvider(...)` trực tiếp.

Đây là thay đổi nhỏ về code nhưng rất lớn về ý nghĩa kiến trúc:

- runtime không còn vendor-specific
- provider selection trở thành config đầu vào
- việc thêm provider thứ ba sau này sẽ nhẹ hơn rất nhiều

---

## 2. `src/cli/main.ts` - provider/model trở thành user-facing config thật sự

Task 10 mở rộng CLI để parse thêm:

- `--provider`
- `--model`

và giữ behavior sau:

- nếu không truyền `--provider` thì default là `anthropic`
- nếu không truyền `--model` thì default model phụ thuộc provider
- nếu provider không hợp lệ thì fail sớm

Điểm hay ở implementation hiện tại là CLI không còn tự giữ logic default model nữa; nó dùng helper từ `src/provider/config.ts`.

Điều này giữ boundary sạch:

- CLI chịu trách nhiệm parse argv
- provider config layer chịu trách nhiệm biết model mặc định nào tương ứng vendor nào

Đó là một boundary rất hợp lý.

---

## 3. `src/provider/model.ts` - chuẩn hóa response theo rule A

Trong task này đã chốt quy ước normalize như sau:

- luôn giữ toàn bộ text assistant trong `message.content`
- đồng thời trả `toolCalls` riêng
- chỉ để `message.content` rỗng khi vendor thực sự không trả text

Rule này nghe có vẻ nhỏ, nhưng nó khóa một quyết định thiết kế rất quan trọng.

### Vì sao rule này tốt?

Nếu model vừa trả text vừa phát sinh tool call, có ba cách phổ biến:

1. bỏ text đi, chỉ giữ tool call
2. giữ text một phần
3. giữ toàn bộ text và tách tool calls riêng

Task 10 chọn cách 3 vì:

- ít đụng nhất vào `runAgentTurn(...)`
- không làm mất thông tin text đi kèm tool call
- vẫn giữ được provider boundary rõ ràng

`normalizeProviderResponse(...)` trong `src/provider/model.ts` chính là helper gom policy này về một chỗ.

---

## 4. `src/provider/anthropic.ts` - map internal transcript sang Anthropic Messages API

Đây là phần quan trọng nhất nếu muốn hiểu adapter pattern trong codebase.

### 4.1. `getAnthropicApiKey()`

Hàm này làm đúng một việc:

- đọc `process.env.ANTHROPIC_API_KEY`
- nếu thiếu thì throw error rõ ràng

Lý do fail sớm ở đây rất hợp lý:

- lỗi config là lỗi boundary
- không có lý do gì để đợi tới giữa turn mới phát nổ theo cách mơ hồ

### 4.2. `buildAnthropicMessagesRequest(...)`

Đây là nơi convert internal `Message[]` sang request của Anthropic.

Các bước chính:

1. gom tất cả `system` messages thành một `system` prompt chung
2. bỏ các `system` messages khỏi conversation stream
3. map:
   - `user` -> user message
   - `assistant` -> assistant message
   - `tool` -> `tool_result`
4. map built-in tools sang `AnthropicTool`

Điểm rất đáng chú ý là tool result hiện được convert về block:

- `type: 'tool_result'`
- `tool_use_id`
- `content`
- `is_error`

Tức là transcript của runtime đã được bẻ đúng theo protocol Anthropic mà không cần loop biết gì về chi tiết này.

### 4.3. `readAnthropicTextContent(...)`

Anthropic có thể trả nhiều content blocks.

Task 10 chọn cách:

- lọc các block text
- nối tất cả text lại thành một string

Điều này khớp với rule normalize đã chốt từ đầu task.

### 4.4. `extractAnthropicToolCalls(...)`

Tương tự, provider đọc các block `tool_use` rồi convert về `ToolCallRequest[]` với shape nội bộ:

- `id`
- `name`
- `input`

Như vậy `runAgentTurn(...)` chỉ nhìn thấy tool calls chuẩn của runtime, không nhìn thấy raw Anthropic blocks.

---

## 5. `src/provider/openai.ts` - map internal transcript sang OpenAI Responses API

OpenAI là phần khó hơn một chút vì response và tool-call arguments có thêm boundary parse JSON.

### 5.1. `getOpenAIApiKey()`

Tương tự Anthropic:

- đọc `OPENAI_API_KEY`
- thiếu thì throw rõ ràng

### 5.2. `buildOpenAIResponsesRequest(...)`

Task 10 dùng `responses.create(...)`.

Flow mapping hiện tại:

1. gom `system` messages thành `instructions`
2. map `user`/`assistant` sang `type: 'message'`
3. map tool results sang `type: 'function_call_output'`
4. map built-in tools sang `FunctionTool[]`

Điểm rất hay là OpenAI adapter cũng hấp thụ hoàn toàn khác biệt protocol ở đây, nên core loop vẫn không đổi.

### 5.3. `readOpenAITextContent(...)`

OpenAI Responses API có thể trả output dạng nhiều items.

Implementation hiện tại:

- tìm các `message` output của assistant
- lấy các phần `output_text`
- nối tất cả lại thành một string

Điều này tiếp tục bám đúng normalize rule A.

### 5.4. `extractOpenAIToolCalls(...)`

Provider lấy các `function_call` items rồi map về `ToolCallRequest[]`.

Boundary quan trọng nhất ở đây là parse `arguments`.

### 5.5. Hardening `parseOpenAIToolArguments(...)`

Đây là một chỗ đã phải fix thêm sau code-quality review.

Ban đầu chỉ `JSON.parse()` raw string là chưa đủ an toàn, vì sẽ gặp các case như:

- JSON malformed
- JSON hợp lệ nhưng parse ra `null`
- JSON hợp lệ nhưng parse ra array hoặc primitive

Task 10 đã siết boundary này bằng cách:

- catch JSON parse error
- reject `null`
- reject array
- reject non-object
- throw lỗi OpenAI-specific rõ tool name đang lỗi

Đây là ví dụ rất điển hình của nguyên tắc:

**validation chỉ nên chặt ở system boundary, không rải lung tung trong core loop.**

OpenAI adapter là boundary phù hợp để làm việc đó.

---

## 6. Vì sao `src/agent/loop.ts` gần như không đổi

Đây là một trong những thành công lớn nhất của Task 10.

Khi thay stub bằng 2 live SDK adapters, lẽ ra rất dễ rơi vào bẫy sửa loop để “biết” từng vendor khác nhau.

Task 10 tránh được điều đó bằng cách đẩy toàn bộ khác biệt vendor xuống provider layer.

Kết quả là loop vẫn chỉ cần flow cũ:

1. build prompt/messages
2. gọi `provider.generate(...)`
3. nhận `message` và `toolCalls`
4. dispatch tools nếu có
5. append tool messages
6. lặp tiếp

Chính vì vậy mà complexity của vendor integration không lan sang lớp agent orchestration.

---

## Test coverage mới trong Task 10

Task này không chỉ thêm code, mà còn khóa lại các behavior quan trọng bằng test.

## 1. Test config/provider selection

Trong `tests/cli/repl.test.ts`:

- parse provider/model đúng
- default provider/model đúng
- provider không hợp lệ báo lỗi rõ
- provider default model cho `openai` và `anthropic` được khóa bằng test

Những test này ngăn việc CLI vô tình regress về hardcoded Anthropics defaults sau này.

## 2. Test provider factory

Trong `tests/provider/factory.test.ts`:

- provider lạ không được fallback ngầm sang OpenAI
- factory phải throw rõ ràng

Đây là test nhỏ nhưng khóa đúng một bug boundary rất dễ bị bỏ sót.

## 3. Test request builders

Trong `tests/agent/loop.test.ts`:

- `buildAnthropicMessagesRequest(...)`
- `buildOpenAIResponsesRequest(...)`

cả hai đều được test với:

- system prompt
- user/assistant transcript
- tool message mapping
- tool schema mapping

Những test này cực kỳ giá trị vì chúng khóa đúng chỗ “adapter logic” quan trọng nhất.

## 4. Test text/tool-call extraction

Cũng trong `tests/agent/loop.test.ts`:

- đọc text từ mixed vendor outputs
- extract tool calls từ mixed vendor outputs
- preserve text + tool calls đồng thời

Điều này trực tiếp xác nhận normalize rule A đã được implement đúng.

## 5. Test missing API key

Task 10 thêm test cho:

- thiếu `ANTHROPIC_API_KEY`
- thiếu `OPENAI_API_KEY`

Kỳ vọng:

- fail sớm
- error rõ ràng

Đây là test rất thực tế vì lỗi config là lỗi user gặp đầu tiên khi bắt đầu chạy provider thật.

## 6. Test parsing edge-cases của OpenAI

Sau quality review, đã thêm test cho:

- invalid `function_call.arguments` JSON
- valid JSON nhưng không parse ra object

Đây là lớp test giúp adapter OpenAI không “nuốt” dữ liệu sai shape vào tool loop.

## 7. Test missing `toolCallId`

Cũng đã thêm test cho cả hai builders khi gặp tool message thiếu `toolCallId`.

Điều này rất hợp lý vì transcript nội bộ chỉ an toàn nếu tool messages đủ metadata để nối lại với tool calls trước đó.

---

## Dependencies mới được thêm

Trong `package.json`, Task 10 thêm:

- `@anthropic-ai/sdk`
- `openai`

Quyết định dùng SDK thay vì tự viết `fetch` client là hợp lý vì:

- giảm thời gian hiện thực hóa provider thật
- tránh phải tự lo auth/header/request serialization
- bám sát API stable của vendor

Đây là một tradeoff tốt cho giai đoạn hiện tại.

---

## Các quyết định thiết kế quan trọng trong Task 10

## Quyết định 1: factory + config là hai lớp nhỏ nhưng đáng giá

Có thể nhét hết logic vào CLI/runtime, nhưng Task 10 tách thành:

- `config.ts`
- `factory.ts`

Lợi ích:

- boundary sạch hơn
- test dễ hơn
- vendor-specific knowledge không rò lung tung

## Quyết định 2: normalize toàn bộ text thay vì bỏ text khi có tool calls

Điều này giữ lại nhiều ngữ cảnh hữu ích cho transcript, đồng thời không phá flow cũ.

## Quyết định 3: validation chặt ở provider boundary, không ở loop

OpenAI JSON/tool-call parsing là ví dụ rõ nhất cho quyết định này.

## Quyết định 4: giữ `runAgentTurn(...)` ổn định

Đây là quyết định giúp Task 10 dù lớn về integration nhưng diff ở core loop vẫn nhỏ và dễ tin cậy.

---

## Những gì Task 10 cố ý chưa làm

### 1. Chưa có streaming

Cả Anthropic và OpenAI hiện đang dùng non-streaming request path.

Điều này hợp lý vì:

- contract hiện tại chỉ cần final `message + toolCalls`
- REPL chưa cần token-by-token UX
- streaming sẽ kéo thêm complexity lớn về incremental transcript/tool-call assembly

### 2. Chưa có usage / token accounting

ProviderResponse hiện vẫn không mang:

- token usage
- request ids
- finish reason
- latency metadata

Task 10 chưa cần vì caller phía trên chưa dùng các dữ liệu đó.

### 3. Chưa có retry/backoff policy

Nếu vendor call fail do network, SDK error hiện sẽ nổi lên bình thường.

Đây là behavior chấp nhận được ở giai đoạn hiện tại, nhưng sau này có thể cần một lớp retry policy riêng.

### 4. Chưa có config precedence đầy đủ qua env/file/settings phức tạp hơn

Hiện mới có:

- CLI flags
- default models theo provider
- env vars cho credentials

Chưa có config file hay settings persistence cho provider/model selection.

### 5. Chưa có provider-specific telemetry chi tiết

Task 10 vẫn tận dụng telemetry hiện có, nhưng chưa log sâu hơn như:

- vendor name per request
- model id per request
- token usage
- API latency

Đó là việc phù hợp cho task telemetry/provider-observability sau này.

---

## Cách đọc code Task 10 theo thứ tự hợp lý

Nếu muốn học lại task này sau, nên đọc theo thứ tự:

1. `src/provider/model.ts`
   - hiểu contract normalize chung
2. `src/provider/config.ts`
   - hiểu provider id và default model policy
3. `src/provider/factory.ts`
   - hiểu provider resolution
4. `src/provider/anthropic.ts`
   - hiểu adapter Anthropic
5. `src/provider/openai.ts`
   - hiểu adapter OpenAI
6. `src/agent/runtime.ts`
   - hiểu runtime compose provider như thế nào
7. `src/cli/main.ts`
   - hiểu provider/model được đưa vào runtime ra sao
8. `tests/agent/loop.test.ts`
   - xem những behavior nào đã được khóa bằng test
9. `tests/cli/repl.test.ts`
   - xem config-facing behavior của CLI

---

## Verification cuối cùng đã chạy

Trong worktree `real-providers`, các lệnh verify cuối đã pass:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers" test`
- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers" run typecheck:test`
- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/real-providers" run build`

Kết quả cuối cùng:

- 11 test files pass
- 96 tests pass
- typecheck pass
- build pass

---

## Kết luận

Task 10 là bước rất quan trọng vì nó biến provider layer từ “contract + stub” thành “contract + live vendor adapters”.

Sau task này, codebase đã đạt được các điểm sau:

- provider không còn hardcoded
- CLI chọn được vendor/model
- Anthropic gọi được API thật
- OpenAI gọi được API thật
- cả hai vendor đều map về cùng contract của runtime
- tool loop cũ vẫn dùng được mà không phải học thêm protocol của từng vendor
- boundary parsing/config đã được khóa bằng test

Nói ngắn gọn, Task 10 là lúc single-agent CLI runtime bắt đầu có thể dùng LLM thật mà vẫn giữ được kiến trúc sạch: vendor-specific complexity bị giữ ở adapter layer, còn core loop tiếp tục nói chuyện bằng protocol nội bộ nhỏ và ổn định.