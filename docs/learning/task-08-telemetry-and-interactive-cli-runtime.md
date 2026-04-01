# Task 08 - Telemetry tối thiểu và interactive CLI runtime cho single-agent CLI runtime

## Mục tiêu của task này

Sau Task 7, codebase đã có một lõi agent turn tương đối hoàn chỉnh ở mức MVP:

- có `createAgentRuntime(...)` để ghép provider mặc định, built-in tools và `cwd`
- có `runAgentTurn(...)` để build prompt, gọi provider, dispatch tool, append history và verify kết quả
- có done criteria, verifier và core loop đã được test

Nhưng ở thời điểm đó vẫn còn một khoảng trống rất rõ giữa “engine bên trong” và “cách người dùng thực sự chạy nó từ CLI”:

1. `src/cli/main.ts` vẫn chỉ là một stub đơn giản, `run()` luôn trả `0`
2. chưa có một lớp REPL/runner riêng để biến input từ CLI thành các lần gọi `runAgentTurn(...)`
3. chưa có telemetry đủ rõ để quan sát một turn đang đi qua các mốc chính nào

Task 8 giải quyết đúng khoảng trống đó, vẫn giữ đúng tinh thần MVP: nhỏ, deterministic, testable, không thêm tính năng ngoài yêu cầu.

Nói ngắn gọn, Task 8 thêm ba khả năng nền tảng:

1. có một lớp telemetry tối thiểu nhưng chạy thật trên đường đi của agent turn
2. có một REPL/runner tối thiểu để chạy từng lượt hỏi đáp từ CLI
3. có `buildCli()` thật sự wire được đường đi `CLI -> REPL -> runtime -> runAgentTurn(...)`

Đây là bước chuyển rất quan trọng vì từ sau task này, runtime không còn chỉ là một nhóm hàm rời rạc để test nội bộ nữa. Nó bắt đầu có một entrypoint CLI đúng nghĩa.

---

## Phạm vi implementation đã hoàn thành

### File mới

- `/home/locdt/Notes/VSCode/QiClaw/src/telemetry/observer.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/telemetry/logger.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/telemetry/metrics.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/cli/repl.ts`
- `/home/locdt/Notes/VSCode/QiClaw/docs/learning/task-08-telemetry-and-interactive-cli-runtime.md`

### File được chỉnh sửa

- `/home/locdt/Notes/VSCode/QiClaw/src/cli/main.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/agent/runtime.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/agent/loop.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/cli/repl.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`

---

## Kết quả chức năng mà Task 8 mang lại

Sau task này, codebase có các capability mới sau:

1. Có contract telemetry rõ ràng qua `TelemetryEvent`, `TelemetryObserver`, `createTelemetryEvent(...)`
2. Có metrics observer in-memory để đếm số turn bắt đầu, số turn hoàn tất, số turn fail, tổng số tool calls hoàn tất và thời gian turn gần nhất
3. Có logger backend dạng JSONL writer đủ nhỏ để nối telemetry ra file hoặc writer khác
4. `runAgentTurn(...)` phát telemetry thật ở những mốc quan trọng nhất của một turn
5. `createAgentRuntime(...)` bây giờ mang theo `observer` như một phần của runtime
6. Có `createRepl(...)` để chạy:
   - một lượt duy nhất qua `runOnce(...)`
   - hoặc vòng lặp interactive tối thiểu qua `runInteractive()`
7. `buildCli()` không còn là stub nữa, mà parse args theo scope MVP và wire được prompt mode lẫn interactive mode

Quan trọng hơn, các đường đi chính đều có test bảo vệ, bao gồm cả test trực tiếp cho contract JSONL logger.

---

## Vì sao task này cần làm ngay sau Task 7

Task 7 đã hoàn thành phần “core engine” của một turn, nhưng chưa có lớp “runtime entry” cho người dùng thực sự sử dụng từ command line.

Nếu dừng ở Task 7 thì sẽ có tình huống như sau:

- developer có thể import `runAgentTurn(...)` trong test hoặc script nội bộ
- nhưng CLI chính thức của app vẫn chưa làm gì thật
- runtime chưa có lớp quan sát nào để biết một turn đã gọi provider bao nhiêu lần, đã gọi tool chưa, đã verify chưa

Điều này tạo ra hai vấn đề:

### Vấn đề 1: chưa có đường đi chạy thật từ CLI

Tức là codebase có engine nhưng chưa có vô-lăng. `main.ts` chưa nối với runtime.

### Vấn đề 2: chưa có observability tối thiểu

Khi turn chạy sai hoặc cần debug, rất khó trả lời nhanh các câu hỏi như:

- turn đã bắt đầu chưa?
- provider có được gọi không?
- có tool call nào không?
- verification có chạy chưa?
- turn dừng do completed hay max rounds?

Task 8 thêm một lớp telemetry rất mỏng nhưng đủ để trả lời các câu hỏi đó một cách deterministic.

---

## Nguyên tắc thiết kế được giữ trong Task 8

Task này cố ý giữ rất chặt các nguyên tắc sau.

### 1. Scope nhỏ

Không thêm analytics backend, không thêm tracing framework, không thêm dashboard, không thêm persistence bắt buộc cho telemetry.

### 2. Deterministic

Telemetry event names cố định, thứ tự event trong các luồng test được khóa bằng assertion cụ thể.

### 3. Testable

