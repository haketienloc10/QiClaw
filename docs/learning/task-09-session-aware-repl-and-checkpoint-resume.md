# Task 09 - Session-aware REPL và auto-resume latest checkpoint cho single-agent CLI runtime

## Mục tiêu của task này

Sau Task 8, CLI đã có đường đi chạy thật:

- `CLI -> REPL -> runtime -> runAgentTurn(...)`
- có telemetry tối thiểu
- có interactive loop
- có one-shot prompt mode qua `--prompt`

Nhưng REPL ở thời điểm đó vẫn còn một giới hạn rất rõ:

- mỗi lượt interactive thực chất vẫn là một single-turn độc lập
- câu hỏi sau không nhớ câu hỏi trước
- checkpoint subsystem đã tồn tại nhưng chưa được nối vào interactive CLI
- mở lại CLI interactive cũng không tự resume session gần nhất

Điều này tạo ra một khoảng trống kiến trúc khá quan trọng.

Ta đã có:

- engine cho một turn
- REPL để nhập nhiều lần
- checkpoint store để lưu snapshot

Nhưng ba phần đó vẫn chưa ghép lại thành một “session runtime” đúng nghĩa.

Task 09 giải quyết đúng khoảng trống đó bằng một bước polish nhỏ nhưng rất quan trọng:

1. interactive CLI giữ shared history giữa nhiều lượt trong cùng process
2. interactive CLI tự load checkpoint mới nhất theo `cwd` khi khởi động
3. nếu checkpoint hợp lệ thì resume session cũ
4. nếu checkpoint không hợp lệ hoặc chưa có checkpoint thì tạo session mới
5. sau mỗi turn interactive, checkpoint mới nhất được lưu lại
6. `--prompt` vẫn giữ nguyên là one-shot stateless

Nói ngắn gọn: Task 8 làm cho CLI “chạy được”, còn Task 9 làm cho interactive CLI “có trí nhớ phiên làm việc”.

---

## Phạm vi implementation đã hoàn thành

### File mới

- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/docs/learning/task-09-session-aware-repl-and-checkpoint-resume.md`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/tests/session/session.test.ts`

### File được chỉnh sửa

- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/src/cli/main.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/src/session/session.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/src/session/checkpointStore.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/src/core/types.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/tests/cli/repl.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor/tests/session/checkpointStore.test.ts`

---

## Kết quả chức năng mà Task 09 mang lại

Sau task này, interactive CLI có thêm các capability sau:

1. Có session state tối thiểu ở lớp orchestration:
   - `sessionId`
   - `history`
   - `historySummary`
2. Khi mở interactive mode, CLI tự tìm local checkpoint DB theo `cwd`
3. CLI tự lấy latest checkpoint bằng `CheckpointStore.getLatest()`
4. CLI chỉ resume nếu checkpoint parse hợp lệ
5. Nếu checkpoint hỏng hoặc sai shape, CLI bỏ qua và tạo session mới
6. Sau mỗi turn interactive `completed` hoặc `max_tool_rounds_reached`, checkpoint mới được save lại
7. Nếu `historySummary` cũ đã được restore mà turn mới không trả summary mới, summary cũ vẫn được giữ
8. `--prompt` mode vẫn stateless, không đụng checkpoint load/save
9. Checkpoint parser bây giờ validate đúng tool message shape khi restore
10. Latest checkpoint lookup deterministic ngay cả khi `updatedAt` bị trùng nhau

Điểm rất quan trọng ở đây là session-awareness không bị nhét xuống `runAgentTurn(...)`. Core loop vẫn là single-turn engine; chỉ có CLI orchestration trở nên stateful.

---

## Vì sao task này cần làm ngay sau Task 8

Task 8 đã tạo ra interactive loop, nhưng interactive loop đó chỉ là “nhiều turn độc lập nối tiếp nhau”.

Tức là user có thể gõ:

- câu 1
- câu 2
- câu 3

nhưng engine không thật sự biết rằng ba câu này thuộc cùng một session.

### Hệ quả của giới hạn đó

#### 1. Không có conversational continuity thực sự

Nếu lượt 1 vừa đọc file xong, lượt 2 vẫn không có history của lượt 1 nếu orchestration không truyền nó vào.

#### 2. Checkpoint subsystem bị treo lơ lửng

Codebase đã có `CheckpointStore`, nhưng CLI chưa dùng nó để resume interactive session.

#### 3. REPL chưa giống một agent runtime thật

Một agent CLI hữu ích thường cần ít nhất một mức session continuity tối thiểu. Nếu không, interactive mode chỉ là wrapper mỏng cho các one-shot turn.

Task 09 chính là bước nối ba phần đã có sẵn lại với nhau:

- REPL loop
- single-turn engine
- checkpoint persistence

---

## Ý tưởng thiết kế cốt lõi của Task 09

Nguyên tắc quan trọng nhất của task này là:

**session-awareness phải nằm ở lớp orchestration, không nằm ở REPL I/O loop và cũng không bị đẩy vào single-turn engine.**

Điều đó dẫn tới boundary rất rõ:

### `src/cli/repl.ts`

Chỉ lo:

- đọc input
- gọi `runTurn(...)`
- in output
- xử lý `/exit`

REPL không biết checkpoint là gì, session là gì, resume là gì.

### `src/agent/loop.ts`

Chỉ lo một turn:

- build prompt
- gọi provider
- xử lý tool loop
- verify kết quả

Nó chỉ nhận:

- `history`
- `historySummary`

nếu caller cung cấp.

Nó không biết checkpoint DB là gì, không biết latest session là gì.

### `src/cli/main.ts`

Đây là nơi sở hữu session state thật sự:

- khởi tạo runtime
- quyết định prompt mode hay interactive mode
- load checkpoint
- resume state
- truyền state vào từng turn
- nhận kết quả turn rồi cập nhật state
- save checkpoint mới nhất

Chính lựa chọn boundary này làm cho implementation nhỏ mà vẫn đúng hướng.

---

## Phân tích chi tiết từng phần implementation

# 1. `src/session/session.ts`

File này trước đây chỉ có `createSessionId()`.

Task 09 biến nó thành nơi giữ policy serialize/parse cho interactive checkpoint.

## 1.1. `InteractiveCheckpointPayload`

Payload checkpoint tối thiểu hiện tại là:

- `version`
- `history`
- `historySummary`

Shape này cố tình nhỏ.

Ta chưa lưu những thứ như:

- memory recall snapshot
- skills text
- budget state
- telemetry snapshot
- provider config override

Lý do là vì vòng này chỉ tập trung vào **session continuity của interactive REPL**, không mở rộng sang full runtime persistence.

## 1.2. `createInteractiveCheckpointJson(...)`

Helper này chỉ làm đúng một việc:

- nhận payload đã hợp lệ
- `JSON.stringify(...)`
- trả về string để save vào DB

Tại sao phải tách helper này ra thay vì để `main.ts` tự stringify?

Vì như vậy policy checkpoint nằm gọn ở một chỗ:

- `main.ts` không cần biết format JSON cụ thể
- sau này nếu payload đổi version hoặc đổi shape, ta sửa tập trung ở `session.ts`

## 1.3. `parseInteractiveCheckpointJson(...)`

Đây là phần rất quan trọng vì persistence chỉ hữu ích khi restore an toàn.

Luồng logic của parser:

1. thử `JSON.parse(...)`
2. nếu parse fail thì trả `undefined`
3. nếu parse được nhưng top-level shape sai thì trả `undefined`
4. nếu parse được và shape hợp lệ thì trả payload typed

Cách làm này có hai ưu điểm:

- CLI không bị crash vì checkpoint hỏng
- invalid checkpoint bị xem như “không thể resume”, thay vì trở thành lỗi runtime khó đoán

## 1.4. Vì sao parser phải validate `tool` message kỹ hơn

Ban đầu nếu chỉ check `role/content/name` thì chưa đủ.

Trong runtime thực, `tool` message có các field quan trọng:

- `name`
- `toolCallId`
- `content`
- `isError`

Đặc biệt `isError` ảnh hưởng trực tiếp tới verification logic vì code chỉ coi tool evidence hợp lệ nếu đó là successful tool message.

Nếu parser chấp nhận một tool message thiếu `isError`, checkpoint sẽ được restore “nửa đúng nửa sai”:

- nhìn qua thì có vẻ vẫn là tool message
- nhưng semantic của verification bị méo

Vì vậy Task 09 đã siết parser theo đúng shape runtime thực tế cho `role === 'tool'`.

## 1.5. `getCheckpointStorePath(cwd)`

Helper này gom policy “checkpoint DB nằm ở đâu” vào một chỗ.

Hiện tại path local là:

- `<cwd>/.qiclaw/checkpoint.sqlite`

Thiết kế này có ý nghĩa rất thực tế:

- mỗi workspace có checkpoint store riêng
- resume session bám vào project directory hiện tại
- không cần thêm bảng mapping `cwd -> latest session`

Nó cũng làm test dễ hơn vì chỉ cần tạo temp directory là có thể có một checkpoint namespace riêng.

---

# 2. `src/session/checkpointStore.ts`

Task 09 không thay thế store, mà chỉ mở rộng đúng mức cần thiết cho latest-session resume.

## 2.1. `save()` dùng `updatedAt` do app truyền vào nếu có

Trước đây timestamp do SQLite tự sinh bằng `datetime('now')`.

Task 09 đổi hướng này sang:

- nếu caller truyền `updatedAt` thì dùng đúng giá trị đó
- nếu không truyền thì fallback `new Date().toISOString()`

Lợi ích:

1. test deterministic hơn
2. precision tốt hơn vì ISO string có milliseconds
3. app nắm quyền khi cần mô phỏng hoặc kiểm soát thứ tự bản ghi

## 2.2. Thêm `getLatest()`

Đây là capability mới quan trọng nhất của store trong task này.

Interactive CLI không cần “lấy checkpoint theo session id mà user chỉ định”; nó chỉ cần:

- checkpoint mới nhất trong workspace hiện tại

Do đó `getLatest()` là API đúng và đủ.

## 2.3. Vì sao phải sort deterministic khi `updatedAt` trùng nhau

Nếu query chỉ sort bằng:

- `updated_at DESC`

thì khi hai record có cùng timestamp, SQLite có thể trả record nào cũng được.

Điều đó rất nguy hiểm với behavior auto-resume vì:

- cùng một data set nhưng có thể resume session khác nhau
- test trở nên flaky
- user mở CLI lại có thể vào nhầm session

Task 09 sửa điểm này bằng secondary sort key:

- `ORDER BY updated_at DESC, session_id DESC`

Nó không phải perfect global ordering cho mọi tương lai, nhưng nó làm behavior deterministic với scope hiện tại.

## 2.4. Tại sao không thêm bảng mới hoặc index mới ở vòng này

Vì chưa cần.

Bài toán hiện tại chỉ là:

- lưu latest snapshot theo từng `session_id`
- lấy checkpoint mới nhất trong workspace

Một bảng `checkpoints` như hiện tại là đủ.

Nếu sau này cần:

- session browser
n- nhiều snapshot theo thời gian cho cùng một session
- resume theo explicit session list

thì khi đó mới cần schema lớn hơn.

---

# 3. `src/cli/main.ts`

Đây là file trung tâm của Task 09.

Nếu Task 8 biến `main.ts` từ stub thành entrypoint chạy thật, thì Task 9 biến `main.ts` thành **session orchestrator tối thiểu**.

## 3.1. Tách sớm prompt mode và interactive mode

Một nguyên tắc quan trọng của task này là:

- `--prompt` phải luôn stateless
- interactive mode mới là nơi stateful

Vì vậy trong `run()` ta branch sớm:

- nếu có `parsed.prompt` -> chạy one-shot path
- nếu không -> đi interactive path

Điều này tránh hai lỗi phổ biến:

1. vô tình load checkpoint cho prompt mode
2. vô tình save checkpoint cho prompt mode

## 3.2. Interactive startup flow

Khi vào interactive mode, luồng khởi tạo là:

1. tính path checkpoint DB từ `cwd`
2. tạo thư mục cha nếu chưa có
3. mở `CheckpointStore`
4. lấy `latestCheckpoint`
5. parse checkpoint JSON
6. nếu parse hợp lệ thì restore state
7. nếu không hợp lệ thì tạo state mới

Đây là resume flow tối thiểu nhưng đầy đủ.

## 3.3. Session state được giữ trong closure

Task này không tạo class mới hay session manager riêng. Thay vào đó nó giữ ba biến closure trong `main.ts`:

- `sessionId`
- `history`
- `historySummary`

Tại sao cách này hợp lý?

Vì state hiện tại rất nhỏ và chỉ sống trong lifecycle của một lần chạy CLI interactive.

Dùng closure giúp:

- ít boilerplate
- không tạo abstraction thừa
- logic dễ đọc từ trên xuống dưới

Đây là ví dụ rất điển hình cho nguyên tắc YAGNI.

## 3.4. CLI-local seam cho `runTurn`

Trong interactive path, injected `runTurn` của test cần nhìn thấy `sessionId`, nhưng single-turn engine thật không nên biết session.

Task 09 xử lý điều này bằng một seam chỉ tồn tại ở layer CLI:

- CLI có thể gọi injected `runTurn` với `sessionId`
- nhưng khi dùng default implementation thật (`runAgentTurn`), CLI strip phần session-only trước khi gọi engine

Đây là một chi tiết thiết kế rất quan trọng vì nó giữ được cả hai mục tiêu:

1. test orchestration được behavior session
2. core engine không bị “nhiễm” responsibility của session manager

## 3.5. Vì sao phải giữ `historySummary` cũ nếu turn mới không trả summary mới

Đây là bug quan trọng đã bị review bắt ra trong quá trình làm task.

Tình huống:

- startup resume được một `historySummary` hợp lệ từ checkpoint cũ
- turn kế tiếp chạy xong nhưng result không trả `historySummary`
- nếu code gán thẳng `historySummary = result.historySummary`
- thì summary cũ bị mất ngay lập tức

Điều này sai vì session state bị degrade sau một turn, dù không hề có thông tin mới để thay thế.

Fix đúng là:

- chỉ update summary nếu result có summary mới
- nếu không có thì giữ summary cũ

Điểm này thể hiện một quy tắc rất quan trọng khi thiết kế persistence/resume:

**absence of new state is not the same as explicit state reset.**

## 3.6. Khi nào checkpoint được save

Task này save checkpoint sau mỗi turn interactive có stop reason là:

- `completed`
- `max_tool_rounds_reached`

Tức là cả turn hoàn tất bình thường lẫn turn bị dừng vì chạm trần tool rounds đều được persist.

Lý do hợp lý:

- cả hai đều là trạng thái user có thể muốn resume tiếp
- `max_tool_rounds_reached` vẫn tạo ra history hợp lệ cần giữ lại

Còn trường hợp turn throw error giữa chừng thì chưa persist ở vòng này.

Đó là lựa chọn có chủ đích để giữ scope nhỏ và tránh phải định nghĩa policy “checkpoint partial failure” quá sớm.

---

# 4. `src/core/types.ts`

Task 09 mở rộng `Message` với:

- `toolCallId?`
- `isError?`

## Vì sao việc này hợp lý

Thực tế runtime đã có tool messages chứa các field này. Nhưng type nền ở `core/types.ts` trước đó còn quá hẹp, chủ yếu phản ánh message đơn giản.

Khi bắt đầu persist rồi restore history thật, type quá hẹp sẽ làm hai chuyện xấu xảy ra:

1. parser không diễn đạt được runtime shape thật
2. test và persistence phải dùng cast hoặc bypass type system

Việc mở rộng `Message` ở đây không phải là “thêm feature”, mà là làm cho core type phản ánh đúng thực tế message đang tồn tại trong hệ thống.

Đây là một bước type hygiene quan trọng.

---

# 5. Test coverage mới

Task này có khá nhiều test mới và chúng rất quan trọng vì behavior session thường dễ bị regress.

## 5.1. `tests/cli/repl.test.ts`

### Case 1: giữ session state qua nhiều lượt trong cùng process

Test này khóa các behavior:

- turn đầu dùng session mới
- turn sau nhận lại cùng `sessionId`
- turn sau thấy `history` đã tích lũy
- turn sau thấy `historySummary` của turn trước
- sau khi thoát, checkpoint đã đủ dữ liệu để lần chạy sau resume lại

### Case 2: interactive lần sau auto-resume latest checkpoint

Test này chạy CLI interactive hai lần trên cùng `cwd` temp:

- lần 1 tạo checkpoint
- lần 2 mở lại CLI
- CLI phải tự restore history cũ
- CLI phải giữ `sessionId` cũ thay vì tạo session mới

### Case 3: restore xong nhưng turn mới không trả summary mới

Case này được thêm vào sau khi spec review bắt ra bug summary bị mất.

Nó khóa đúng regression đó:

- checkpoint restore có summary cũ
- turn kế tiếp trả `historySummary: undefined`
- turn sau nữa vẫn phải thấy summary cũ

### Case 4: prompt mode vẫn stateless

Test này đảm bảo `--prompt`:

- không có `sessionId`
- không nhận `history`
- không nhận `historySummary`
- không dùng checkpoint resume flow

Đây là test rất quan trọng vì prompt mode và interactive mode bây giờ đã khác nhau rõ rệt.

### Case 5: restore tool messages từ checkpoint hợp lệ

Đây là test bổ sung sau code quality review.

Nó chứng minh rằng history được restore không chỉ gồm user/assistant message đơn giản, mà còn gồm cả tool messages đầy đủ shape runtime.

### Case 6: invalid checkpoint bị bỏ qua

Test này đảm bảo parser fail-safe:

- checkpoint sai version hoặc sai shape
- CLI không crash
- CLI tạo session mới
- interactive mode vẫn chạy bình thường

## 5.2. `tests/session/checkpointStore.test.ts`

### Case 1: save và reload theo `sessionId`

Khóa behavior cơ bản của store.

### Case 2: overwrite checkpoint cùng `sessionId`

Đảm bảo store vẫn hoạt động đúng như session-level latest snapshot.

### Case 3: `getLatest()` theo `updatedAt`

Đảm bảo auto-resume lấy đúng checkpoint mới nhất.

### Case 4: deterministic tie-break khi `updatedAt` bằng nhau

Đây là test quan trọng được thêm sau review quality.

Nó khóa behavior deterministic bằng secondary sort key, tránh restore session ngẫu nhiên.

## 5.3. `tests/session/session.test.ts`

Đây là test file mới cho parser/serializer policy.

### Case 1: chấp nhận tool message hợp lệ

Đảm bảo parser không từ chối tool history đúng shape.

### Case 2: từ chối malformed tool messages

Đảm bảo parser reject khi thiếu:

- `name`
- `toolCallId`
- `isError`

hoặc `isError` không phải boolean.

Những test này rất quan trọng vì parser là boundary giữa persistence không đáng tin cậy và runtime state đáng tin cậy.

---

## Những bug/review findings quan trọng trong quá trình làm Task 09

Task này không chỉ là implementation thẳng một mạch; nó còn có vài bài học thiết kế rất đáng chú ý.

### 1. Bug làm rơi `historySummary` sau resume

Đây là lỗi logic khá tinh vi:

- restore thành công summary cũ
- turn tiếp theo không tạo summary mới
- code overwrite bằng `undefined`

Review đã bắt ra lỗi này và fix theo hướng giữ summary cũ nếu result không cung cấp summary mới.

### 2. Scope creep vào `runAgentTurn(...)`

Một lần sửa đầu đã lỡ thêm session-related fields vào `src/agent/loop.ts`.

Điều đó làm boundary xấu đi vì single-turn engine bắt đầu biết quá nhiều về orchestration.

Sau review, phần này được rút lại và thay bằng CLI-local seam.

Đây là một bài học rất quan trọng:

**không phải cứ thêm field vào type là vô hại; nhiều khi đó là dấu hiệu responsibility đang chảy sai tầng.**

### 3. Checkpoint validation ban đầu quá lỏng

Ban đầu parser chưa kiểm tra chặt tool message shape.

Review quality chỉ ra rằng làm vậy có thể chấp nhận checkpoint “trông hợp lệ nhưng semantic sai”.

Fix cuối cùng buộc parser validate đúng runtime tool fields.

### 4. `getLatest()` ban đầu chưa deterministic khi timestamp trùng nhau

Đây là ví dụ điển hình của bug ít lộ ra ở happy path nhưng dễ gây flaky behavior lâu dài.

Review quality bắt điểm này trước khi nó trở thành nguồn bug khó debug.

---

## Tại sao implementation hiện tại là mức “đủ tốt” cho MVP

Task này cố ý **không** đi xa hơn mức cần thiết.

Những gì đã có bây giờ là đủ để interactive CLI trở nên hữu ích hơn rất nhiều:

- nhớ được conversation state
- resume được session gần nhất
- lưu được checkpoint local theo workspace
- fail-safe khi checkpoint hỏng

Đó là một bước tiến lớn so với Task 8, nhưng vẫn giữ complexity thấp.

---

## Những phần cố ý chưa làm trong Task 09

Phần này rất quan trọng vì user đã yêu cầu mỗi task phải nói rõ cái gì chưa làm và vì sao.

### 1. Chưa có session browser hoặc chọn session thủ công

Hiện tại CLI chỉ auto-resume latest checkpoint.

Chưa có:

- list các session cũ
- chọn session theo ID
- resume session cụ thể do user chọn

**Vì sao chưa làm:**
- task này chỉ nhắm tới “latest session auto-resume”
- thêm session picker sẽ kéo theo UX, command surface, và schema/query logic lớn hơn

**Nó sẽ được hấp thụ vào task sau nào:**
- một task tương lai về session management UX / session browser

### 2. Chưa có nhiều snapshot theo thời gian cho cùng một session

Hiện tại store vẫn giữ latest checkpoint cho từng `sessionId`.

Chưa có history của nhiều snapshot trong cùng session.

**Vì sao chưa làm:**
- mục tiêu hiện tại là resume tiếp tục làm việc, không phải time-travel debug
- schema hiện tại đủ cho latest resume

**Nó sẽ được hấp thụ vào task sau nào:**
- task tương lai về richer checkpoint timeline / recovery history

### 3. Chưa persist partial checkpoint khi turn throw error giữa chừng

Hiện tại chỉ persist ở `completed` hoặc `max_tool_rounds_reached`.

**Vì sao chưa làm:**
- partial failure persistence cần policy rõ: lưu tới đâu, có lưu output dở dang không, có đánh dấu corrupted/partial không
- quá nhiều quyết định cho một vòng polish nhỏ

**Nó sẽ được hấp thụ vào task sau nào:**
- task tương lai về failure recovery / partial-turn checkpointing

### 4. Chưa wire memory/skills vào session restore path

Dù `runAgentTurn(...)` có thể nhận `memoryText` và `skillsText`, Task 09 chưa mở rộng resume logic sang phần đó.

**Vì sao chưa làm:**
- memory/skills là context layer khác với checkpointed history
- nếu làm cùng lúc sẽ làm scope nở quá nhanh

**Nó sẽ được hấp thụ vào task sau nào:**
- task tương lai về memory integration và skill loading/rendering vào runtime path

### 5. Chưa có pruning/compaction policy khi session dài lên

Interactive mode bây giờ giữ history tăng dần theo số turn.

**Vì sao chưa làm:**
- task này tập trung vào correctness của session continuity trước
- budget-aware pruning là một bài toán riêng, cần nối với `historyPruner` / `budgetManager`

**Nó sẽ được hấp thụ vào task sau nào:**
- task tương lai về context budget enforcement cho runtime path

### 6. Chưa nâng cấp `createSessionId()` khỏi `Date.now()`

Review quality có ghi nhận đây là điểm có thể cải thiện.

**Vì sao chưa làm:**
- không phải blocker cho scope hiện tại
- rủi ro collision trong interactive CLI local MVP là thấp
- ưu tiên giữ diff tập trung vào resume correctness

**Nó sẽ được hấp thụ vào task sau nào:**
- task tương lai về hardening session identity / persistence robustness

---

## Bài học kiến trúc quan trọng rút ra từ Task 09

### 1. Session management là orchestration concern, không phải engine concern

Đây là bài học lớn nhất của task này.

Nếu đẩy session logic xuống engine quá sớm:

- engine khó test hơn
- type surface phình to
- responsibility bị lẫn

Giữ session ở `main.ts` giúp code sạch hơn rất nhiều.

### 2. Persistence boundary phải validate chặt

Dữ liệu đọc từ DB không nên được tin tưởng chỉ vì nó “do chính app mình ghi ra trước đó”.

Checkpoint có thể hỏng vì:

- version cũ
- data bị sửa tay
- bug từ phiên bản trước
- test inject data không hoàn chỉnh

Task 09 cho thấy parser là chỗ rất đáng để khó tính.

### 3. Determinism quan trọng hơn cảm giác “chắc cũng ổn”

Nếu latest checkpoint lookup không deterministic, behavior resume sẽ có thể sai ngẫu nhiên.

Đây là kiểu bug rất khó truy ra nếu không chặn từ sớm bằng test.

### 4. Review tốt không chỉ bắt lỗi code mà còn bắt lỗi boundary

Hai review finding quan trọng nhất ở task này không phải syntax hay typo:

- scope creep vào `runAgentTurn(...)`
- summary bị mất do semantics update state chưa chuẩn

Đó là những lỗi boundary và ownership, rất đáng học.

---

## Cách chạy verify cho Task 09

Các lệnh đã dùng để verify implementation cuối cùng:

```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor" test -- tests/session/session.test.ts tests/session/checkpointStore.test.ts tests/cli/repl.test.ts
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor" test
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor" run typecheck:test
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/fluttering-crunching-meteor" run build
```

Kết quả cuối:

- targeted tests pass
- full test suite pass
- typecheck pass
- build pass

---

## Tóm tắt ngắn gọn task này theo ngôn ngữ rất đời thường

Nếu nói thật ngắn, Task 09 làm cho CLI của bạn bớt “mất trí nhớ”.

Trước task này:

- interactive mode chỉ là nhiều câu hỏi độc lập
- đóng CLI rồi mở lại là mất mạch làm việc

Sau task này:

- interactive mode nhớ được các lượt trước trong cùng phiên chạy
- đóng CLI rồi mở lại có thể tự nối tiếp session gần nhất của workspace
- nếu checkpoint hỏng thì bỏ qua an toàn và bắt đầu session mới
- prompt mode vẫn giữ tính one-shot sạch sẽ

Đây là một bước polish nhỏ về lượng code, nhưng lớn về chất lượng trải nghiệm runtime.

---

## Nối sang bước kế tiếp

Sau Task 09, codebase đã có một session-aware REPL tối thiểu.

Những hướng phát triển rất tự nhiên tiếp theo là:

1. session browser / explicit resume command
2. partial checkpointing cho failure path
3. budget-aware history pruning trong runtime thật
4. memory + skills integration vào runtime orchestration
5. hardening session identity và richer checkpoint metadata

Tức là Task 09 không phải điểm kết thúc của session subsystem. Nó là điểm bắt đầu đúng hướng: từ single-turn CLI sang session-aware CLI, nhưng vẫn giữ design đủ gọn để tiếp tục mở rộng an toàn ở các task sau.
