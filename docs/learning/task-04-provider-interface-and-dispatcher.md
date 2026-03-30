# Task 04 - Provider interface và tool dispatcher tối thiểu

## Mục tiêu của task này

Task 4 mở rộng nền tảng của Task 3 thêm một lớp trừu tượng ở phía trên registry tools, để runtime bắt đầu có thể nói về hai khái niệm mới theo contract thống nhất:

- provider/model response
- tool dispatch/result normalization

Ở thời điểm này, hệ thống vẫn chưa có agent loop thật, chưa có integration với API bên ngoài, và chưa có planner hoàn chỉnh. Mục tiêu chỉ là thêm đủ các mảnh ghép để task sau có thể nối chúng lại mà không phải phát minh lại contract lần nữa.

Cụ thể, Task 4 cần đạt được các ý sau:

1. có một provider interface tối thiểu để runtime có thể yêu cầu model sinh ra phản hồi theo một shape ổn định
2. có một anthropic provider stub chỉ để chứng minh contract, chưa gọi network thật
3. có một dispatcher nhận yêu cầu gọi tool theo tên
4. dispatcher lookup tool từ built-in registry hiện tại
5. dispatcher gọi `tool.execute(input, context)`
6. dispatcher luôn trả về message/tool-result shape thống nhất cho cả trường hợp thành công lẫn lỗi
7. bổ sung test cho các behavior trên trong `tests/agent/loop.test.ts`

Task này bám vào trạng thái code hiện tại sau Task 3, nghĩa là:

- tool contract chuẩn vẫn là `Tool<TInput>` với `name`, `description`, `inputSchema`, `execute(input, context)`
- registry hiện là built-in static helpers chứ không còn `ToolRegistry` class
- built-in tools hiện tại là `read_file`, `edit_file`, `search`, `shell`

## Các file được thêm hoặc cập nhật trong Task 4

### 1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/provider/model.ts`

Đây là file mới quan trọng nhất của Task 4 vì nó định nghĩa contract dữ liệu cho lớp provider và lớp tool-result normalization.

Các kiểu dữ liệu chính trong file này:

#### `ToolCallRequest`

Shape mô tả một yêu cầu gọi tool do provider hoặc model tạo ra.

Các trường hiện tại:

- `id: string`
- `name: string`
- `input: unknown`

Ý nghĩa thiết kế:

- `id` giúp loop về sau liên kết tool call với tool result
- `name` là chuỗi để dispatcher lookup trong registry hiện tại
- `input` được giữ là `unknown` vì dispatcher đang ở ranh giới runtime, chưa có validator tổng quát

#### `ToolResultMessage`

Đây là shape thống nhất mà dispatcher trả về sau khi thực thi hoặc thất bại.

Các trường:

- `role: 'tool'`
- `name: string`
- `toolCallId: string`
- `content: string`
- `isError: boolean`

Điểm đáng chú ý:

- interface này `extends Message` từ `src/core/types.ts`
- như vậy tool result đã dùng chung ngôn ngữ message với phần core hiện có
- đồng thời nó bổ sung các trường riêng cho tool execution

#### `ProviderRequest`

Shape đầu vào cho provider.

Hiện tại gồm:

- `messages: Message[]`
- `availableTools: Tool[]`

Lý do:

- provider cần biết conversation hiện tại
- provider cũng cần biết runtime hiện có những tool nào để về sau có thể ra quyết định gọi tool
- ở giai đoạn này provider stub chưa thực sự dùng logic đó, nhưng contract đã được khóa lại

#### `ProviderResponse`

Shape đầu ra của provider.

Hiện tại gồm:

- `message: Message`
- `toolCalls: ToolCallRequest[]`

Đây là quyết định rất quan trọng của Task 4:

- provider không chỉ trả text assistant thuần
- provider cũng có thể trả danh sách tool calls riêng
- loop về sau chỉ cần đọc 2 phần này: assistant message và các tool calls cần dispatch

#### `ModelProvider`

Interface tối thiểu cho mọi provider.