REPL không phụ thuộc cứng vào `process.stdin`/`process.stdout`. Các I/O chính được inject qua `readLine(...)` và `writeLine(...)` để test không cần terminal thật.

### 4. Không thêm dependency mới nếu chưa cần

Task này không thêm `yargs`, dù plan gốc có nhắc. Thay vào đó chỉ dùng một parser args rất nhỏ bằng TypeScript thuần vì scope hiện tại chỉ cần hỗ trợ vài flag cơ bản.

### 5. Bám boundary hiện có

- `main.ts` lo parse args và wire dependency
- `repl.ts` lo orchestration mức CLI conversation
- `runtime.ts` lo compose dependency mặc định
- `loop.ts` lo agent turn
- `telemetry/*` lo event/metrics/logger

Đây là boundary rất sạch và dễ hiểu.

---

## Workflow TDD đã được áp dụng như thế nào

Task này được làm theo đúng nhịp test-first.

### Bước 1: viết test mới trước

File test chính được mở rộng trước là:

- `/home/locdt/Notes/VSCode/QiClaw/tests/cli/repl.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`

### Bước 2: chạy test để xác nhận pha đỏ

Khi chạy:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts`

suite fail với lỗi không tìm thấy module telemetry mới:

- `../../src/telemetry/metrics.js`

Đây là failure đúng bản chất TDD:

- test mới đã mô tả behavior mới
- production code chưa có
- fail vì thiếu module/feature, không phải vì typo ngẫu nhiên

### Bước 3: viết production code tối thiểu để pass

Sau khi xác nhận test fail đúng hướng, mới thêm các file telemetry mới, file `repl.ts` và sửa `main.ts`, `runtime.ts`, `loop.ts`.

### Bước 4: chạy lại targeted tests

Sau implementation, chạy:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts tests/agent/loop.test.ts`

và các test này pass.

Tức là task giữ được đúng vòng đời đỏ -> xanh trước khi đi sang verify toàn repo.

---

## Phân tích chi tiết từng phần implementation

# 1. `src/telemetry/observer.ts`

Đây là file định nghĩa contract nền cho telemetry.

## Những gì file này cung cấp

### `TelemetryEventType`

Đây là union type của các event tối thiểu được hỗ trợ hiện tại:

- `turn_started`
- `provider_called`
- `provider_responded`
- `tool_call_started`
- `tool_call_completed`
- `verification_completed`
- `turn_completed`
- `turn_stopped`
- `turn_failed`

Danh sách này được chọn để bám đúng các checkpoint quan trọng nhất trong đường đi của một turn, không hơn.

### `TelemetryEvent`

Shape event hiện tại gồm:

- `type`
- `timestamp`
- `data`

Cấu trúc này rất nhỏ nhưng đủ dùng vì:

- `type` cho biết event là gì
- `timestamp` cho biết nó xảy ra khi nào
- `data` cho biết payload nhỏ gắn kèm event đó

### `TelemetryObserver`

Đây là interface rất đơn giản:

- `record(event: TelemetryEvent): void`

Việc chỉ có một method `record(...)` giúp observer cực dễ thay thế.

Ví dụ:

- observer no-op
- observer ghi file JSONL
- observer đếm metrics in-memory
- observer fan-out sang nhiều backend

đều có thể cùng tuân theo contract này.

### `createNoopObserver()`

Trả về observer không làm gì cả.

Vì sao cần nó?

- để code gọi telemetry không phải kiểm tra `if (observer)` khắp nơi
- để runtime luôn có observer hợp lệ kể cả khi caller không quan tâm telemetry
- để giữ callsite gọn và deterministic

### `createTelemetryEvent(...)`

Helper này chuẩn hóa việc tạo event:

- nhận `type`
- nhận `data`
- tự sinh `timestamp`

Lợi ích:

- callsite trong loop sạch hơn
- shape event luôn nhất quán
- giảm lặp code `new Date().toISOString()` ở nhiều nơi

## Vì sao observer contract giữ nhỏ như vậy

Task này cố ý chưa thêm:

- event id
- trace id
- span id
- parent-child relationships
- severity levels
- batching
- async flush lifecycle

Lý do là hiện tại codebase chỉ cần “clear telemetry”, chưa cần distributed tracing hay observability platform.

Nếu thêm quá sớm, complexity sẽ phình ra rất nhanh mà chưa tạo thêm giá trị thực tế cho MVP.

---

# 2. `src/telemetry/metrics.ts`

Đây là implementation observer in-memory để gom một số counters/timing tối thiểu.

## Những gì metrics observer đang đo

### `turnsStarted`

Tăng khi nhận event `turn_started`.

### `turnsCompleted`

Tăng khi nhận event `turn_completed`.

### `turnsFailed`

Tăng khi nhận event `turn_failed`.

### `totalToolCallsCompleted`

Tăng khi nhận event `tool_call_completed`.

Tên này cố ý phản ánh đúng nghĩa hiện tại của metric: nó đếm số tool call đã hoàn tất, không đếm số tool rounds theo nghĩa một provider cycle có tool. Điều này giúp telemetry rõ ràng hơn khi một response có nhiều tool calls.

Nếu sau này cần sâu hơn, có thể tách thêm các metric khác như:

- số provider cycles có tool
- số tool errors
- số tool calls thành công vs thất bại

### `lastTurnDurationMs`

