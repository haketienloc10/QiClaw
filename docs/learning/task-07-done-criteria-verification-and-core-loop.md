# Task 07 - Done criteria, verification và core agent loop cho single-agent CLI runtime

## Mục tiêu của task này

Sau Task 6, codebase đã có thêm hai nguồn context quan trọng là memory và skills, đồng thời `promptBuilder` từ Task 5 đã biết cách ghép nhiều phần context lại thành một system prompt hoàn chỉnh. Tuy nhiên, runtime vẫn còn thiếu một phần rất căn bản: chưa có vòng lặp agent thật sự để gọi model, nhận tool call, dispatch tool, quay lại model, rồi quyết định khi nào nên dừng.

Task 7 bổ sung đúng lớp nền đó, nhưng vẫn giữ phạm vi MVP rất chặt. Mục tiêu không phải là xây một planner thông minh, cũng không phải là làm autonomous agent đầy đủ. Mục tiêu là thêm một vòng lặp tối thiểu nhưng ổn định, deterministic và dễ test, gồm bốn phần:

1. `doneCriteria`: mô tả tối thiểu điều kiện nào được xem là “đã xong” cho một goal
2. `verifier`: kiểm tra một cách deterministic xem kết quả cuối có đạt các điều kiện tối thiểu đó chưa
3. `loop`: thực thi một agent turn theo hợp đồng provider/tool hiện có
4. `runtime`: helper ghép provider mặc định + tool mặc định + `cwd`

Nói ngắn gọn, Task 5 và Task 6 đã chuẩn bị dữ liệu và prompt assembly, còn Task 7 thêm “bộ máy quay” nhỏ nhất để những mảnh đó có thể vận hành thành một turn hoàn chỉnh.

## Vì sao cần task này ngay sau Task 6

Task 6 đã giúp hệ thống có thể tạo ra:

- `memoryText`
- `skillsText`

Task 5 trước đó đã giúp hệ thống có thể tạo ra:

- `systemPrompt` cuối cùng từ nhiều nguồn context
- `messages` gửi cho provider

Nhưng ở thời điểm trước Task 7, các phần này vẫn giống như linh kiện đặt sẵn trên bàn:

- có `ModelProvider.generate(...)`
- có `dispatchToolCall(...)`
- có `getBuiltinTools()`
- có `buildPromptWithContext(...)`

Điều còn thiếu là một lớp orchestration thống nhất để nối chúng lại.

Nếu chưa có task này, caller phải tự làm thủ công toàn bộ quy trình:

1. xây history
2. gọi `buildPromptWithContext(...)`
3. gọi `provider.generate(...)`
4. append assistant message
5. nếu có tool call thì dispatch từng tool
6. append tool result
7. lặp lại
8. tự quyết định dừng khi nào
9. tự kiểm tra kết quả cuối có đáng tin ở mức tối thiểu hay chưa

Như vậy sẽ có ba vấn đề:

- logic lặp bị phân tán, khó tái sử dụng
- caller nào cũng có thể xử lý stop condition khác nhau
- chưa có rule xác minh tối thiểu nào cho final answer

Task 7 giải quyết đúng ba vấn đề đó, nhưng chỉ ở mức đủ nhỏ để giữ code dễ hiểu.

## Phạm vi đã hoàn thành

Task 7 thêm và chỉnh sửa các file chính sau:

### File mới trong `src/agent`

- `/home/locdt/Notes/VSCode/QiClaw/src/agent/doneCriteria.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/agent/verifier.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/agent/loop.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/agent/runtime.ts`

### File test

- `/home/locdt/Notes/VSCode/QiClaw/tests/agent/doneCriteria.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`

### File tài liệu học tập

- `/home/locdt/Notes/VSCode/QiClaw/docs/learning/task-07-done-criteria-verification-and-core-loop.md`

## Kết quả chức năng mà task này mang lại

Sau Task 7, codebase đã có các capability mới sau:

1. Có thể xây done criteria tối thiểu từ user goal bằng rule-based parsing đơn giản, deterministic
2. Có thể verify một final answer theo hai trục rõ ràng:
   - answer có rỗng hay không
   - có evidence dùng tool hay không khi goal rõ ràng mang tính inspect/read/search/check
3. Có thể chạy một agent turn hoàn chỉnh:
   - build prompt
   - gọi provider
   - append assistant message
   - dispatch tool tuần tự
   - append tool result
   - lặp tiếp cho đến khi không còn tool call hoặc chạm `maxToolRounds`