Các thành phần:

- `name: string`
- `model: string`
- `generate(request: ProviderRequest): Promise<ProviderResponse>`

Thiết kế này giữ đúng tinh thần MVP:

- đủ ít để chưa khóa kiến trúc quá sớm
- đủ rõ để task sau có thể cắm thêm provider khác
- chưa cần streaming, token usage, stop reason, retries, timeout, hay network client

#### `toToolResultMessage` và `toToolErrorMessage`

Hai helper này chuẩn hóa kết quả dispatcher thành cùng một shape.

Vai trò:

- tránh để `dispatcher.ts` tự dựng object ở nhiều nhánh
- gom logic normalize message về một chỗ gần contract nhất
- giúp test dễ đọc hơn vì tool success và tool failure cùng đi qua một chuẩn chung

---

### 2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/provider/anthropic.ts`

Đây là anthropic provider stub tối thiểu.

File này export:

- `AnthropicProviderOptions`
- `createAnthropicProvider(options)`

Behavior hiện tại:

- trả về một object tuân theo `ModelProvider`
- `name` cố định là `'anthropic'`
- `model` lấy từ options
- `generate(...)` không gọi API thật
- `generate(...)` luôn trả về:
  - assistant message stub
  - `toolCalls: []`

Tại sao implementation đơn giản như vậy là hợp lý:

- yêu cầu task nói rõ chưa cần Anthropics API thật
- mục tiêu chỉ là có contract provider và một implementation chứng minh contract đó dùng được
- nếu kéo thêm SDK hoặc network ngay bây giờ sẽ đẩy code vượt xa phạm vi MVP

Nói cách khác, file này tồn tại để trả lời câu hỏi: “runtime có thể có một provider object chuẩn hóa hay chưa?” Chưa nhằm trả lời câu hỏi: “runtime đã có model integration thật hay chưa?”

---

### 3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/agent/dispatcher.ts`

Đây là nơi thực hiện tool dispatch thực tế.

File này hiện export một hàm duy nhất:

- `dispatchToolCall(toolCall, context)`

Luồng xử lý hiện tại:

1. nhận `ToolCallRequest`
2. lookup tool bằng `getTool(toolCall.name)` từ built-in registry
3. nếu không tìm thấy tool:
   - không throw ra ngoài
   - tạo `ToolResultMessage` lỗi với `isError: true`
4. nếu có tool:
   - gọi `await tool.execute(toolCall.input, context)`
5. nếu chạy thành công:
   - convert sang `ToolResultMessage` với `isError: false`
6. nếu tool ném lỗi:
   - bắt lỗi
   - convert sang `ToolResultMessage` với `isError: true`

Điểm quan trọng nhất của dispatcher trong Task 4:

- caller phía trên không cần phải biết tool thất bại bằng exception hay thành công bằng return value
- mọi thứ đều được hạ về cùng một envelope kiểu message
- điều này rất thuận lợi cho agent loop ở task sau, vì loop chỉ cần append tool message vào transcript thay vì phải xử lý nhiều kiểu error path

Dispatcher hiện giữ phạm vi rất nhỏ:

- chưa validate `toolCall.input` theo `inputSchema`
- chưa support registry injection
- chưa có telemetry, timing, retries, timeout, cancellation
- chưa dispatch nhiều tool calls cùng lúc

Những giới hạn này là cố ý để giữ code tối giản.

---

### 4. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/agent/loop.test.ts`

File test hiện đã được mở rộng để bao phủ thêm provider và dispatcher behavior, bên cạnh các test Task 3 cho tool registry và built-in tools.

Các nhóm test mới được thêm:

#### a. provider contract tối thiểu

Test xác nhận rằng `createAnthropicProvider(...)` trả về object có:

- `name = 'anthropic'`
- `model` đúng theo options truyền vào
- `generate(...)` trả về `ProviderResponse` ổn định với assistant message stub và `toolCalls: []`

Mục tiêu của test này không phải kiểm tra logic AI, mà là khóa shape contract cho provider.

