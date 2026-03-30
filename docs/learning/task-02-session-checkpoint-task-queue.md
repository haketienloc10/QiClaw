# Task 02 - Session Checkpoint và Task Queue

## Mục tiêu của task

Task 2 bổ sung lớp persistence tối thiểu bằng SQLite để CLI runtime có thể giữ lại trạng thái session và hàng đợi công việc giữa các lần mở lại database.

Ở trạng thái checked-in hiện tại, task này tập trung vào hai phần chính:

- lưu checkpoint mới nhất cho từng session
- lưu hàng đợi task và claim task pending theo thứ tự FIFO

Task này chưa mở rộng sang job scheduler đầy đủ, chưa có worker loop nền, chưa có cơ chế retry, chưa có nhiều checkpoint cho cùng một task, và chưa có API phức tạp hơn ngoài các thao tác lưu/đọc tối thiểu đang hiện diện trong code.

## Các file chính và vai trò thực tế

### 1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/session/checkpointStore.ts`

File này triển khai `CheckpointStore` bằng `better-sqlite3`.

Schema hiện tại của bảng `checkpoints` là:

- `session_id TEXT PRIMARY KEY`
- `task_id TEXT NOT NULL`
- `status TEXT NOT NULL`
- `checkpoint_json TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Điểm quan trọng nhất của schema này là khóa chính nằm ở `session_id`, không nằm ở `task_id`.

Điều đó có nghĩa là store này đang hoạt động theo contract sau:

- mỗi session chỉ có tối đa một checkpoint đang được lưu
- checkpoint được xem là checkpoint mới nhất của session đó
- `taskId` chỉ là metadata cho biết tại thời điểm lưu checkpoint thì session đang gắn với task nào

Nói cách khác, đây không phải kho lưu nhiều checkpoint theo từng task. Nếu cùng một `sessionId` được lưu lần nữa, record cũ sẽ bị thay thế bằng record mới nhất.

### 2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/session/checkpointStore.test.ts`

File test này khóa contract session-level của `CheckpointStore`.

Các behavior hiện đang được kiểm tra:

- lưu checkpoint rồi mở lại DB vẫn đọc được bằng `getBySessionId(sessionId)`
- nếu cùng một `sessionId` được `save()` lần thứ hai, checkpoint mới sẽ overwrite checkpoint cũ
- nếu session không tồn tại thì trả về `undefined`

Test overwrite/upsert này rất quan trọng vì nó làm rõ ambiguity trước đó: code không phải đang lưu nhiều checkpoint theo task, mà đang giữ checkpoint mới nhất của session.

### 3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/session/taskQueue.ts`

File này triển khai `TaskQueue` bằng SQLite.

Schema hiện tại của bảng `tasks` là:

- `task_id TEXT PRIMARY KEY`
- `goal TEXT NOT NULL`
- `payload_json TEXT NOT NULL`
- `status TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`enqueue()` thêm một row mới với:

- `status = 'pending'`
- `created_at = datetime('now')`
- `updated_at = datetime('now')`

`claimNext()` hiện dùng transaction để thực hiện trọn một chuỗi thao tác:

1. tìm task pending đầu tiên
2. cập nhật task đó sang `running`
3. đọc lại row sau khi cập nhật
4. trả về `TaskRecord`

Lý do dùng transaction ở đây là để thao tác claim mang tính nguyên tử. Nếu không bọc trong transaction, hai luồng claim gần nhau có thể cùng đọc thấy một row `pending` trước khi status kịp chuyển sang `running`.

### 4. FIFO hiện tại trong `TaskQueue`

Câu khẳng định FIFO hiện tại của codebase là: task pending được claim theo thứ tự enqueue cũ trước mới sau.

Implementation hiện tại thể hiện điều này bằng truy vấn:

- lọc `WHERE status = 'pending'`
- `ORDER BY created_at ASC, rowid ASC`
- `LIMIT 1`

`created_at ASC` thể hiện intent FIFO theo thời gian tạo.

`rowid ASC` là tie-breaker tối thiểu để ổn định thứ tự khi nhiều row có cùng timestamp theo độ phân giải của SQLite. Với cách này, test FIFO không chỉ đúng về intent mà còn bớt phụ thuộc vào việc các insert có rơi đúng cùng một giây hay không.

### 5. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/session/taskQueue.test.ts`

