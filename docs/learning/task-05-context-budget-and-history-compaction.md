# Task 05 - Context budget và history compaction tối thiểu

## Mục tiêu của task này

Task 5 thêm lớp quản lý context tối thiểu để runtime bắt đầu kiểm soát độ dài prompt theo cách cơ học, dễ kiểm thử và chưa phụ thuộc vào token counter thật.

Trọng tâm của task này không phải là tạo một bộ prompt optimizer thông minh, mà là khóa một pipeline MVP gồm 4 phần nhỏ:

1. phân bổ ngân sách context thành các bucket cố định
2. giữ lại phần hội thoại gần nhất
3. nén phần lịch sử cũ thành summary cơ học khi vượt ngưỡng
4. ghép các phần prompt thành một system prompt duy nhất rồi prepend vào history

Sau bản vá review này, responsibility cũng được làm rõ hơn:

- `historyPruner` chỉ quyết định giữ recent history nào và có cần tạo `summary` hay không
- `promptBuilder` là nơi duy nhất ghép `historySummary` vào final system prompt/message

User đã chốt lựa chọn thiết kế cho format summary là option 1:

- summary phải mang tính deterministic và mechanical
- các dòng summary được suy ra trực tiếp từ message cũ
- nội dung bị truncate theo rule đơn giản, không dùng paraphrase AI
- khi có tool/tool-result thì cần giữ lại đủ dấu vết để evidence không biến mất hoàn toàn
- phải dễ test bằng equality string

Điều này dẫn đến một quyết định rất quan trọng cho MVP:

- hệ thống không cố gắng "tóm tắt thông minh"
- hệ thống chỉ "rút gọn có kỷ luật" theo char budget và line budget

## Phạm vi đã hoàn thành

Task 5 trong lần này đã thêm các file sau:

- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/budgetManager.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/compactor.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/historyPruner.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/promptBuilder.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/context/budgetManager.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/context/historyPruner.test.ts`

Ngoài ra task này cũng thêm learning doc hiện tại để làm tài liệu học lại.

## Các behavior chính đã được khóa bằng test

### 1. Budget allocator trả đúng 5 bucket

`allocateContextBudget(...)` hiện trả ra đầy đủ các bucket:

- `system`
- `recentHistory`
- `memory`
- `skills`
- `oldHistory`

Test khóa hai điều:

- kết quả phải deterministic
- tổng các bucket phải đúng bằng `total - reserveChars`

Ở implementation hiện tại, allocator dùng tỉ lệ cố định theo heuristic char budget:

- system: 25%
- recentHistory: 35%
- memory: 15%
- skills: 10%
- oldHistory: 15%

Sau khi floor từng phần, remainder được phân phối tiếp theo thứ tự cố định để output không bị dao động.

Điểm đáng chú ý là thứ tự chia remainder cũng là một phần của contract testability. Nếu không chốt rõ thứ tự này, cùng một tổng budget có thể bị lệch 1-2 ký tự giữa các bucket và làm behavior khó dự đoán.

### 2. History pruner giữ recent messages và chỉ compact khi vượt old-history budget

`pruneHistoryForContext(...)` chia transcript thành hai phần:

- `olderMessages`
- `recentMessages`

Cách chia hiện tại rất cơ học:

- lấy `recentMessageCount` message cuối làm recent
- phần còn lại là older

Nếu `olderMessages`:

- không tồn tại, hoặc
- vẫn còn nhỏ hơn hoặc bằng `oldHistoryBudgetChars`

thì pruner trả về history nguyên trạng và không tạo summary.

Ngược lại, nếu older history lớn hơn budget cho phép, pruner sẽ:

- gọi compactor để tạo summary string deterministic
- trả `summary` riêng như metadata
- chỉ giữ lại phần recent history thật trong `messages`

Kết quả trả về gồm:

- `messages`
- `summary`
- `didCompact`

Contract sau bản vá này là:

- `messages` không tự chèn thêm summary `system` message
- `summary` là dữ liệu để caller truyền tiếp vào `promptBuilder` nếu muốn đưa old-history summary vào final prompt

Shape này tránh ambiguity double injection và giữ `promptBuilder` là nơi duy nhất assemble final system prompt.

### 3. Compactor tạo summary theo dòng ngắn, không dùng AI

`compactHistoryMessages(...)` là phần trung tâm của thiết kế option 1.

Input là mảng `Message[]`, output là một string theo format ổn định.

Format hiện tại:

- luôn bắt đầu bằng dòng `History summary:`
- mỗi message cũ sinh ra một dòng dạng `- role: snippet`
- nếu là tool message có `name`, role sẽ thành `tool(name)`
- nội dung được normalize whitespace rồi truncate theo char count

Ví dụ ý tưởng:

- `user` -> `- user: ...`
- `assistant` -> `- assistant: ...`
- `tool` với `name = read_file` -> `- tool(read_file): ...`

Đây là quyết định rất thực dụng:

- người đọc vẫn thấy được loại message nào đã xảy ra
- tool evidence không bị mất trắng trong điều kiện budget còn đủ để chứa thêm line ngoài header
- nếu older history có tool evidence thì compactor sẽ cố giữ lại ít nhất một dòng tool-related evidence theo rule deterministic đơn giản
- summary không cần suy luận semantically
- string output dễ snapshot hoặc assert bằng equality

### 4. Prompt builder ghép prompt parts thành một system prompt duy nhất

`buildPromptWithContext(...)` nhận các phần prompt đã chuẩn bị sẵn:

- `baseSystemPrompt`
- `memoryText`
- `skillsText`
- `historySummary`
- `history`

Builder sẽ:

1. loại bỏ phần rỗng
2. ghép các phần còn lại bằng `\n\n`
3. tạo một `system` message chứa toàn bộ system prompt đã ghép
4. prepend system message đó vào đầu history

Kết quả trả về gồm:

- `systemPrompt`
- `messages`

Đây là một bước nhỏ nhưng quan trọng vì nó chuẩn hóa cách runtime xây prompt đầu vào cho provider ở task sau.

## Workflow TDD đã được áp dụng thế nào

Task này được làm theo đúng vòng đỏ -> xanh -> chỉnh sạch trong phạm vi MVP.

### Bước 1: viết test trước

Trước khi thêm các file context mới, test đã được tạo trước ở:

- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/context/budgetManager.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/context/historyPruner.test.ts`