4. Có thể tạo runtime mặc định từ provider stub Anthropic + built-in tools + `cwd`

Toàn bộ phần này được khóa bằng test, ưu tiên exact output khi hợp lý.

## Workflow TDD đã được áp dụng như thế nào

Task này được làm theo đúng tinh thần test-first:

1. viết test cho behavior mới
2. chạy test để thấy fail đúng lý do
3. chỉ sau đó mới thêm production code tối thiểu
4. chạy lại targeted tests
5. cuối cùng chạy test, typecheck và build toàn repo

## Bước 1: viết test trước

Hai nơi test chính được tạo/cập nhật trước implementation:

- `/home/locdt/Notes/VSCode/QiClaw/tests/agent/doneCriteria.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`

### Các behavior được khóa trước ở `doneCriteria.test.ts`

#### Behavior 1: goal đơn giản tạo một checklist item duy nhất

Ví dụ:

- input: `Answer with a short greeting.`
- output mong muốn:
  - `checklist = ['Answer with a short greeting.']`
  - `requiresToolEvidence = false`

Điểm quan trọng là test này khóa thiết kế rằng builder không cố “thông minh” quá mức. Nếu goal đã đơn giản, nó giữ nguyên thành một item duy nhất.

#### Behavior 2: goal ghép được tách cơ học thành checklist ổn định

Ví dụ:

- input: `Read package.json and summarize scripts, then inspect tests`
- output mong muốn:
  - `['Read package.json', 'summarize scripts', 'inspect tests']`
  - `requiresToolEvidence = true`
  - có `toolEvidenceReason` exact string

Test này khóa việc split goal chỉ bằng các delimiter đơn giản như:

- `and`
- `then`
- dấu phẩy `,`

Không có NLP phức tạp, không có dependency parser, không có mệnh đề logic sâu hơn.

### Các behavior được khóa trước ở phần verifier

#### Behavior 3: final answer không rỗng thì pass nếu tool evidence không bắt buộc

Test này xác nhận verifier không tự ý thêm rule ngầm nào khác. Với goal chỉ cần trả lời, nếu answer không rỗng thì pass.

#### Behavior 4: nếu goal mang tính inspect/search mà không có tool message thì fail

Đây là hành vi rất quan trọng vì nó tạo ra một lớp kiểm tra tối thiểu chống “hallucinated inspection”. Nếu user bảo search repo hoặc inspect file mà history không có tool activity, verifier phải đánh dấu chưa đạt.

#### Behavior 5: nếu có tool message thành công cho inspection goal thì pass

Test này khóa logic dương tương ứng: phải có ít nhất một tool message thành công (`isError === false`) trong history thì điều kiện evidence mới được xem là thỏa ở mức MVP.

## Bước 2: chạy pha đỏ