Khi có `turn_started`, observer lưu một timestamp nội bộ.
Khi có `turn_completed` hoặc `turn_failed`, observer lấy thời điểm hiện tại trừ đi timestamp đó để tính thời lượng turn gần nhất.

## Vì sao metrics chỉ để in-memory

Vì scope task chỉ yêu cầu telemetry tối thiểu, và mục tiêu chính là:

- có thứ gì đó đo được trong test
- có thể snapshot deterministic sau khi chạy turn
- không phải kéo theo storage/config lifecycle

Nếu persist metrics ra file hoặc database ngay lúc này thì task sẽ phình sang một bài toán khác.

## `snapshot()` có vai trò gì

`createInMemoryMetricsObserver()` trả về observer có thêm method:

- `snapshot(): TelemetryMetricsSnapshot`

Điều này rất hữu ích cho test vì test có thể:

1. feed events qua observer thật
2. gọi `snapshot()`
3. assert exact counters mong muốn

Đây là một pattern tốt cho codebase vì nó vừa giữ production code nhỏ, vừa làm test rất rõ ràng.

---

# 3. `src/telemetry/logger.ts`

File này cung cấp backend ghi JSONL ở mức rất nhỏ.

## Hai abstraction chính

### `JsonLineWriter`

Interface:

- `appendLine(line: string): void`

Điểm đáng chú ý là logger không ghi file trực tiếp ngay trong contract chính, mà đi qua writer abstraction.

Lợi ích:

- test có thể dùng fake writer in-memory
- production có thể dùng file writer
- sau này có thể có writer khác mà không phải đổi logger logic

### `createJsonLineLogger(writer)`

Trả về một `TelemetryObserver`.
Khi nhận event, nó serialize event bằng `JSON.stringify(...)` và append thêm newline.

Đây chính là format JSONL tối thiểu:

- mỗi event một dòng
- rất dễ append
- rất dễ inspect bằng command line
- rất dễ pipe sang tooling khác sau này

### `createFileJsonLineWriter(filePath)`

Đây là adapter cụ thể dùng `appendFileSync(...)` để ghi ra file thật.

Task này chưa wire file logger vào CLI mặc định, nhưng file đã sẵn để task sau hoặc caller khác dùng khi cần.

## Vì sao chưa wire logger file mặc định vào CLI

Có ba lý do rất thực dụng:

1. user không yêu cầu persistence cho telemetry trong Task 8
2. nếu tự động ghi file, CLI sẽ cần thêm quyết định về path, rotation, cleanup
3. metrics in-memory đã đủ để chứng minh telemetry được tích hợp thật vào đường chạy

Nói cách khác, `logger.ts` được thêm để hoàn thành lớp telemetry tối thiểu rõ ràng, nhưng chưa bị ép vào runtime mặc định để tránh tăng scope.

---

# 4. `src/agent/runtime.ts`

Task 8 sửa `runtime.ts` để runtime không chỉ gồm provider + tools + cwd, mà còn có thêm observer.

## Trước Task 8

`AgentRuntime` có:

- `provider`
- `availableTools`
- `cwd`

## Sau Task 8

`AgentRuntime` có thêm:

- `observer`

và `CreateAgentRuntimeOptions` cũng nhận thêm:

- `observer?`

Nếu caller không truyền observer, runtime sẽ dùng `createNoopObserver()`.

## Vì sao chỗ này quan trọng

Đây là điểm wire rất hợp lý vì telemetry thực chất là một dependency runtime-level.

Một khi runtime đã có observer, các lớp phía trên như CLI có thể:

- truyền metrics observer vào lúc create runtime
- để loop nhận observer từ runtime
- giữ đường đi dependency rõ ràng

Nó tốt hơn việc để `runAgentTurn(...)` tự ý dựng observer của riêng nó, vì như vậy caller sẽ mất quyền kiểm soát.

---

# 5. `src/agent/loop.ts`

Đây là nơi telemetry được tích hợp thực tế nhất.

Task 8 không thay đổi bản chất core loop của Task 7, nhưng thêm vào các hook quan sát đúng thời điểm.

## Input mới

`RunAgentTurnInput` có thêm:

- `observer?: TelemetryObserver`

Nếu không truyền, loop dùng `createNoopObserver()`.

Ngược lại, `createRepl(...)` hiện không nhận `observer` nữa. REPL chỉ làm orchestration input/output và chuyển text sang `runTurn(...)`; telemetry cấp turn được sở hữu bởi `runAgentTurn(...)` để tránh ghi trùng một lượt chạy.

Điều này giữ backward compatibility cho các caller cũ và làm migration rất nhẹ.

## Các event được phát trong đường chạy turn

### Event 1: `turn_started`

Phát ngay khi loop bắt đầu xử lý turn.

Payload hiện gồm:

- `cwd`
- `userInput`
- `maxToolRounds`
- `toolNames`

Đây là thông tin đủ để biết turn bắt đầu với cấu hình gì.

### Event 2: `provider_called`

Phát ngay trước khi gọi `provider.generate(...)`.

Payload gồm:

- `messageCount`
- `toolNames`

Điểm này giúp quan sát provider đã được gọi bao nhiêu lần và ở thời điểm đó prompt có bao nhiêu message.

### Event 3: `provider_responded`

Phát ngay sau khi provider trả kết quả.

Payload gồm:

- `toolCallCount`
- `assistantContentLength`