Các test mới khóa trước các behavior mong muốn:

- budget buckets phải deterministic
- pruner chỉ compact khi older history vượt `oldHistoryBudgetChars`
- compactor phải tạo summary mechanical có dấu vết tool
- khi older history có tool evidence thì summary phải giữ lại ít nhất một dòng tool-related evidence theo rule deterministic
- prompt builder phải prepend system prompt đã ghép

### Bước 2: chạy test để thấy pha đỏ

Lệnh đã chạy ở pha đỏ:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" test -- tests/context/budgetManager.test.ts tests/context/historyPruner.test.ts`

Kết quả fail đúng kỳ vọng vì các module sau chưa tồn tại:

- `src/context/budgetManager.ts`
- `src/context/compactor.ts`
- `src/context/historyPruner.ts`
- `src/context/promptBuilder.ts`

Đây là failure đúng bản chất "feature chưa tồn tại", không phải typo hay assertion sai.

### Bước 3: viết code tối thiểu để pass

Sau khi có pha đỏ rõ ràng, implementation tối thiểu mới được thêm.

Ban đầu green run chưa pass ngay vì một số rule deterministic còn lệch nhỏ:

- thứ tự chia remainder trong budget allocator
- rule truncate của compactor
- cách cắt bớt line cuối khi chạm `maxChars`

Những chỗ này sau đó được chỉnh tiếp ở mức nhỏ nhất để giữ hành vi ổn định và dễ test.

### Bước 4: chạy lại targeted tests để xanh

Cùng lệnh targeted tests ở trên cuối cùng đã pass toàn bộ.

Điểm quan trọng là Task 5 không mở rộng thêm behavior ngoài những gì test yêu cầu. Không có token counter thật, không có heuristic semantic, không có summary bằng model.

## Phân tích chi tiết từng file

### 1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/budgetManager.ts`

File này chịu trách nhiệm duy nhất: chia tổng char budget thành các bucket con.

Các kiểu dữ liệu chính:

- `ContextBudgetBuckets`
- `ContextBudgetAllocation`
- `AllocateContextBudgetInput`

Điểm thiết kế đáng chú ý:

#### a. Budget dựa trên ký tự, không dựa trên token

Task yêu cầu rõ là không dùng token counting library thật. Vì vậy allocator chỉ làm việc với số ký tự.

Ưu điểm:

- deterministic
- không thêm dependency
- test rất đơn giản

Nhược điểm:

- độ chính xác so với token thật còn thấp
- với ngôn ngữ khác nhau, char count và token count có thể lệch đáng kể

Task này chấp nhận nhược điểm đó vì đang ở MVP.

#### b. Reserve được clamp an toàn

`reserveChars` được clamp trong khoảng từ `0` đến `total`.

Nếu reserve lớn hơn total thì:

- `reserved = total`
- `available = 0`
- mọi bucket đều bằng 0

Behavior này giúp allocator không tạo số âm và không yêu cầu caller phải tự xử lý edge case.

#### c. Remainder được chia theo thứ tự cố định

Sau khi chia bằng `Math.floor`, một số ký tự còn dư được phân phối tiếp bằng `REMAINDER_ORDER`.

Đây là chi tiết nhỏ nhưng rất quan trọng cho reproducibility. Nếu chỉ dùng floor mà bỏ remainder hoặc phân remainder không cố định, output sẽ không ổn định khi refactor.

### 2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/compactor.ts`

Đây là file hiện thực hóa summary format option 1.

Các phần chính:

- `CompactHistoryOptions`
- `compactHistoryMessages(...)`
- các helper normalize/truncate/clamp

#### a. Summary được tạo theo line budget

`maxLines` giới hạn số dòng tổng cộng của summary, bao gồm cả header `History summary:`.

Điều này giữ output bounded theo cấu trúc chứ không chỉ theo tổng số ký tự.

#### b. Summary được tạo theo char budget tổng

Ngoài `maxLines`, compactor còn áp dụng `maxChars` cho toàn bộ string summary.

Cách làm hiện tại:

- header cũng bị clamp theo `maxChars`, kể cả khi budget rất nhỏ
- nếu budget đã hết ngay ở header thì trả về header đã bị cắt và dừng
- nếu còn budget thì thử thêm từng line một
- nếu line mới còn fit trong tổng budget thì giữ nguyên
- nếu không fit, cắt line đó theo phần budget còn lại rồi dừng

Hành vi này rất mechanical nên dễ dự đoán.

#### c. Truncate rule cố ý đơn giản

Nội dung message được normalize whitespace rồi truncate theo char count.

Implementation hiện tại giữ một rule cố ý đơn giản:

- nếu text ngắn hơn ngưỡng thì giữ nguyên
- nếu không thì cắt theo số ký tự cố định rồi thêm `…`

Rule này không cố gắng cắt theo từ hay giữ ngữ pháp. Mục tiêu là bounded output chứ không phải readability tối đa.

#### d. Tool evidence được giữ ở cấp line

Nếu message là `tool` và có `name`, compactor ghi thành `tool(name)`.

Ví dụ:

- `tool(search)`
- `tool(read_file)`

Nhờ vậy summary vẫn giữ được bằng chứng là trong quá khứ đã có tool nào được gọi hoặc trả kết quả. Đây là phần quan trọng theo yêu cầu user.

### 3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/historyPruner.ts`

File này điều phối việc giữ nguyên hay compact history.

Nó không tự nghĩ ra summary format, mà chỉ:

- chia recent/older
- đo older char count
- quyết định compact hay không
- trả `summary` riêng và transcript rút gọn không chứa summary đã chèn sẵn

Thiết kế này giữ trách nhiệm khá sạch:

- compactor lo tạo text summary
- pruner lo policy giữ/cắt history
- prompt builder lo inject summary vào final system prompt nếu caller truyền `historySummary`

Đây là tách lớp hợp lý cho các task sau, nơi policy compact có thể thay đổi mà format summary không đổi, hoặc ngược lại.

### 4. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/promptBuilder.ts`

File này là lớp ghép cuối cùng.

Nó không làm compact, không tính budget, không đo char count. Nó chỉ nhận các phần đã sẵn sàng và dựng ra:

- `systemPrompt` string cuối cùng
- mảng `messages` với system prompt được prepend

Giữ file này nhỏ và thuần ghép string giúp test rất dễ đọc và cũng giảm coupling với logic pruner.

## Các contract được chốt sau Task 5

### Contract 1: context budget có 5 bucket cố định

Từ giờ caller có thể kỳ vọng allocator trả đủ:

- system
- recentHistory
- memory
- skills
- oldHistory

Đây là vocabulary quan trọng cho các task tiếp theo.

### Contract 2: old history chỉ bị compact khi vượt old-history budget

Nếu phần older history vẫn còn nằm trong `oldHistoryBudgetChars`, transcript giữ nguyên.

Nghĩa là compact không phải hành vi mặc định, mà là fallback khi older history bắt đầu quá dài.

### Contract 3: summary của old history là text deterministic

Summary hiện không phải output của model. Nó là text cơ học được dựng từ messages cũ.

Điều này chốt một hướng kiến trúc rất khác với "AI summarize history":

- rẻ hơn
- dễ test hơn
- ít bất định hơn
- nhưng kém giàu ngữ nghĩa hơn

### Contract 4: tool continuity được giữ tối thiểu

Task 5 không giữ toàn bộ causal graph của tool call/result, nhưng có giữ đủ dấu vết ở summary lines để tool evidence không mất hẳn.

Rule hiện tại cố ý đơn giản: nếu older history có bất kỳ tool evidence nào và budget còn đủ để chứa line ngoài header, compactor sẽ cố giữ lại ít nhất một dòng tool-related evidence bằng cách giữ các dòng đầu tiên trong phạm vi line budget rồi ép giữ thêm dòng tool evidence cuối cùng nếu cần.

Nói cách khác, đây là best-effort guarantee trong phạm vi line/char budget rất nhỏ, không phải hard guarantee vượt mọi budget.

Đây là mức continuity tối thiểu phù hợp với MVP.

### Contract 5: system prompt cuối cùng là một string thống nhất

Thay vì phát tán nhiều system fragments ở nhiều nơi, prompt builder ghép chúng thành một system prompt duy nhất rồi prepend vào history. Bao gồm cả `historySummary` nếu caller truyền vào.

Đây là contract tiện cho provider side ở task sau.

## Vì sao thiết kế này hợp với MVP

### 1. Dễ kiểm thử hơn semantic summarization

Nếu dùng model hoặc heuristic ngữ nghĩa để tóm tắt, test sẽ khó khóa exact output hơn nhiều.

Cách làm hiện tại cho phép:

- assert equality string
- kiểm tra cụ thể từng line
- tái hiện behavior giống nhau qua nhiều lần chạy

### 2. Dễ debug hơn

Khi summary xấu, ta nhìn vào line output là biết nó được cắt thế nào. Không có lớp suy luận mờ ở giữa.

### 3. Chưa khóa hệ thống vào token library cụ thể

Dùng char budget là đủ để mô phỏng ý tưởng context window mà chưa cần chọn SDK/tokenizer.

### 4. Tách trách nhiệm rõ

- budgetManager: chia ngân sách
- historyPruner: quyết định giữ/cắt history
- compactor: tạo summary string
- promptBuilder: ghép prompt cuối

Tách như vậy giúp mỗi file ngắn, mục tiêu rõ, và unit test độc lập hơn.

## Những gì Task 5 cố ý chưa làm

Đây là phần rất quan trọng để tránh hiểu nhầm rằng Task 5 đã giải xong toàn bộ bài toán context management.

### 1. Chưa có token counting thật

Hiện chưa có:

- tokenizer theo model
- usage estimation chính xác
- reconcile giữa char budget và token budget thật

#### Dự kiến hấp thụ ở task sau

Phù hợp cho một task về provider/runtime integration sâu hơn, nơi prompt thực sự được gửi sang model và cần usage control thật.

### 2. Chưa có memory selection thông minh

`memory` mới chỉ là bucket ở mức allocation vocabulary. Task này chưa thêm cơ chế:

- chọn memory item nào quan trọng hơn
- rank theo recency/frequency
- dedupe memory

#### Dự kiến hấp thụ ở task về memory retrieval