#### b. dispatcher thành công với tool có thật

Test tạo workspace tạm, ghi file `note.txt`, rồi dispatch tool call:

- `name: 'read_file'`
- `input: { path: 'note.txt' }`

Kỳ vọng:

- dispatcher trả message role `'tool'`
- `name` là `'read_file'`
- `toolCallId` khớp với request
- `content` là nội dung file
- `isError` là `false`

Test này chứng minh dispatcher thực sự nối được provider-side tool call shape với built-in tool contract ở Task 3.

#### c. dispatcher normalize missing tool

Test gửi yêu cầu gọi `missing_tool`.

Kỳ vọng:

- promise resolve ra một `ToolResultMessage`
- không throw ra ngoài
- `isError` là `true`
- `content` nói rõ `Tool not found: missing_tool`

Đây là quyết định thiết kế quan trọng: missing tool là dữ liệu lỗi có kiểm soát, không phải crash path.

#### d. dispatcher normalize tool execution failure

Test gọi `read_file` với file không tồn tại.

Kỳ vọng:

- dispatcher không ném exception ra ngoài
- nó trả về `ToolResultMessage` lỗi
- `content` chứa message lỗi gốc liên quan đến `missing.txt`
- `isError` là `true`

Test này khóa một hành vi quan trọng khác: lỗi từ tool thật cũng được normalize cùng shape với missing-tool error.

## Workflow TDD đã được áp dụng thế nào

Task này được làm theo vòng đời test-first đúng tinh thần TDD:

### Bước 1: viết test trước

Trước khi có `src/provider/model.ts`, `src/provider/anthropic.ts`, hay `src/agent/dispatcher.ts`, test đã được thêm import và behavior mong muốn vào `tests/agent/loop.test.ts`.

### Bước 2: chạy test để thấy pha đỏ

Lệnh chạy:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" test -- tests/agent/loop.test.ts`

Kết quả đỏ đúng kỳ vọng:

- test fail vì không tìm thấy module `../../src/agent/dispatcher.js`

Đây là failure đúng bản chất “feature chưa tồn tại”, không phải assertion sai hay typo test.

### Bước 3: viết code tối thiểu để pass

Sau khi thấy đỏ, implementation tối thiểu mới được thêm:

- contract types trong `src/provider/model.ts`
- anthropic stub trong `src/provider/anthropic.ts`
- dispatcher trong `src/agent/dispatcher.ts`

### Bước 4: chạy lại test để xanh

Cùng lệnh test file riêng đã pass toàn bộ.

Điều này cho thấy phần code mới là mức tối thiểu nhưng đủ để thỏa behavior vừa được khóa bằng test.

## Checked-in contract của Task 4

Đây là phần quan trọng nhất nếu muốn hiểu codebase đang “chốt” điều gì sau task này.

### Contract 1: runtime có khái niệm provider tối thiểu

Mọi provider hiện tại hoặc tương lai nên tuân theo:

- `name`
- `model`
- `generate({ messages, availableTools }) => Promise<{ message, toolCalls }>`

Điều này có nghĩa là lớp model-facing của runtime từ giờ không còn chỉ là “một hàm trả text”, mà là một interface có thể trả cả tool calls.

### Contract 2: tool call có shape chuẩn

Một tool call hiện được biểu diễn bởi:

- `id`
- `name`
- `input`

Task sau có thể tạo tool calls theo shape này mà không cần biết tool implementation cụ thể.

### Contract 3: tool result được chuẩn hóa thành message role `tool`

Sau Task 4, kết quả dispatch thành công hay thất bại đều có shape:

- `role: 'tool'`
- `name`
- `toolCallId`
- `content`
- `isError`

Đây là contract then chốt để loop sau này có thể append kết quả tool vào transcript theo một định dạng thống nhất.

### Contract 4: dispatcher không throw với lỗi dispatch thông thường

Trong phạm vi Task 4, các lỗi sau được normalize thành `ToolResultMessage` thay vì ném ra ngoài:

- tool không tồn tại
- tool execute ném lỗi

Điều này làm call site ở tầng trên đơn giản hơn nhiều.

### Contract 5: anthropic provider hiện chỉ là stub đúng shape

`createAnthropicProvider(...)` hiện không có bất kỳ network side effect nào. Nó chỉ chứng minh rằng contract provider có thể được implement bằng một đối tượng cụ thể.

## Cách provider, dispatcher và tool registry hoạt động cùng nhau

Đây là luồng cộng tác của ba phần sau Task 4:

1. runtime chuẩn bị conversation hiện tại dưới dạng `Message[]`
2. runtime lấy danh sách tool built-in từ registry
3. runtime gọi `provider.generate({ messages, availableTools })`
4. provider trả về:
   - một assistant message
   - zero hoặc nhiều `toolCalls`
5. với mỗi `toolCall`, runtime gọi `dispatchToolCall(toolCall, context)`
6. dispatcher dùng `toolCall.name` để lookup tool trong registry
7. dispatcher gọi `tool.execute(toolCall.input, context)`
8. dispatcher convert kết quả hoặc lỗi thành `ToolResultMessage`
9. runtime về sau có thể append `ToolResultMessage` đó vào transcript rồi tiếp tục vòng lặp

Điểm đáng chú ý là:

- provider không tự chạy tool
- tool registry không biết gì về provider
- dispatcher là lớp keo nối giữa “tool call theo tên” và “tool object thực thi thật”

Cách tách lớp này giúp mỗi phần giữ trách nhiệm rõ ràng:

- provider chịu trách nhiệm nói model muốn làm gì
- registry chịu trách nhiệm biết tool nào tồn tại
- dispatcher chịu trách nhiệm thực thi và normalize kết quả

## Những gì Task 4 cố ý chưa làm

### 1. Chưa có agent loop thật

Task này chưa thêm vòng lặp assistant -> tool call -> tool result -> assistant tiếp theo.

Lý do:

- user đã nói rõ chưa cần agent loop thật
- mục tiêu mới là contract và dispatcher

Khả năng cao phần này sẽ được hấp thụ ở task sau về loop.

### 2. Chưa có Anthropics API thật

Không có:

- SDK thật
- API key handling
- HTTP calls
- retry/backoff
- streaming events
- usage metadata

Đây là chủ đích để tránh mở rộng phạm vi quá sớm.

### 3. Chưa có runtime validation theo `inputSchema`

Dù mỗi tool đã có `inputSchema` từ Task 3, dispatcher hiện chưa parse hoặc validate `toolCall.input` theo schema đó.

Điều này là một giới hạn có ý thức:

- hiện chưa có validator chung
- built-in tools vẫn tự bảo vệ ở mức implementation runtime của chúng
- thêm validation framework lúc này sẽ kéo thiết kế ra xa khỏi MVP

Nếu task sau cần input safety mạnh hơn, dispatcher là nơi hợp lý nhất để hấp thụ phần đó.

### 4. Chưa có registry động hoặc dependency injection cho dispatcher

Dispatcher hiện gắn trực tiếp vào `getTool(...)` từ built-in registry.

Ưu điểm:

- ít code
- dễ hiểu
- đủ cho current architecture

Nhược điểm:

- chưa dễ thay registry trong unit tests hoặc khi có plugin/external tools

Hiện tại nhược điểm này được chấp nhận vì task chỉ yêu cầu built-in static helpers.

### 5. Chưa có batch dispatch hoặc concurrency control

Task 4 chỉ thêm dispatch cho một tool call mỗi lần.

Điều này là đủ vì:

- contract chính nằm ở shape chuẩn hóa
- loop thật chưa tồn tại
- chưa cần quyết định policy chạy tuần tự hay song song

### 6. Chưa có rich error taxonomy

Hiện mọi lỗi đều được hạ về:

- `content: string`
- `isError: boolean`

Chưa có phân loại như:

- `not_found`
- `validation_error`
- `permission_denied`
- `execution_failed`