Tức là ta biết response đó có bao nhiêu tool calls và độ dài text assistant bao nhiêu ký tự.

### Event 4: `tool_call_started`

Phát trước mỗi lần dispatch tool.

Payload gồm:

- `toolName`
- `toolCallId`

### Event 5: `tool_call_completed`

Phát sau khi dispatch xong một tool call, kể cả khi tool result là lỗi chuẩn hóa.

Payload gồm:

- `toolName`
- `toolCallId`
- `isError`

Điểm này rất hay ở mức MVP vì nó giúp phân biệt được “tool có được xử lý không” và “tool result là success hay error”.

### Event 6: `verification_completed`

Phát trong `buildResult(...)`, sau khi verifier chạy xong.

Payload gồm:

- `isVerified`
- `toolMessagesCount`
- `turnCompleted`

Đây là điểm rất quan trọng vì nó cho thấy verification không bị bỏ qua ở cuối turn.

### Event 7: `turn_completed`

Chỉ phát khi turn thực sự hoàn tất ở nghĩa loop đã nhận được provider stop không còn tool call.

Payload gồm:

- `stopReason`
- `toolRoundsUsed`
- `isVerified`

Tức là event này tóm tắt outcome cuối của một turn completed thật sự.

### Event 8: `turn_stopped`

Phát khi turn dừng sớm vì một stop condition trung gian, hiện tại là `max_tool_rounds_reached`.

Payload cũng gồm:

- `stopReason`
- `toolRoundsUsed`
- `isVerified`

Việc tách event này khỏi `turn_completed` giúp metrics không đếm nhầm một turn bị cắt giữa chừng là completed.

### Event 9: `turn_failed`

Nếu loop throw do lỗi ngoài đường đi chuẩn, event này được phát trong `catch` rồi mới rethrow.

Payload hiện gồm:

- `message`

Điểm này rất có ích vì không làm mất dấu failure trong telemetry.

## Vì sao telemetry được thêm vào `loop.ts` chứ không chỉ ở CLI

Nếu chỉ telemetry ở `main.ts` hoặc `repl.ts`, ta chỉ biết:

- user nhập gì
- CLI trả gì

Nhưng sẽ không biết rõ chuyện gì xảy ra bên trong agent turn.

Ngược lại, đặt event ngay trong `loop.ts` giúp quan sát đúng lớp logic quan trọng nhất:

- provider call
- tool dispatch
- verification
- completion

Đây mới là “telemetry tích hợp thực tế vào đường chạy turn” đúng theo yêu cầu.

## Vì sao chưa phát event chi tiết hơn nữa

Task này cố ý chưa thêm các event như:

- prompt_built
- tool_not_allowed
- tool_error_normalized
- history_appended
- done_criteria_built
- verification_check_item

Không phải vì chúng vô ích, mà vì hiện tại chưa cần. Event list hiện tại đã đủ để theo dõi luồng chính mà không làm event stream quá nhiễu.

---

# 6. `src/cli/repl.ts`

Đây là file mới quan trọng nhất ở lớp CLI runtime.

## Vai trò của file này

Nó đứng giữa CLI entrypoint và core turn runner.

Nói cách khác, `repl.ts` là lớp chuyển từ:

- input text từ người dùng

sang:

- một lần gọi `runTurn(...)`
- output text cho người dùng
- orchestration mức REPL

## Contract chính của `createRepl(...)`

Input `CreateReplOptions` gồm:

- `promptLabel`
- `runTurn(input)`
- `readLine?`
- `writeLine?`

Đây là thiết kế rất đáng giá vì nó làm REPL testable ngay từ đầu.

### `runTurn(input)`

Đây là dependency quan trọng nhất. REPL không tự biết runtime nội bộ là gì. Nó chỉ biết: đưa text vào và nhận một object có:

- `finalAnswer`
- `stopReason`
- `toolRoundsUsed`
- `verification`

Điều này giữ ranh giới rất sạch:

- REPL không phải biết provider/tool loop chi tiết
- test có thể inject fake runTurn rất dễ

### `readLine?` và `writeLine?`

Đây là chìa khóa để không phụ thuộc vào terminal thật trong test.

- production có thể dùng console readline/stdout
- test có thể dùng mảng input/output in-memory

Đây là một quyết định thiết kế rất đúng với yêu cầu “interactive CLI nhưng phải testable”.

## `runOnce(input)` làm gì

Đây là API tối thiểu cho chế độ non-interactive theo prompt.

Nó:

1. gọi `options.runTurn(input)`
2. trả về `{ finalAnswer, stopReason }`

Điểm quan trọng là `runOnce(...)` không tự phát lại các event `turn_started` hay `turn_completed`. Owner của turn-level telemetry hiện là `runAgentTurn(...)`. Cách này tránh double-count khi CLI prompt mode chỉ chạy đúng một agent turn nhưng có nhiều lớp orchestration bao quanh.

## `runInteractive()` làm gì

Đây là vòng lặp interactive tối thiểu.

Nó lặp như sau:

1. đọc một dòng bằng `readLine(promptLabel)`
2. nếu `undefined` thì coi như EOF, in `Goodbye.` và thoát `0`
3. nếu dòng rỗng thì bỏ qua
4. nếu user nhập `/exit` hoặc `exit` thì in `Goodbye.` và thoát `0`
5. còn lại thì gọi `runOnce(trimmed)` và in `finalAnswer`