File test này đang kiểm tra các contract chính của queue:

- enqueue một task rồi claim sẽ nhận đúng task đó và status là `running`
- nhiều task pending được claim theo FIFO
- dữ liệu vẫn còn sau khi reopen database file
- khi không còn task pending thì `claimNext()` trả về `undefined`

Test FIFO hiện tại đồng thời cũng là test persistence theo nghĩa vật chất của SQLite-backed store, vì nó enqueue bằng một instance `TaskQueue`, sau đó mở lại database bằng instance khác rồi mới claim.

Nhờ vậy, test đang chứng minh đúng điều cần chứng minh: dữ liệu không chỉ tồn tại trong memory object, mà thật sự được ghi xuống file SQLite.

## Tách build production và type-check cho test

### 1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tsconfig.json`

`tsconfig.json` hiện vẫn giữ vai trò build production sạch:

- `rootDir = "src"`
- `outDir = "dist"`
- `include = ["src/**/*.ts"]`

Điều này có lợi vì:

- `dist` chỉ chứa production code
- test file không bị compile vào output build
- build contract vẫn nhỏ và rõ ràng

### 2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tsconfig.test.json`

Để lấp khoảng trống type-check cho test, task hiện thêm một config riêng là `tsconfig.test.json`.

Config này:

- `extends` từ `tsconfig.json`
- bật `noEmit: true`
- đổi `rootDir` thành `.` để bao phủ cả `src`, `tests`, và `vitest.config.ts`
- thêm `types: ["node", "vitest/globals"]`
- `include` cả `src/**/*.ts`, `tests/**/*.ts`, và `vitest.config.ts`

Ý nghĩa của việc tách config như vậy:

- `npm run build` vẫn chỉ build production code
- test và config test vẫn được TypeScript kiểm tra độc lập
- project không cần compile test ra `dist`

Đây là cách sửa nhỏ nhất để tránh trạng thái build pass nhưng test TypeScript không hề được kiểm tra.

### 3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/package.json`

`package.json` hiện có thêm script:

- `npm run typecheck:test`

Script này chạy:

```bash
tsc -p tsconfig.test.json
```

Nhờ đó, build và test type-check có hai mục đích rõ ràng:

- `npm run build`: kiểm tra production compile và tạo output
- `npm run typecheck:test`: kiểm tra TypeScript cho test/code/config mà không emit file

## Hành vi checked-in hiện tại

Ở trạng thái hiện tại, Task 2 đang cung cấp các contract thực tế sau:

### CheckpointStore

- lưu checkpoint theo session
- mỗi session chỉ giữ checkpoint mới nhất
- `taskId` được lưu kèm như metadata của checkpoint session-level
- đọc lại bằng `getBySessionId(sessionId)`
- save cùng `sessionId` lần nữa sẽ overwrite record cũ
- dữ liệu vẫn tồn tại khi mở lại SQLite file

### TaskQueue

- enqueue task mới với trạng thái `pending`
- claim task pending tiếp theo và đổi sang `running`
- claim theo FIFO với tie-break tối thiểu bằng `rowid`
- persistence được giữ qua reopen database file
- thao tác claim dùng transaction để giảm nguy cơ double-claim do read/update không nguyên tử

## Những gì task này cố ý chưa làm

Để giữ scope chặt, implementation hiện tại chưa thêm các behavior sau:

- chưa có dequeue xóa row khỏi queue
- chưa có retry task failed
- chưa có chuyển task từ `running` sang `completed` hay `failed`
- chưa có nhiều checkpoint history cho một session hoặc cho một task
- chưa có migration framework hay versioned schema
- chưa có concurrency control phức tạp ngoài transaction cho thao tác claim

Các phần này không xuất hiện trong checked-in behavior hiện tại, nên không nên mô tả như thể đã được hỗ trợ.

## Các phần chưa làm này sẽ được hấp thụ vào task nào

Task 2 chỉ dựng persistence tối thiểu. Những phần chưa làm không bị bỏ quên, mà sẽ được hấp thụ dần vào các task sau như sau.

- **chưa có dequeue xóa row khỏi queue**
  - chưa được nêu explicit trong spec Task 3–8
  - nếu runtime loop về sau chỉ cần chuyển trạng thái task thay vì xóa vật lý, mục này có thể tiếp tục **không nằm trong MVP Task 1–8**
- **chưa có retry task failed**
  - gần nhất với **Task 7** khi agent loop, done criteria, verification, và trạng thái hoàn tất/thất bại bắt đầu rõ hơn
  - telemetry của **Task 8** có thể hỗ trợ quan sát, nhưng retry policy bản thân nó thuộc lớp runtime behavior hơn
- **chưa có chuyển task từ `running` sang `completed` hay `failed`**
  - gần nhất với **Task 7** vì đây là lúc core agent loop và verification được đưa vào
- **chưa có nhiều checkpoint history cho một session hoặc cho một task**
  - không nằm trong spec MVP hiện tại; theo plan gốc, mục này **chưa được hấp thụ trong Task 1–8**
  - Task 2 chỉ cố ý giữ đúng contract “latest checkpoint per session”
- **chưa có migration framework hay versioned schema**
  - cũng không nằm trong Task 1–8 của MVP hiện tại; đây là phần mở rộng sau khi schema và runtime ổn định hơn
- **chưa có concurrency control phức tạp ngoài transaction cho thao tác claim**
  - transaction tối thiểu đã có ở Task 2
  - nếu cần control phức tạp hơn, nó sẽ phụ thuộc runtime behavior thực tế ở **Task 7** và mức observability ở **Task 8**, chứ chưa nên đoán sớm ở Task 2

Nhìn theo kiến trúc, Task 2 chỉ chịu trách nhiệm lớp lưu trữ tối thiểu. Những hành vi quản lý vòng đời task thực sự sẽ chỉ trở nên chính xác khi **Task 7** hoàn tất agent loop; còn các nhu cầu vận hành, quan sát, và logging sẽ rõ hơn ở **Task 8**.

## Cách chạy lại Task 2

Thực hiện trong worktree:

`/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli`

### Chạy session tests

```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" test -- tests/session/checkpointStore.test.ts tests/session/taskQueue.test.ts
```

Kết quả mong đợi:

- test `CheckpointStore` pass
- test `TaskQueue` pass
- có kiểm tra overwrite checkpoint, FIFO, và persistence qua reopen

### Type-check test và config test

```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" run typecheck:test
```

Kết quả mong đợi:

- TypeScript kiểm tra được cả `src`, `tests`, và `vitest.config.ts`
- không emit file mới vào `dist`

### Build production

```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" run build
```

Kết quả mong đợi:

- production code trong `src` build thành công
- output build vẫn sạch, không kéo `tests` vào `dist`

## Tóm tắt

Task 2 hiện bổ sung persistence SQLite tối thiểu cho hai khối chức năng:

- `CheckpointStore` lưu checkpoint mới nhất theo session, trong đó `taskId` chỉ là metadata của checkpoint session-level
- `TaskQueue` lưu task pending và claim theo FIFO bằng transaction
- test đã khóa rõ hơn hành vi overwrite/upsert của checkpoint theo session
- test đã kiểm tra FIFO và persistence qua reopen database
- build production và test type-check được tách riêng để vừa giữ `dist` sạch vừa không bỏ sót kiểm tra TypeScript ở test