Sau khi viết test, lệnh sau được chạy:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/agent/doneCriteria.test.ts tests/agent/loop.test.ts`

Kết quả fail đúng như kỳ vọng vì các file production mới chưa tồn tại:

- `../../src/agent/doneCriteria.js`
- `../../src/agent/loop.js`

Đây là failure đúng bản chất TDD:

- test đã mô tả behavior mới
- production code chưa có
- test fail vì thiếu module, không phải vì typo ngẫu nhiên

## Bước 3: viết production code tối thiểu để pass

Sau khi xác nhận pha đỏ, production code mới được thêm vào.

Điểm quan trọng là implementation được giữ rất cơ học và giới hạn đúng theo test.

## Phân tích chi tiết từng file mới/chỉnh sửa

## 1. `/home/locdt/Notes/VSCode/QiClaw/src/agent/doneCriteria.ts`

Đây là file định nghĩa contract và builder cho done criteria tối thiểu.

### Contract chính

`DoneCriteria` hiện gồm:

- `goal: string`
- `checklist: string[]`
- `requiresNonEmptyFinalAnswer: true`
- `requiresToolEvidence: boolean`
- `toolEvidenceReason?: string`

Thiết kế này rất nhỏ nhưng đủ dùng cho Task 7.

### Vì sao giữ contract nhỏ như vậy

Ở giai đoạn này, done criteria chưa phải một DSL cho planning. Nó chỉ là một object nhỏ để answer câu hỏi:

1. có phải trả lời cuối không?
2. nếu task mang tính inspect thì có cần evidence từ tool không?
3. nếu cần tool evidence thì vì sao?
4. checklist tối thiểu của goal trông như thế nào?

Nếu thêm quá nhiều trường ngay bây giờ như:

- `requiredArtifacts`
- `qualityBars`
- `expectedOutputShape`
- `mustMentionFiles`
- `mustUseSpecificTools`

thì hệ thống sẽ nhanh chóng phình ra trước khi có bằng chứng thực sự rằng caller cần chúng.

### Logic split checklist

`splitGoalIntoChecklist(...)` hiện split theo pattern:

- `and`
- `then`
- `,`

Sau đó mỗi phần được trim và normalize whitespace.

Ví dụ:

- `Read package.json and summarize scripts, then inspect tests`
- trở thành:
  - `Read package.json`
  - `summarize scripts`
  - `inspect tests`

### Vì sao chỉ split cơ học như vậy

Mục tiêu của task là deterministic, không phải semantic parsing.

Lợi ích của cách này:

- dễ giải thích
- dễ test exact string
- không cần dependency mới
- không tạo kỳ vọng sai rằng system hiểu sâu mục tiêu tự nhiên

Nhược điểm là rõ ràng:

- không hiểu phụ thuộc giữa các bước
- không hiểu phủ định
- không biết bước nào quan trọng hơn
- có thể split “ngây thơ” trong vài câu phức tạp

Nhưng đây là trade-off đúng cho MVP.

### Logic nhận diện cần tool evidence

Builder dùng regex rất đơn giản để phát hiện goal có tính inspect, ví dụ chứa các action/phrase như:

- `read`
- `inspect`
- `search`
- `check`
- `review`
- `look at`
- `open`
- `examine`
- `scan`
- `explore`
- `grep`

Nếu match, builder bật:

- `requiresToolEvidence = true`
- `toolEvidenceReason = 'Goal asks for workspace inspection via read/search/check/review actions.'`

Rule này hiện chỉ bật bởi các phrase inspection tương đối rõ như `read`, `inspect`, `search`, `grep`, hoặc các pattern có kèm ngữ cảnh workspace như `check the repo`, `review the codebase`, `scan the workspace`, `open the file`. Nó không còn bật chỉ vì goal có chứa các động từ mơ hồ như `review`, `check`, `open` đứng một mình, và cũng không bật chỉ vì goal có nhắc tới các danh từ như `file`, `repo`, `repository`, `codebase`, hay `tests`.

Điểm quan trọng là rule này không cố chỉ định tool nào bắt buộc. Nó chỉ xác định rằng goal có bản chất inspect workspace, nên completion tối thiểu phải có evidence từ tool execution thành công.

## 2. `/home/locdt/Notes/VSCode/QiClaw/src/agent/verifier.ts`

Đây là file thực hiện verification sau khi loop dừng.

### Input

`verifyAgentTurn(...)` nhận:

- `criteria: DoneCriteria`
- `finalAnswer: string`
- `history: Message[]`

### Output

`AgentTurnVerification` hiện gồm:

- `isVerified`
- `finalAnswerIsNonEmpty`
- `toolEvidenceSatisfied`
- `toolMessagesCount`
- `checks`

Trong đó `checks` là danh sách rõ ràng từng bước kiểm tra.

### Rule 1: final answer phải non-empty

Logic rất cơ học:

- `finalAnswer.trim().length > 0`

Nếu pass:

- details = `Final answer is non-empty.`

Nếu fail:

- details = `Final answer is empty.`

Đây là rule cực tối thiểu nhưng có giá trị vì nó tách rõ một stop condition “provider dừng” với một completion condition “đầu ra dùng được ở mức tối thiểu”.

### Rule 2: tool evidence khi goal yêu cầu inspection

Verifier đếm số message có `role === 'tool'` và `isError === false` trong history.

Điểm này rất quan trọng: tool error không được xem là evidence hợp lệ cho inspection goal. Nói cách khác, “đã cố gọi tool nhưng tool fail” không tương đương với “đã thật sự inspect được workspace”.

Nếu `criteria.requiresToolEvidence === false`:

- rule này auto-pass với message `Tool evidence not required for this goal.`

Nếu `criteria.requiresToolEvidence === true`:

- pass khi `toolMessagesCount > 0`
- fail nếu không có tool message thành công nào

Điểm rất quan trọng là verifier hiện mới chỉ phân biệt được một lớp tối thiểu:

- tool success hay tool error

Nó vẫn chưa phân biệt sâu hơn:

- loại tool nào được dùng
- tool output có đủ chất lượng hay không
- final answer có grounded vào tool output hay không

Lý do là Task 7 chỉ yêu cầu deterministic evidence ở mức tối thiểu: phải có tool activity thành công khi goal rõ ràng mang tính inspection.

### Vì sao không verify sâu hơn ngay bây giờ

Có thể tưởng tượng nhiều mức verification phức tạp hơn:

- goal nói read file thì phải có đúng `read_file`
- goal nói search repo thì phải có `search`
- tool result phải không phải error
- final answer phải trích dẫn nội dung từ tool output

Tất cả những thứ đó đều hợp lý về lâu dài, nhưng chưa phù hợp ở MVP vì:

1. contract goal parsing hiện chưa đủ giàu để map chắc chắn sang tool cụ thể
2. verification càng chặt thì false negative càng dễ tăng
3. Task 7 ưu tiên một lớp safety net đơn giản, không ưu tiên policy sâu

## 3. `/home/locdt/Notes/VSCode/QiClaw/src/agent/loop.ts`

Đây là phần trung tâm của Task 7.

### Input chính của `runAgentTurn(...)`

Hàm nhận:

- `provider`
- `availableTools`
- `baseSystemPrompt`
- `userInput`
- `cwd`
- `maxToolRounds`
- tùy chọn:
  - `memoryText`
  - `skillsText`
  - `historySummary`
  - `history`

### Vì sao input được thiết kế như vậy

Thiết kế này bám sát các subsystem đã có sẵn:

- provider contract từ Task 4
- prompt builder từ Task 5
- memory/skills text từ Task 6

Nó không tự recall memory hay tự chọn skills. Nó chỉ nhận các phần text đã được caller chuẩn bị. Điều này giữ đúng ranh giới trách nhiệm:

- selection/recall nằm ở lớp khác
- `runAgentTurn(...)` chỉ lo orchestration một turn

### Cách khởi tạo history

Loop tạo history runtime bằng cách ghép:

- `input.history ?? []`
- thêm user message mới từ `userInput`

Điểm này giúp hàm hỗ trợ cả hai tình huống:

- turn độc lập hoàn toàn
- turn tiếp nối từ history trước đó

### Cách build prompt mỗi vòng

Mỗi iteration, loop gọi `buildPromptWithContext(...)` với:

- `baseSystemPrompt`
- `memoryText`
- `skillsText`
- `historySummary`
- `history`

Sau đó lấy `prompt.messages` để gửi vào `provider.generate(...)`.

Điều đáng chú ý là `buildPromptWithContext(...)` luôn prepend một `system` message mới được build từ đầy đủ context hiện tại. Vì vậy mỗi vòng model đều nhận được cùng một system prompt thống nhất cộng với history tích lũy.

### Cách xử lý phản hồi từ provider

Sau mỗi lần `provider.generate(...)`:

1. append `response.message` vào history
2. cập nhật `finalAnswer` bằng `response.message.content`
3. nếu `toolCalls.length === 0` thì xem như model đã dừng gọi tool

Khi model dừng gọi tool, loop không tự phán “đã xong” chỉ vì provider dừng. Nó tiếp tục chạy:

- `buildDoneCriteria(userInput)`
- `verifyAgentTurn(...)`

và trả `RunAgentTurnResult` đầy đủ.

### Cách dispatch tool calls

Nếu provider trả `toolCalls`, loop:

1. kiểm tra đã chạm `maxToolRounds` chưa
2. tăng `toolRoundsUsed`
3. kiểm tra tool call đó có nằm trong `availableTools` của turn hiện tại không
4. nếu không được phép, tạo `ToolResultMessage` lỗi chuẩn hóa `Tool not allowed for this turn: <name>`
5. nếu được phép, dispatch tuần tự qua `dispatchToolCall(...)`
6. append từng `ToolResultMessage` vào history

### Vì sao tool calls được dispatch tuần tự

Task spec yêu cầu tuần tự, và đây cũng là lựa chọn đúng cho MVP vì:

- đơn giản
- deterministic
- tránh phải giải quyết race condition hay merge order
- bám sát cách nhiều model hiện mô tả tool use theo chuỗi reasoning -> action -> observation

Nếu sau này cần parallel tool execution, đó nên là một task riêng vì nó kéo theo thay đổi ở order semantics và verification.

### Stop reason

`RunAgentTurnResult` hiện có hai stop reason:

- `'completed'`
- `'max_tool_rounds_reached'`

#### `completed`

Xảy ra khi provider trả về không còn tool call.

#### `max_tool_rounds_reached`

Xảy ra khi loop không được phép tiếp tục chạy thêm vòng tool nữa.

Điểm quan trọng là ngay cả khi dừng vì max rounds, loop vẫn trả:

- `finalAnswer`
- `history`
- `doneCriteria`
- `verification`

Nhưng `verification` trong trường hợp này không được xem là completion thành công. Lý do là turn bị cắt trước khi provider tạo ra một final answer sau khi đã quan sát tool results. Nói cách khác, caller vẫn có trạng thái đầy đủ để quyết định bước tiếp theo, nhưng không nên coi turn đó là “đã xong”.

### Một điểm thiết kế đáng chú ý về max rounds

Implementation hiện dừng deterministic ngay sau khi đã xử lý xong số vòng tool cho phép cuối cùng, thay vì cố gọi thêm provider một lần nữa. Điều này giúp:

- không phát sinh một lượt model call thừa
- giữ `toolRoundsUsed` rất rõ nghĩa
- stop condition dễ test hơn

Ví dụ:

- `maxToolRounds = 1`
- provider ở vòng đầu trả assistant message + 1 tool call
- loop dispatch tool xong
- vì đã dùng hết 1 vòng tool, loop trả `max_tool_rounds_reached`

Không có attempt bí ẩn nào sau đó.

### Output cuối cùng

`RunAgentTurnResult` hiện gồm:

- `stopReason`
- `finalAnswer`
- `history`
- `toolRoundsUsed`
- `doneCriteria`
- `verification`

Đây là shape đủ giàu để caller:

- in câu trả lời cuối
- debug full history
- biết loop dừng do completed hay max rounds
- biết verification pass hay fail

## 4. `/home/locdt/Notes/VSCode/QiClaw/src/agent/runtime.ts`

File này rất nhỏ, nhưng nó gom ba dependency nền thường đi cùng nhau:

- provider mặc định từ `createAnthropicProvider(...)`
- built-in tools từ `getBuiltinTools()`
- `cwd`

### Vì sao runtime helper này có ích

Nếu caller nào cũng phải tự viết:

- tạo provider
- lấy builtin tools
- gói cùng cwd

thì sẽ lặp nhiều boilerplate.

`createAgentRuntime(...)` giúp chốt một constructor mặc định rất rõ:

- input: `{ model, cwd }`
- output: `{ provider, availableTools, cwd }`

Điểm này nhỏ nhưng quan trọng vì nó tạo một entrypoint runtime nền cho các task sau.

## 5. `/home/locdt/Notes/VSCode/QiClaw/tests/agent/doneCriteria.test.ts`

Đây là test file mới hoàn toàn.

### Phần test cho builder

Khóa các rule sau:

- goal đơn thì checklist giữ nguyên
- goal ghép thì split deterministic
- inspection-style goal thì `requiresToolEvidence = true`

### Phần test cho verifier

Khóa các rule sau:

- answer không rỗng thì pass nếu không cần tool evidence
- inspection goal mà không có tool message thành công thì fail
- inspection goal có tool message thành công thì pass

Điểm tốt ở file này là đa số test dùng exact object equality, giúp behavior của verifier rất minh bạch.

## 6. `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`

File test cũ đã được mở rộng thêm phần lớn để bao phủ core loop và runtime.

### Behavior 1: loop chạy qua tool rồi mới trả final answer

Test này tạo một scripted provider gồm hai response:

1. response đầu:
   - assistant nói sẽ đọc file
   - trả tool call `read_file`
2. response sau:
   - assistant trả final answer
   - không còn tool call

Test khóa các điều sau:

- `runAgentTurn(...)` thực sự gọi tool
- tool result được append vào history
- provider được gọi lần 2 với tool observation đã có trong messages
- `stopReason = 'completed'`
- `toolRoundsUsed = 1`

### Behavior 2: optional prompt context được đưa vào prompt assembly

Test này xác nhận rằng nếu caller truyền:

- `memoryText`
- `skillsText`
- `historySummary`
- `history`

thì `buildPromptWithContext(...)` được phản ánh đúng vào request gửi provider.

Đây là test quan trọng vì nó chứng minh loop đã nối đúng với công việc từ Task 5 và Task 6, chứ không chỉ chạy raw user input.

### Behavior 3: tool không được phép ở turn hiện tại bị chặn một cách graceful

Provider cố ý gọi một tool không nằm trong `availableTools` của turn hiện tại.

Kỳ vọng:

- loop không throw
- loop chặn sớm trước khi execute thật
- loop tạo `ToolResultMessage` lỗi chuẩn hóa dạng `Tool not allowed for this turn: <name>`
- message lỗi đó vẫn được append vào history
- provider vẫn có thể trả final answer ở lượt sau
- verifier không tính lỗi này là inspection evidence thành công

Đây là behavior rất tốt cho runtime robustness: lỗi chính sách thực thi được chuyển thành observation có cấu trúc thay vì làm vỡ cả vòng lặp.

### Behavior 4: max rounds trả kết quả dừng deterministic

Test này khóa exact stop behavior khi provider tiếp tục đòi tool quá số vòng cho phép.

Kỳ vọng:

- `stopReason = 'max_tool_rounds_reached'`
- `toolRoundsUsed` phản ánh đúng số vòng đã dùng
- verification vẫn chạy
- `verification.isVerified = false` vì turn chưa hoàn tất sau tool observation
- `finalAnswer` vẫn giữ assistant message gần nhất trước khi bị cắt

### Behavior 5: runtime helper compose đúng provider + tools + cwd

Test này xác nhận `createAgentRuntime(...)` tạo đúng:

- provider anthropic stub
- builtin tools theo thứ tự ổn định
- cwd caller truyền vào

## Cách hoạt động của done criteria / verifier / loop / runtime khi ghép lại

Đây là luồng đầy đủ của một agent turn sau Task 7.

## Bước 1: caller chuẩn bị input

Caller có thể chuẩn bị:

- base system prompt
- user input
- cwd
- max tool rounds
- tùy chọn memory text / skills text / history summary / prior history

## Bước 2: loop xây initial history

Loop tạo history runtime từ:

- prior history nếu có
- cộng thêm user message mới

## Bước 3: loop build prompt qua `promptBuilder`

Prompt builder ghép:

- base system prompt
- memory text
- skills text
- history summary

thành một `systemPrompt` duy nhất và prepend nó vào messages.

## Bước 4: provider generate assistant message + tool calls

Provider trả:

- một assistant message
- danh sách tool calls

Loop luôn append assistant message vào history trước.

## Bước 5A: nếu không có tool call

Loop xem như model đã dừng gọi tool. Lúc này nó chưa dừng ngay về mặt “đã xong”, mà còn:

1. build done criteria từ user goal
2. chạy verifier với final answer và history
3. trả structured result

## Bước 5B: nếu có tool call

Loop duyệt từng tool call tuần tự.

Với mỗi tool call, nó làm hai lớp xử lý:

1. enforce allow-list của turn hiện tại từ `availableTools`
2. nếu tool được phép thì mới dispatch thật qua `dispatchToolCall(...)` với `cwd` hiện tại

Nếu tool không nằm trong allow-list, loop không execute thật mà tạo một `ToolResultMessage` lỗi chuẩn hóa dạng `Tool not allowed for this turn: <name>`.

Mỗi tool result:

- thành `ToolResultMessage`
- được append vào history

Sau đó loop quay lại Bước 3 với history mới.

## Bước 6: nếu chạm `maxToolRounds`

Loop trả kết quả stop deterministic:

- không gọi model thêm
- vẫn chạy verifier
- vẫn trả history đầy đủ

Nói cách khác, max rounds là stop condition của vòng lặp, không phải lý do để bỏ qua verification.

## Các quyết định thiết kế quan trọng

## 1. Done criteria là rule-based, không dùng NLP mạnh

Đây là quyết định đúng nhất của Task 7.

Lý do:

- task yêu cầu deterministic
- codebase hiện chưa có planner/parsing layer riêng
- regex + split đơn giản đủ cho MVP
- exact tests dễ viết và dễ giữ ổn định

Nếu dùng heuristics phức tạp quá sớm, chi phí debug sẽ tăng rất nhanh.

## 2. Verification chỉ kiểm tra hai điều tối thiểu

Verifier chỉ check:

- answer không rỗng
- có tool evidence khi cần

Thiết kế này intentionally nhỏ. Nó không pretend rằng hệ thống đã có semantic verification.

Điểm mạnh của cách này là:

- dễ hiểu
- chi phí thấp
- thêm một lớp guardrail có ý nghĩa thực tế

## 3. Tool evidence chỉ cần “có tool message thành công”, chưa cần đúng tool

Quyết định này nghe có vẻ lỏng, nhưng là mức cân bằng hợp lý ở Task 7.

Nếu ép quá chặt ngay bây giờ, builder phải hiểu goal sâu hơn để map:

- read -> `read_file`
- search -> `search`
- edit -> `edit_file`

Mà codebase hiện chưa có lớp semantic mapping đó. Vì vậy evidence ở mức presence là đủ cho task này.

## 4. Loop không tự recall memory hay chọn skill

Loop chỉ nhận các string context đã được caller chuẩn bị.

Điều này giúp:

- ranh giới trách nhiệm rõ ràng
- loop không bị gắn chặt với storage/selection policy
- các task sau có thể thay memory/skill selection mà không cần sửa core loop

## 5. Runtime helper rất nhỏ nhưng hữu ích

Thay vì xây một runtime framework lớn, task chỉ thêm một helper compose tối thiểu. Đây là cách mở rộng đúng nhịp với codebase hiện tại.

## Những gì Task 7 cố ý chưa làm

Đây là phần rất quan trọng để tránh hiểu nhầm rằng agent runtime đã “hoàn chỉnh”.

## 1. Chưa có semantic planning thật sự

Done criteria hiện không phải planner.

Chưa có:

- phân rã goal theo dependency graph
- phân biệt hard requirement và soft requirement
- ước lượng cần bao nhiêu vòng tool
- kế hoạch trung gian trước khi hành động

### Nên để cho task sau nào

Phù hợp với task planner / task decomposition / execution planning sau này.

## 2. Chưa verify chất lượng nội dung final answer

Verifier hiện không kiểm tra:

- answer có đúng với tool output không
- answer có bao phủ hết checklist không
- answer có trích file/path đúng không
- answer có tự mâu thuẫn không

### Nên để cho task sau nào

Phù hợp với task output validation hoặc response-grounding verification.

## 3. Chưa verify loại tool cụ thể

Nếu goal nói “read file”, verifier hiện chỉ cần thấy có một `tool` message bất kỳ.

Nó chưa ép phải có đúng `read_file`.

### Nên để cho task sau nào

Phù hợp với task richer done criteria / action expectations mapping.

## 4. Chưa có xử lý prompt budget trong loop

Loop hiện dùng `buildPromptWithContext(...)` nhưng không tự cắt history theo budget, không summarize động và không adaptive theo token budget.

### Nên để cho task sau nào

Phù hợp với task context-window management hoặc long-running conversation loop.

## 5. Chưa có retry policy cho provider hoặc tool

Nếu provider fail hoặc tool fail, task này không thêm retry orchestration riêng.

Tool failure hiện chỉ được chuẩn hóa nếu lỗi xảy ra bên trong dispatcher path; provider failure thì vẫn propagate ra ngoài.

### Nên để cho task sau nào

Phù hợp với task runtime resilience / retries / timeout policy.

## 6. Chưa có parallel tool execution

Tool calls hiện chạy tuần tự.

### Nên để cho task sau nào

Phù hợp với task performance optimization hoặc advanced tool orchestration.

## 7. Chưa có persistent session runtime

Task 7 mới xử lý một turn in-memory.

Chưa có:

- session manager gắn trực tiếp với loop
- auto-checkpoint khi qua từng vòng tool
- resume execution giữa chừng

### Nên để cho task sau nào

Phù hợp với task session orchestration / checkpoint-integrated runtime.

## Map phần chưa làm sang task sau hoặc future task phù hợp

Để dễ nhìn hơn, có thể map như sau:

### Nhóm planning và decomposition

Các phần chưa làm:

- phân rã goal tốt hơn
- dependency giữa sub-steps
- expected artifacts

Nên đi vào future task kiểu:

- planner layer
- decomposition engine
- execution plan generation

### Nhóm verification nâng cao

Các phần chưa làm:

- grounding answer vào tool output
- checklist coverage validation
- tool-specific expectation

Nên đi vào future task kiểu:

- answer verifier
- grounded response checker
- richer success criteria engine

### Nhóm runtime robustness

Các phần chưa làm:

- retry policy
- timeout policy
- provider failure handling
- circuit breaker đơn giản

Nên đi vào future task kiểu:

- resilient runtime
- provider/tool error recovery

### Nhóm context management

Các phần chưa làm:

- budget-aware pruning trong lúc loop chạy
- dynamic summarization
- memory/skills selection thật sự trong runtime

Nên đi vào future task kiểu:

- adaptive context manager
- memory/skills integration into runtime loop

### Nhóm orchestration nâng cao

Các phần chưa làm:

- parallel tool execution
- multi-agent handoff
- background tasks

Nên đi vào future task kiểu:

- advanced orchestration
- multi-step execution runtime

## Bài học thiết kế rút ra từ Task 7

## Bài học 1: “provider dừng” không đồng nghĩa với “task hoàn thành”

Đây là insight quan trọng nhất của task.

Một model có thể trả final answer và không gọi thêm tool, nhưng điều đó không đảm bảo rằng answer đạt tối thiểu những gì goal yêu cầu. Vì vậy cần tách:

- stop condition của loop
- verification condition của outcome

Task 7 chính là bước đầu để tách hai chuyện này ra.

## Bài học 2: verification nhỏ nhưng deterministic tốt hơn verification “thông minh” mơ hồ

Một verifier chỉ kiểm tra 2 điều nhưng luôn nhất quán có giá trị hơn một verifier có vẻ “thông minh” nhưng khó giải thích.

Trong nền móng runtime, determinism là tài sản rất lớn vì:

- test dễ viết
- debug dễ hơn
- refactor an toàn hơn

## Bài học 3: orchestration nên nhận policy từ ngoài thay vì tự ôm hết

Loop không tự recall memory, không tự chọn skill, không tự quản budget. Đây không phải thiếu sót, mà là giữ boundary đúng.

Một core loop tốt nên tập trung vào:

- call model
- call tools
- update history
- stop đúng lúc
- trả trạng thái đầy đủ

Policy cao hơn có thể được thêm ở lớp trên sau.

## Bài học 4: tool failures nên được chuẩn hóa thành observations

Việc tool bị chặn bởi allow-list hoặc lỗi tool ở dispatcher path được đưa thành `ToolResultMessage` thay vì throw vỡ toàn bộ loop là một quyết định rất thực dụng. Nó cho phép model hoặc caller nhìn thấy “observation lỗi” như một phần của history, thay vì mất toàn bộ tiến trình.

## Bài học 5: runtime helper nhỏ có thể mở đường cho API lớn hơn sau này

`createAgentRuntime(...)` hiện rất khiêm tốn, nhưng nó tạo ra một điểm ghép rõ ràng cho codebase. Sau này nếu thêm config, timeout, memory store, skill registry hoặc logger, hoàn toàn có thể mở rộng từ đây.

## Cách đọc code Task 7 theo thứ tự hợp lý

Nếu muốn học lại task này sau, nên đọc theo thứ tự sau:

1. `/home/locdt/Notes/VSCode/QiClaw/tests/agent/doneCriteria.test.ts`
2. `/home/locdt/Notes/VSCode/QiClaw/tests/agent/loop.test.ts`
3. `/home/locdt/Notes/VSCode/QiClaw/src/agent/doneCriteria.ts`
4. `/home/locdt/Notes/VSCode/QiClaw/src/agent/verifier.ts`
5. `/home/locdt/Notes/VSCode/QiClaw/src/agent/loop.ts`
6. `/home/locdt/Notes/VSCode/QiClaw/src/agent/runtime.ts`
7. `/home/locdt/Notes/VSCode/QiClaw/src/context/promptBuilder.ts`
8. `/home/locdt/Notes/VSCode/QiClaw/src/provider/model.ts`
9. `/home/locdt/Notes/VSCode/QiClaw/src/agent/dispatcher.ts`

Đọc theo thứ tự này sẽ thấy rõ nhịp phát triển:

- test chốt behavior
- done criteria xác định “xong là gì”
- verifier xác định “đã đạt chưa”
- loop nối provider, prompt, tool dispatch và history
- runtime helper đóng gói dependency mặc định

## Kết luận

Task 7 là bước chuyển rất quan trọng từ “có các mảnh runtime rời rạc” sang “có một vòng lặp agent tối thiểu chạy được”.

Những gì task này mang lại có thể tóm gọn như sau:

- thêm done criteria builder theo rule-based, deterministic và dễ giải thích
- thêm verifier tối thiểu để kiểm tra final answer không rỗng và có tool evidence khi goal yêu cầu inspection
- thêm core loop cho một agent turn, nối prompt builder, provider và dispatcher lại với nhau
- thêm runtime helper để compose provider mặc định, tools mặc định và cwd
- thêm test khá đầy đủ cho các đường đi chính, bao gồm success path, prompt assembly, missing tool và max rounds
- giữ toàn bộ phạm vi ở đúng mức MVP, chưa cố giải quyết planning sâu, verification sâu hay runtime resilience nâng cao

Sau Task 7, codebase đã có một “xương sống” runtime rõ ràng hơn rất nhiều. Nó chưa phải một agent framework hoàn chỉnh, nhưng đã là nền tảng đủ tốt, đủ sạch và đủ deterministic để các task tiếp theo có thể xây tiếp các lớp policy, planning, memory wiring, verification nâng cao và orchestration mạnh hơn.