## Vì sao đây là REPL tối thiểu đúng mức MVP

Nó chưa có:

- history conversation riêng ở lớp REPL
- slash command router
- multi-line input
- command help
- prompt coloring
- streaming token output
- persistent session between turns

Và điều đó là cố ý.

Task chỉ yêu cầu “wire interactive CLI runtime” ở mức đủ dùng. `runInteractive()` như hiện tại đã thỏa mãn:

- có nhập dòng
- có gọi runtime turn runner
- có in câu trả lời
- có lệnh thoát tối thiểu
- có thể test deterministic

## Về implementation `createConsoleReadLine()`

Hàm này dùng `node:readline/promises` và tạo interface mỗi lần đọc một dòng.

Đây không phải thiết kế tối ưu nhất về hiệu năng, nhưng rất ổn cho MVP vì:

- code đơn giản
- vòng đời resource rõ
- dễ fallback nếu EOF/error
- chưa cần quản lý một terminal session phức tạp

Sau này nếu REPL phức tạp hơn, hoàn toàn có thể tối ưu bằng cách giữ một interface sống lâu hơn.

---

# 7. `src/cli/main.ts`

Đây là file chuyển từ stub sang entrypoint runtime thật sự.

## Trước Task 8

`buildCli().run()` luôn trả `0` và không làm gì khác.

## Sau Task 8

`buildCli(options?)` có khả năng:

- parse args tối thiểu
- tạo runtime thật
- dựng REPL
- chạy prompt mode hoặc interactive mode

## `BuildCliOptions`

Task này thêm dependency injection cho CLI test:

- `argv?`
- `cwd?`
- `stdout?`
- `createRuntime?`
- `runTurn?`

Đây là một bước rất đáng giá.

### Vì sao cần injection nhiều như vậy

Nếu `main.ts` hard-code mọi thứ:

- test phải phụ thuộc process thật
- khó chặn stdout
- khó stub runtime
- khó kiểm soát provider/tool behavior

Ngược lại, với injection hiện tại, test có thể:

- truyền argv giả
- truyền stdout giả
- truyền runtime giả
- truyền `runTurn` giả

và xác nhận hành vi CLI rất gọn.

## `parseArgs(argv)`

Task này không thêm `yargs` mà chỉ parse hai flag đơn giản:

- `--prompt`
- `--model`

Parser cũng validate contract tối thiểu:

- thiếu value cho `--prompt` hoặc `--model` là lỗi
- unknown flag là lỗi
- positional argument bất ngờ là lỗi

Vì sao cách này phù hợp?

- user yêu cầu ưu tiên không thêm dependency mới
- nhu cầu hiện tại rất nhỏ
- parser tự viết vẫn đủ exact contract, dễ hiểu, deterministic

Đây là một ví dụ rất điển hình của việc bám scope MVP thay vì làm theo thói quen “CLI thì phải kéo parser library”.

## Luồng `run()` hiện tại

### Bước 1: parse args

Lấy:

- `prompt`
- `model`

### Bước 2: tạo metrics observer

CLI tạo `createInMemoryMetricsObserver()`.

### Bước 3: tạo runtime

Gọi `createRuntime(...)` với:

- `model`
- `cwd`
- `observer: metrics`

Tức là observer được truyền từ lớp CLI xuống runtime ngay từ đầu.

### Bước 4: tạo REPL

REPL được dựng với:

- `promptLabel: 'qiclaw> '`
- `runTurn(userInput)` là wrapper gọi `runAgentTurn(...)`
- `writeLine(...)` ghi ra stdout

### Bước 5A: prompt mode

Nếu có `--prompt`, CLI gọi `repl.runOnce(...)` rồi in `finalAnswer` và thoát `0`.

Nếu parse args fail hoặc runtime throw, CLI in lỗi tối thiểu ra `stderr` và trả exit code `1`.

### Bước 5B: interactive mode

Nếu không có `--prompt`, CLI vào `repl.runInteractive()`.

## Vì sao wire như vậy là đúng

Nó tạo ra đường đi rõ ràng và đúng scope:

`main.ts`
-> parse args
-> `createAgentRuntime(...)`
-> `createRepl(...)`
-> `runAgentTurn(...)`

Đây chính là đường đi CLI -> runtime -> turn runner mà task yêu cầu.

---

## Phân tích test đã thêm/cập nhật

# 1. `tests/cli/repl.test.ts`

File này giờ không chỉ test `buildCli()` có `run` nữa, mà test cả behavior thực tế của REPL và CLI wiring.

## Test 1: `createRepl` chạy một turn và trả final text

Test dựng fake `runTurn(...)` trả `echo: hello`, rồi gọi `repl.runOnce('hello')`.

Test khóa các điều rất quan trọng:

- `runOnce(...)` trả đúng `{ finalAnswer, stopReason }`
- REPL chỉ làm orchestration input/output, không tự thêm side effect telemetry trùng với loop

Điểm này quan trọng vì nó giữ owner của turn-level telemetry nằm ở `runAgentTurn(...)`, tránh double-count trên đường chạy CLI.

## Test 2: metrics observer đếm đúng loop-level telemetry events

Test này feed trực tiếp các event telemetry chuẩn vào `createInMemoryMetricsObserver()` rồi assert snapshot cuối.

Mục tiêu của test là khóa contract của metrics observer độc lập với REPL:

- `turn_started` làm tăng `turnsStarted`
- `tool_call_completed` làm tăng `totalToolCallsCompleted`
- `turn_completed` làm tăng `turnsCompleted`

Cách test này làm rõ nghĩa của metrics mà không lẫn với orchestration của REPL.

## Test 3: `runInteractive()` chạy đến khi user nhập lệnh thoát

Test inject:

- input giả: `['first question', '/exit']`
- output collector là mảng `outputs`

Kỳ vọng:

- REPL gọi `runTurn(...)` cho câu đầu
- in `answer: first question`
- gặp `/exit` thì in `Goodbye.`
- trả exit code `0`

Test này khóa behavior interactive tối thiểu nhưng cốt lõi.

## Test 4: `buildCli()` vẫn trả object có `run`

Đây là smoke test giữ backward confidence.

## Test 5: CLI prompt mode wire được prompt -> runTurn -> stdout

## Test 6: CLI báo lỗi deterministic cho argv không hợp lệ

Các test mới khóa rằng:

- `--prompt` thiếu value sẽ in lỗi rõ ràng ra `stderr` và trả `1`
- unknown flag sẽ in lỗi rõ ràng ra `stderr` và trả `1`

Điểm này rất quan trọng vì nó biến parser nội bộ nhỏ thành một CLI contract exact hơn, thay vì silently fallback sang interactive mode hoặc bỏ qua input sai.

## Test 7: logger serialize đúng một JSONL line cho mỗi event

Test này dùng writer giả in-memory để khóa contract của `createJsonLineLogger(...)`:

- mỗi event thành đúng một dòng
- có newline ở cuối
- JSON parse lại được và giữ đúng `type`/`data`

Test inject:

- `argv: ['--prompt', 'inspect package.json']`
- `stdout` giả
- `createRuntime` giả
- `runTurn` giả

Sau đó assert rằng CLI in ra:

- `handled: inspect package.json\n`

Điểm rất quan trọng là test này chứng minh `main.ts` đã thật sự nối prompt mode với turn runner, chứ không còn là stub.

---

# 2. `tests/agent/loop.test.ts`

Task 8 mở rộng file này để kiểm tra integration telemetry ở ngay lớp core loop.

## Test: loop ghi telemetry event theo thứ tự deterministic

Test dựng:

- workspace tạm với `note.txt`
- scripted provider 2 bước
- metrics observer thật
- observer wrapper thu cả event object và feed vào metrics

Sau đó gọi `runAgentTurn(...)` với observer.

Kỳ vọng event order là:

1. `turn_started`
2. `provider_called`
3. `provider_responded`
4. `tool_call_started`
5. `tool_call_completed`
6. `provider_called`
7. `provider_responded`
8. `verification_completed`
9. `turn_completed`

Đây là test cực quan trọng vì nó khóa chính xác integration telemetry trên success path chuẩn có một tool round.

Ngoài ra còn có test regression cho hai nhánh quan trọng khác:

- khi chạm `max_tool_rounds_reached`, loop phát `turn_stopped` thay vì `turn_completed`
- khi provider throw, loop phát `turn_failed`

Nhờ vậy semantics terminal event không còn bị nhập nhằng giữa completed, stopped và failed.

Ngoài ra test còn assert payload ở một số điểm:

- `turn_started` có đúng `cwd`, `userInput`, `maxToolRounds`, `toolNames`
- `tool_call_started` có đúng `toolName`, `toolCallId`
- `verification_completed` có `isVerified`, `toolMessagesCount`
- `turn_completed` có `stopReason`, `toolRoundsUsed`

Cuối cùng metrics snapshot cũng được assert để chứng minh observer in-memory hoạt động đúng với stream event thật.

## Test runtime helper được cập nhật

Test runtime giờ assert thêm rằng:

- `runtime.observer.record` tồn tại và là function

Điều này khóa contract mới của runtime.

---

## Cách toàn bộ flow hoạt động sau Task 8

Đây là luồng tổng thể của hệ thống sau khi ghép xong task.

### Trường hợp 1: chạy non-interactive với `--prompt`

1. CLI process gọi `buildCli().run()`
2. `main.ts` parse `--prompt` và `--model`
3. CLI tạo metrics observer
4. CLI tạo runtime với provider, built-in tools, cwd và observer
5. CLI tạo REPL với `runTurn(...)` wrapper
6. CLI gọi `repl.runOnce(prompt)`
7. REPL gọi `runAgentTurn(...)`
8. `runAgentTurn(...)` phát telemetry mức loop:
   - `turn_started`
   - `provider_called`
   - `provider_responded`
   - nếu có tool thì `tool_call_started` / `tool_call_completed`
   - `verification_completed`
   - `turn_completed`
9. REPL nhận `finalAnswer`
10. CLI in final answer ra stdout
11. CLI trả exit code `0`

Nếu turn throw ra ngoài đường đi chuẩn, CLI in lỗi tối thiểu ra `stderr` và trả `1`.

### Trường hợp 2: chạy interactive mode

1. CLI không thấy `--prompt`
2. CLI tạo runtime và REPL như trên
3. CLI gọi `repl.runInteractive()`
4. REPL đọc từng dòng input
5. mỗi dòng hợp lệ sẽ đi qua `runOnce(...)`
6. khi nhận `/exit`, `exit` hoặc EOF thì REPL in `Goodbye.` và thoát `0`

---