Task này ưu tiên envelope nhỏ và ổn định hơn là error model quá chi tiết.

## Giải thích các quyết định thiết kế

### Quyết định 1: dùng `Message` hiện có làm nền cho tool result

Thay vì tạo một hệ message hoàn toàn riêng, Task 4 để `ToolResultMessage` kế thừa `Message` từ `src/core/types.ts`.

Lợi ích:

- thống nhất ngôn ngữ dữ liệu của runtime
- chuẩn bị tốt cho loop sau này, nơi transcript nhiều khả năng sẽ là mảng messages
- tránh trùng lặp khái niệm assistant/user/tool message

### Quyết định 2: tách provider contract và provider implementation

`src/provider/model.ts` chứa contract, còn `src/provider/anthropic.ts` chứa implementation.

Lợi ích:

- dễ thêm provider khác sau này
- test có thể bám vào contract mà không phụ thuộc trực tiếp implementation cụ thể
- tránh để file provider cụ thể kiêm luôn vai trò source-of-truth cho type system

### Quyết định 3: dispatcher trả message lỗi thay vì throw

Đây là quyết định trung tâm của Task 4.

Nếu dispatcher throw lỗi ra ngoài, loop sau này sẽ phải xử lý nhiều nhánh control flow khác nhau. Khi normalize về `ToolResultMessage`, loop sẽ đơn giản hơn:

- append message
- cho model thấy lỗi như một phần transcript
- quyết định bước tiếp theo

Cách này phù hợp với agent architecture, nơi lỗi tool thường là thông tin để model hoặc orchestrator xử lý tiếp, không nhất thiết là lỗi hệ thống gây dừng tiến trình.

### Quyết định 4: giữ provider response cực nhỏ

`ProviderResponse` hiện chỉ có:

- `message`
- `toolCalls`

Không thêm:

- finish reason
- usage
- raw provider payload
- request id
- latency
- metadata bag

Lý do là vì task hiện tại chưa có caller nào cần chúng. Thêm sớm sẽ làm contract phình ra mà chưa tạo giá trị ngay.

### Quyết định 5: chưa kéo thêm dependency validation

Task 3 learning doc đã chỉ ra rằng validation có thể hợp lý ở Task 4, nhưng trong trạng thái code thật của repo hiện tại, yêu cầu chính của Task 4 vẫn được đáp ứng mà chưa cần dependency mới.

Việc không thêm validator ở bước này giúp:

- giữ diff nhỏ
- tránh chốt schema engine quá sớm
- tập trung vào provider/dispatcher contract là phần thật sự cần cho tiến độ hiện tại

## Cách đọc code Task 4 theo thứ tự hợp lý

Nếu bạn muốn học lại phần này sau, nên đọc theo thứ tự sau:

1. `src/tools/tool.ts`
   - hiểu contract tool từ Task 3
2. `src/tools/registry.ts`
   - hiểu built-in lookup hiện tại
3. `src/provider/model.ts`
   - hiểu contract provider, tool call, tool result
4. `src/provider/anthropic.ts`
   - xem một provider stub thực hiện contract đó ra sao
5. `src/agent/dispatcher.ts`
   - xem tool call được lookup và normalize thế nào
6. `tests/agent/loop.test.ts`
   - xem behavior nào đang bị khóa bởi test

## Kết luận

Task 4 đã hoàn thành một lớp abstraction mới nằm giữa model/provider và tools:

- có provider interface tối thiểu
- có anthropic stub đúng contract
- có dispatcher gọi built-in tools theo tên
- có tool result/error normalization thành message shape thống nhất
- có test khóa các behavior chính
- có tài liệu học tập chi tiết để làm nền cho các task sau

Nói ngắn gọn, sau Task 4 codebase đã tiến từ chỗ “có tools và registry” sang chỗ “có thể biểu diễn model response, tool calls, và tool results theo một protocol runtime nhỏ nhưng nhất quán”. Đây là bước cần thiết trước khi xây agent loop thật ở giai đoạn sau.