Khi có persistent memory hoặc profile store thật, phần này nên được mở rộng riêng.

### 3. Chưa có skill selection hoặc tool-aware packing thực sự

`skills` hiện chỉ là một bucket để chuẩn bị vocabulary. Chưa có logic:

- chọn skill nào thật sự cần nhét vào prompt
- giảm bớt skill text theo mục tiêu hiện tại
- ưu tiên tool instructions theo tình huống

#### Dự kiến hấp thụ ở task orchestration/prompt assembly nâng cao

### 4. Chưa có semantic grouping cho tool call/result pairs

Task 5 mới chỉ giữ tool evidence ở mức line-based summary. Chưa có logic nhóm:

- assistant tool call
- tool result
- assistant follow-up

thành một causal unit.

#### Dự kiến hấp thụ ở task history compaction nâng cao

Đây là nơi có thể thêm grouping hoặc richer transcript structure nếu cần.

### 5. Chưa có multi-pass compaction

Hiện pruner compact một lần cho phần older history. Chưa có nhiều tầng như:

- keep raw recent
- summarize medium-old
- ultra-compact ancient history

#### Dự kiến hấp thụ ở task context scaling hoặc long-session management

### 6. Chưa tích hợp vào agent loop hoặc provider request thật

Task 5 mới xây các helper độc lập. Chưa có nơi runtime gọi chuỗi:

- allocate budget
- prune history
- build prompt
- gửi provider.generate(...)

#### Dự kiến hấp thụ ở task agent loop/runtime wiring

Đây có lẽ là bước tiếp theo hợp lý để các helper này thực sự tham gia đường đi dữ liệu runtime.

## Những bài học thiết kế rút ra từ Task 5

### Bài học 1: deterministic trước, thông minh sau

Khi hệ thống còn nhỏ và chưa có integration thật, output deterministic thường đáng giá hơn output "hay" nhưng khó khóa bằng test.

### Bài học 2: line-based summary là một điểm cân bằng tốt cho MVP

Một summary hoàn toàn tự do sẽ khó kiểm thử. Một summary quá nghèo chỉ giữ mỗi role thì lại mất thông tin. Dạng `- role: snippet` là mức giữa khá hợp lý.

### Bài học 3: bounded output cần cả line cap lẫn char cap

Chỉ có char cap thì summary có thể thành một khối text khó đọc. Chỉ có line cap thì từng line có thể quá dài. Kết hợp cả hai giúp behavior gọn hơn.

### Bài học 4: preserve tool evidence là requirement kiến trúc, không chỉ là chi tiết UX

Nếu summary xóa sạch dấu vết tools, các task sau rất khó debug transcript behavior. Giữ `tool(name)` trong summary line là một quyết định nhỏ nhưng có giá trị kiến trúc.

## Cách đọc code Task 5 theo thứ tự hợp lý

Nếu muốn học lại sau này, nên đọc theo thứ tự:

1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/context/budgetManager.test.ts`
2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/context/historyPruner.test.ts`
3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/budgetManager.ts`
4. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/compactor.ts`
5. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/historyPruner.ts`
6. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/context/promptBuilder.ts`

Đọc test trước sẽ giúp nhìn ra contract mong muốn. Sau đó mới đọc implementation để thấy mỗi file phục vụ behavior nào.

## Kết luận

Task 5 đã thêm một bộ helper context management tối thiểu nhưng có cấu trúc rõ ràng:

- budget allocator chia context thành 5 bucket cố định
- history pruner giữ recent history và compact old history khi vượt ngưỡng, đồng thời trả summary riêng thay vì tự inject system message
- compactor tạo summary mechanical, deterministic, có best-effort giữ dấu vết tool trong phạm vi budget
- prompt builder ghép prompt parts thành một system prompt duy nhất rồi prepend vào history
- toàn bộ behavior cốt lõi đã được khóa bằng targeted tests

Nói ngắn gọn, sau Task 5 codebase đã đi từ trạng thái "chưa có khái niệm context shaping" sang trạng thái "đã có pipeline tối thiểu để phân bổ budget, cắt lịch sử cũ, và dựng prompt đầu vào theo cách ổn định, dễ test, và đủ nhẹ cho MVP".