## Những quyết định thiết kế quan trọng và vì sao hợp lý

# Quyết định 1: không thêm dependency CLI parser mới

Task này không thêm `yargs` dù context nói “nếu cần thêm dependency thì làm, nhưng ưu tiên giải pháp nhỏ nhất”.

Đây là quyết định đúng vì:

- nhu cầu parse args hiện rất nhỏ
- chỉ có `--prompt` và `--model`
- thêm dependency sẽ tăng bề mặt maintenance không cần thiết

Khi scope CLI lớn hơn, hoàn toàn có thể thay parser nội bộ bằng thư viện sau.

---

# Quyết định 2: REPL nhận dependency injection thay vì hard-code I/O

Đây là quyết định rất tốt cho testability.

Nhờ đó test không phải:

- mock global stdin/stdout phức tạp
- spawn child process
- điều khiển terminal thật

Mà chỉ cần truyền function đơn giản.

---

# Quyết định 3: telemetry observer pattern thay vì gọi logger trực tiếp

Nếu `loop.ts` ghi file trực tiếp, coupling sẽ rất cao.

Observer pattern giúp:

- loop không biết backend là gì
- metrics, logger, noop đều interchangeable
- test dễ capture event

Đây là một abstraction đúng mức và rất “MVP-friendly”.

---

# Quyết định 4: telemetry tích hợp trực tiếp trong loop

Đây là phần “đúng chỗ” nhất của task.

Nếu đặt telemetry quá cao ở CLI thì thiếu chi tiết nội bộ.
Nếu đặt quá thấp trong từng tool implementation riêng thì lại phân tán.

`loop.ts` là vị trí cân bằng tốt nhất vì nó thấy toàn bộ orchestration.

---

# Quyết định 5: logger được tạo nhưng chưa ép dùng mặc định

Đây là một cách mở rộng rất sạch.

Codebase đã có đường để ghi JSONL nếu cần, nhưng chưa bị buộc phải:

- chọn path log
- tạo config log file
- cleanup file log

Nghĩa là task đạt yêu cầu telemetry rõ ràng, nhưng không over-engineer.

---

## Những gì Task 8 cố ý chưa làm

Đây là phần rất quan trọng để tránh hiểu nhầm rằng interactive CLI runtime đã “hoàn chỉnh”.

# 1. Chưa có command parser đầy đủ

Hiện tại chỉ parse được vài flag đơn giản.

Chưa có:

- `--help`
- short flags
- subcommands
- validation/help text thân thiện hơn cho người dùng

## Nên để cho task sau nào

Phù hợp với future task về CLI UX hoặc command surface expansion.

---

# 2. Chưa có persistent conversation session trong REPL

`runInteractive()` hiện chạy từng câu độc lập qua wrapper `runTurn(...)`.

Chưa có:

- session id cho interactive mode
- history chung giữa nhiều lượt ở REPL
- checkpoint save/resume trong lúc chat

## Nên để cho task sau nào

Phù hợp với future task về session orchestration hoặc interactive session persistence.

---

# 3. Chưa có streaming output

Hiện tại REPL chỉ in final answer sau khi turn hoàn tất.

Chưa có:

- token streaming
- live tool progress display
- spinner/status line

## Nên để cho task sau nào

Phù hợp với future task về UX hoặc provider streaming integration.

---

# 4. Chưa có telemetry fan-out/composition helper

Hiện tại nếu muốn vừa metrics vừa logger, caller cần tự compose observer.

Chưa có helper kiểu:

- `createCompositeObserver([...])`

## Nên để cho task sau nào

Phù hợp với future task về telemetry plumbing hoặc runtime configuration.

---

# 5. Chưa có structured error policy ở CLI level

`runAgentTurn(...)` đã emit `turn_failed` nếu có exception, nhưng `main.ts` chưa thêm error formatting chi tiết, exit codes phân loại hay retry policy.

## Nên để cho task sau nào

Phù hợp với future task về runtime resilience và CLI error handling.

---

# 6. Chưa có file log path/config mặc định

`logger.ts` đã có đủ primitive ghi JSONL, nhưng chưa được dùng mặc định.

Điều chưa có:

- cờ `--telemetry-log`
- path mặc định trong workspace hoặc user home
- rotation/truncation strategy

## Nên để cho task sau nào

Phù hợp với future task về persistent telemetry/logging configuration.

---

# 7. Chưa có rich command set trong REPL

Hiện mới có:

- nhập text thường
- `exit`
- `/exit`

Chưa có:

- `/help`
- `/tools`
- `/metrics`
- `/history`
- `/reset`

## Nên để cho task sau nào

Phù hợp với future task về REPL commands và operator UX.

---

## Map phần chưa làm sang task sau / future task phù hợp

### Nhóm CLI UX

Các phần chưa làm:

- help text
- help text và usage guidance tốt hơn
- subcommands
- rich REPL commands
- streaming output

Phù hợp với future task kiểu:

- CLI polish
- interactive UX improvements
- streaming response support

### Nhóm session orchestration

Các phần chưa làm:

- giữ history nhiều lượt trong interactive mode
- checkpoint/resume cho chat session
- session-aware prompt building ở CLI layer

Phù hợp với future task kiểu:

- persistent interactive sessions
- session-integrated runtime orchestration

### Nhóm telemetry/logging nâng cao

Các phần chưa làm:

- composite observer
- structured persistent logging config
- tool error counters riêng
- provider latency histograms
- per-event correlation ids

Phù hợp với future task kiểu:

- telemetry expansion
- runtime observability
- diagnostics pipeline

### Nhóm resilience và error handling

Các phần chưa làm:

- CLI-level try/catch rõ ràng hơn
- exit code mapping
- retry policy
- graceful provider failure messaging

Phù hợp với future task kiểu:

- resilient runtime
- CLI failure handling
- retries/timeouts policy

---

## Bài học thiết kế rút ra từ Task 8

# Bài học 1: interactive runtime tốt phải testable từ đầu

Nếu REPL phụ thuộc cứng vào terminal thật, test sẽ rất khó và dễ trở nên mong manh.

Việc inject `readLine`, `writeLine`, `runTurn`, `stdout`, `argv`, `createRuntime` là một quyết định rất đúng. Nó cho phép code production vẫn đơn giản nhưng test thì cực kỳ sạch.

---

# Bài học 2: telemetry nhỏ nhưng đúng điểm chạm có giá trị hơn telemetry dày đặc

Task này không phát hàng chục event. Nó chỉ phát đúng những event cần thiết ở mốc then chốt.

Chính điều đó làm event stream:

- dễ hiểu
- dễ assert
- ít nhiễu
- đủ để debug đường đi chính

---

# Bài học 3: runtime boundary rõ giúp wiring rất tự nhiên

Vì Task 7 đã tách rõ `runtime.ts`, `loop.ts`, `verifier.ts`, `promptBuilder.ts`, nên Task 8 chỉ cần thêm REPL và observer là đã wire được toàn bộ đường đi.

Đây là minh chứng rằng boundary tốt ở các task trước giúp task sau triển khai nhanh và ít phải sửa sâu.

---

# Bài học 4: không phải kế hoạch nào nhắc dependency cũng cần cài dependency đó

Plan ban đầu có nhắc `yargs`, nhưng implementation thực tế đã chọn không thêm vì chưa cần.

Đây là một quyết định rất đáng học: ưu tiên sự phù hợp với hiện trạng codebase và yêu cầu scope nhỏ, thay vì bám máy móc vào một stack dự kiến.

---

# Bài học 5: observer pattern là một abstraction cực hợp cho MVP observability

Observer pattern cho phép thêm khả năng quan sát mà không làm core logic phụ thuộc vào backend cụ thể. Đây là một trong những abstraction “nhỏ nhưng lời” nhất trong task này.

---

## Cách đọc code Task 8 theo thứ tự hợp lý

Nếu muốn học lại task này sau, nên đọc theo thứ tự sau:

1. `/home/locdt/Notes/VSCode/QiClaw/tests/cli/repl.test.ts`
2. `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`
3. `/home/locdt/Notes/VSCode/QiClaw/src/telemetry/observer.ts`
4. `/home/locdt/Notes/VSCode/QiClaw/src/telemetry/metrics.ts`
5. `/home/locdt/Notes/VSCode/QiClaw/src/telemetry/logger.ts`
6. `/home/locdt/Notes/VSCode/QiClaw/src/cli/repl.ts`
7. `/home/locdt/Notes/VSCode/QiClaw/src/cli/main.ts`
8. `/home/locdt/Notes/VSCode/QiClaw/src/agent/runtime.ts`
9. `/home/locdt/Notes/VSCode/QiClaw/src/agent/loop.ts`

Đọc theo thứ tự này sẽ thấy rất rõ:

- test chốt behavior mong muốn
- observer định nghĩa contract nền
- metrics/logger là hai backend nhỏ đầu tiên
- REPL biến turn runner thành trải nghiệm CLI
- main.ts nối toàn bộ đường đi
- runtime và loop là nơi telemetry được gắn vào execution thật

---

## Kết luận

Task 8 là bước hoàn thiện rất quan trọng cho MVP vì nó biến runtime từ một lõi nội bộ đã test tốt thành một CLI runtime có thể chạy thật theo đúng đường đi chuẩn.

Những gì task này mang lại có thể tóm gọn như sau:

- thêm contract telemetry tối thiểu, rõ ràng và dễ mở rộng
- thêm metrics observer in-memory và JSONL logger backend ở mức primitive
- tích hợp telemetry thật vào `runAgentTurn(...)` tại các mốc quan trọng nhất của turn
- thêm `createRepl(...)` để hỗ trợ cả chạy một lượt và chạy interactive loop tối thiểu
- biến `src/cli/main.ts` từ stub thành CLI entrypoint thật sự có wiring với runtime và turn runner
- giữ toàn bộ implementation ở đúng mức MVP, không thêm dependency mới khi chưa thật sự cần
- giữ code testable bằng dependency injection thay vì buộc phải dùng terminal/process thật trong test

Quan trọng nhất, Task 8 không cố giả vờ rằng hệ thống đã có một interactive shell hoàn chỉnh hoặc một telemetry system đầy đủ. Nó chỉ làm đúng phần nền tảng cần có ngay lúc này:

- đường đi CLI -> runtime -> turn runner đã có thật
- telemetry đủ rõ để quan sát turn
- test đủ chắc để refactor tiếp ở các task sau

Đó chính là kiểu tiến hóa rất đúng nhịp cho codebase này: mỗi task mở thêm một capability nhỏ nhưng thật, thay vì thêm quá nhiều abstraction lớn trước khi có nhu cầu thực tế.
