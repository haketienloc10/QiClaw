# Task 03 - Tool contracts và minimal registry

## Mục tiêu của task này

Task 3 bổ sung lớp trừu tượng tối thiểu để runtime có thể nói về “tool” theo một hợp đồng thống nhất, đồng thời cung cấp một registry built-in đủ nhỏ cho giai đoạn MVP. Ở bước này, hệ thống chưa chạy agent loop thật, chưa có provider abstraction, chưa có dispatcher, và cũng chưa cố bắt chước đầy đủ hành vi của Claude Code. Mục tiêu chỉ là:

- định nghĩa một contract nhỏ, dễ hiểu cho tool
- khai báo 4 tool built-in đầu tiên: `read_file`, `edit_file`, `search`, `shell`
- cho phép tra cứu tool theo tên
- giữ code đủ đơn giản để Task 4 và Task 7 tái sử dụng

## Những file được thêm hoặc cập nhật trong Task 3

### 1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/tools/tool.ts`

File này định nghĩa contract cốt lõi cho một tool.

Các kiểu dữ liệu chính:

- `JsonSchema`: mô tả schema đầu vào ở mức rất tối thiểu
- `ToolContext`: ngữ cảnh chạy tool, hiện tại chỉ có `cwd`
- `ToolResult`: kết quả trả về từ tool, hiện tại chỉ có `content: string`
- `Tool<TInput>`: interface chuẩn cho mọi tool

Ý nghĩa thiết kế:

- Task này chưa cần validator thật, nên `JsonSchema` chỉ là shape đơn giản để mô tả input contract
- `ToolContext` cố ý nhỏ để tránh đẩy thiết kế quá sớm sang dependency injection hoặc runtime service bag
- `ToolResult` hiện chỉ có text vì MVP chỉ cần đầu ra đơn giản, dễ test, dễ nối vào loop sau này

Contract đã được chốt ở mức Task 3:

- mỗi tool có `name`
- mỗi tool có `description`
- mỗi tool có `inputSchema`
- mỗi tool có `execute(input, context)` và trả về `Promise<ToolResult>`

Đây là “checked-in contract” quan trọng nhất của Task 3.

### 2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/tools/readFile.ts`

Tool built-in `read_file`.

Chức năng:

- nhận vào `path`
- resolve đường dẫn theo `context.cwd`
- chặn absolute path hoặc `..` traversal nếu target đi ra ngoài workspace
- đọc file UTF-8
- trả về toàn bộ nội dung file trong `content`

Điểm đáng chú ý:

- đây là implementation rất tối thiểu, chưa có giới hạn kích thước file
- contract hiện đã ép mọi path phải nằm trong workspace hiện tại
- chưa có hỗ trợ offset/limit/binary detection

Task 3 chỉ cần chứng minh rằng built-in tool có thể tồn tại dưới dạng một đối tượng tuân theo contract chung.

### 3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/tools/editFile.ts`

Tool built-in `edit_file`.

Chức năng:

- nhận `path`, `oldText`, `newText`
- chỉ cho phép path nằm trong workspace hiện tại
- đọc file UTF-8
- kiểm tra `oldText` có xuất hiện hay không
- thay thế đúng lần xuất hiện đầu tiên bằng `String.prototype.replace`
- ghi lại file
- trả về thông báo text ngắn gọn

Tại sao làm tối thiểu như vậy:

- đủ để có một tool “ghi” đơn giản
- không cần parser AST
- không cần diff engine
- không cần replace-all hay uniqueness enforcement ở mức cao hơn

Contract đang được ngầm chốt ở đây:

- nếu path đi ra ngoài workspace, tool ném lỗi
- nếu không tìm thấy đoạn cần thay, tool ném lỗi
- nếu tìm thấy, tool chỉ thay thế lần xuất hiện đầu tiên rồi trả về text xác nhận

### 4. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/tools/search.ts`

Tool built-in `search`.

Chức năng:

- nhận `pattern`
- đi đệ quy bên dưới `cwd`
- bỏ qua một số thư mục không liên quan rõ ràng như `.git`, `node_modules`, `dist`, `.worktrees`
- đọc file dạng UTF-8 nếu có thể
- trả về danh sách file chứa chuỗi literal đó

Điểm đơn giản có chủ đích:

- đang search literal bằng `includes`, chưa phải regex engine
- chưa có include/exclude glob tùy biến từ caller
- chưa có context lines
- chưa có line numbers
- chưa phân biệt file text/binary hoàn chỉnh, chỉ bỏ qua nếu đọc lỗi
- implementation hiện tại duyệt và kiểm tra file ngay khi gặp, không còn gom toàn bộ path trước rồi mới search

Mục tiêu của Task 3 không phải tạo công cụ search mạnh, mà là chứng minh registry có thể chứa một tool thao tác đọc nhiều file.

### 5. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/tools/shell.ts`

Tool built-in `shell`.

Chức năng:

- nhận `command` và `args?`
- chạy đúng một executable bằng `execFile`
- đặt `cwd` theo `ToolContext`
- ghép `stdout` và `stderr` thành `content` khi chạy thành công
- nếu command thất bại, ném lỗi rõ hơn có kèm command, exit code, stdout và stderr

Lý do chọn `execFile` thay vì shell string:

- đơn giản hơn cho MVP
- tránh phải parse command line phức tạp
- an toàn hơn so với việc mặc định chạy qua shell

Điểm cố ý chưa làm:

- chưa có timeout
- chưa có env override
- chưa stream output
- chưa có sandbox policy
- chưa normalize mã lỗi thành result object riêng

### 6. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/tools/registry.ts`

Đây là nơi tập hợp các built-in tool và cung cấp API tra cứu.

Các hàm chính:

- `getBuiltinToolNames()`: trả về danh sách tên tool theo thứ tự ổn định
- `getBuiltinTools()`: trả về danh sách tool built-in
- `hasTool(name)`: kiểm tra có tồn tại tool hay không
- `getTool(name)`: lấy tool theo tên

Thiết kế ở đây rất quan trọng vì nó là cầu nối giữa phần “khai báo tool” và các task sau:

- Task 4 sẽ cần tái sử dụng abstraction này khi thêm provider interface và dispatcher
- Task 7 sẽ cần lookup theo tên trong agent loop khi model hoặc planner yêu cầu gọi tool

Thứ tự built-in hiện tại được chốt là:

1. `read_file`
2. `edit_file`
3. `search`
4. `shell`

Thứ tự này đã được test để tránh thay đổi vô ý.

### 7. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/agent/loop.test.ts`

Dù file tên là `loop.test.ts`, ở thời điểm Task 3 nó đang đóng vai trò test cho lớp tool contract và registry nền tảng mà loop sau này sẽ dùng.

Các nhóm test hiện có:

#### a. đăng ký built-in tool theo thứ tự ổn định

Test này khóa lại rằng registry built-in chứa đúng bốn tool theo đúng thứ tự mong muốn.

#### b. lookup theo tên

Test này xác nhận:

- `hasTool` trả về `true` với tool hợp lệ
- `hasTool` trả về `false` với tool không tồn tại
- `getTool` trả về `undefined` với tên không hợp lệ

#### c. mỗi built-in tool có đủ contract

Test này không ép hành vi chi tiết của từng tool, nhưng bắt buộc mỗi tool phải có:

- `name`
- `description`
- `inputSchema`
- `execute`

#### d. contract cho phép tool trả về output text có cấu trúc tối thiểu

Test cuối dùng một `demo_tool` nội bộ để chứng minh contract `Tool<TInput>` và `ToolContext` hoạt động như mong đợi, độc lập với built-in tools.

Điều này rất hữu ích vì nó kiểm tra abstraction, không chỉ kiểm tra data registration.

## Cách toàn bộ phần này hoạt động cùng nhau

Luồng khái niệm hiện tại là:

1. Mỗi tool tự khai báo contract của mình trong file riêng
2. `registry.ts` import các tool đó và dựng `Map<string, Tool>`
3. Mọi thành phần phía trên chỉ cần biết tên tool để lookup
4. Khi cần gọi thật, thành phần phía trên sẽ lấy ra `tool.execute(input, context)`

Task 3 mới dừng ở bước 1 đến 3 cho mục đích tổ chức code và chốt interface. Việc “thành phần phía trên” cụ thể là ai vẫn chưa được thêm ở task này.

## Checked-in contract của Task 3 là gì

Đây là phần quan trọng nhất về mặt học tập và bảo trì.

Task 3 đã chính thức chốt các điều sau vào codebase:

### Contract 1: shape chuẩn của một tool

Một tool phải có:

- tên (`name`)
- mô tả (`description`)
- schema đầu vào (`inputSchema`)
- hàm `execute(input, context)` bất đồng bộ

### Contract 2: context chạy tool hiện tại chỉ yêu cầu `cwd`

Bất kỳ caller nào trong các task sau muốn chạy tool đều phải cung cấp `cwd`.

### Contract 3: registry built-in hỗ trợ lookup theo tên

Mọi logic phía trên không cần import trực tiếp từng tool nếu chỉ muốn tra cứu theo chuỗi tên.

### Contract 4: built-in set hiện tại là một danh sách tối thiểu, cố định

- `read_file`
- `edit_file`
- `search`
- `shell`

Task 3 không thêm cơ chế đăng ký động, plugin system, hay external provider.

## Tại sao file test lại đặt tên là `loop.test.ts`

Theo spec, file test yêu cầu là `tests/agent/loop.test.ts`. Ở thời điểm hiện tại tên file này hơi “đi trước” implementation thật, vì core agent loop chưa tồn tại trong Task 3. Tuy vậy điều này vẫn hợp lý vì:

- registry là nền tảng mà agent loop sẽ dùng sau này
- test này giúp tạo sẵn vị trí cho các test của loop ở Task 7
- hiện tại nó kiểm tra phần “tool-facing behavior” tối thiểu mà loop sẽ phụ thuộc vào

Nói ngắn gọn: file mang tên loop, nhưng nội dung đang test phần hạ tầng phục vụ loop trong tương lai.

## Những gì Task 3 cố ý chưa triển khai

Đây là danh sách quan trọng để tránh hiểu nhầm phạm vi.

### 1. Chưa có input validation runtime thật sự

Dù mỗi tool có `inputSchema`, Task 3 chưa dùng validator để parse/kiểm tra input lúc chạy.

Hệ quả:

- schema hiện tại chủ yếu là contract mô tả
- sai kiểu dữ liệu có thể rơi xuống runtime TypeScript/JavaScript bình thường

Phần này sẽ phù hợp hơn với **Task 4**, nơi provider interface + dispatcher được thêm vào. Khi có dispatcher, runtime mới có nơi hợp lý để validate input trước khi gọi tool.

### 2. Chưa có provider interface

Task 3 chỉ có built-in registry tĩnh. Nó chưa định nghĩa abstraction để nhiều nguồn tool khác nhau cùng tham gia.

Phần này được để cho **Task 4** theo đúng intent của plan.

### 3. Chưa có dispatcher

Hiện tại chưa có thành phần nhận tên tool + input, validate, gọi execute, chuẩn hóa lỗi, rồi trả về một envelope thống nhất.

Phần này cũng được để cho **Task 4**.

### 4. Chưa có agent loop tiêu thụ tools

Tool đã tồn tại nhưng chưa có core loop nào sử dụng chúng trong quá trình giải task.

Phần này được để cho **Task 7** theo đúng intent của plan.

### 5. Chưa có policy bảo mật hoàn chỉnh

Task 3 hiện đã có một lớp bảo vệ nhỏ cho file tools:

- `read_file` và `edit_file` chặn path traversal ra ngoài workspace, kể cả khi caller truyền absolute path hoặc `..`

Tuy vậy vẫn còn thiếu nhiều policy khác, ví dụ:

- allowlist command cho shell
- timeout / cancellation
- output truncation
- file size limit
- binary detection đầy đủ
- policy thống nhất cho mọi tool thay vì mới áp dụng trực tiếp cho file tools

Các phần này chưa được gán cứng vào một task cụ thể trong mô tả hiện có, nhưng nhiều khả năng sẽ được hấp thụ dần bởi **Task 4** (dispatcher/policy/routing) và các task tích hợp loop về sau.

### 6. Chưa có Claude Code parity

Task này không cố mô phỏng hết hành vi của Claude Code tools. Ví dụ:

- `read_file` chưa hỗ trợ line range
- `edit_file` chưa có exact replacement protocol nâng cao
- `search` chưa có regex/context/glob tùy biến
- `shell` chưa có rich execution controls ngoài việc bọc lỗi rõ ràng hơn

Điều này là chủ ý để giữ MVP rõ ràng và tránh over-engineering.

## Vì sao không thêm `zod`

Spec cho phép thêm `zod` nếu cần, đặc biệt cho parse input của `edit_file`. Tuy nhiên trong implementation thực tế của Task 3, `zod` chưa cần thiết vì:

- task này chưa có runtime validator layer
- test chỉ yêu cầu contract và registry tối thiểu
- thêm dependency lúc này sẽ tạo bề mặt API chưa được dùng đến

Do đó `package.json` không cần đổi ở Task 3. Nếu Task 4 thêm dispatcher và validation thật, lúc đó việc thêm `zod` sẽ có ý nghĩa rõ ràng hơn.

## Các quyết định thiết kế đáng chú ý

### Quyết định 1: giữ `ToolResult` chỉ có `content: string`

Ưu điểm:

- cực dễ hiểu
- dễ test
- chưa khóa runtime vào một envelope quá nặng

Nhược điểm:

- chưa truyền được metadata như exit code, mime type, truncated flag, diagnostics

Ở giai đoạn này, ưu tiên là interface nhỏ và ổn định.

### Quyết định 2: registry là `Map` tĩnh trong module

Ưu điểm:

- đơn giản
- lookup O(1)
- không cần lifecycle phức tạp

Nhược điểm:

- chưa linh hoạt cho plugin/provider

Nhược điểm này được chấp nhận vì Task 4 đã được dự kiến để mở rộng.

### Quyết định 3: mỗi tool ở file riêng

Điều này giúp:

- tách trách nhiệm rõ ràng
- dễ test riêng sau này
- dễ thay thế implementation từng tool mà không ảnh hưởng registry API

## Cách đọc mã nguồn Task 3 theo thứ tự hợp lý

Nếu bạn học lại code này sau này, thứ tự nên đọc là:

1. `src/tools/tool.ts`
   - hiểu contract nền
2. `src/tools/readFile.ts`, `editFile.ts`, `search.ts`, `shell.ts`
   - xem từng built-in khai báo theo contract đó ra sao
3. `src/tools/registry.ts`
   - xem cách ghép các tool lại và lookup theo tên
4. `tests/agent/loop.test.ts`
   - xem behavior nào đang được khóa bằng test

## Kết luận

Task 3 hoàn thành phần nền tảng tối thiểu cho tools:

- có contract chung
- có 4 built-in tool đầu tiên
- có registry tra cứu theo tên
- có test khóa interface và built-in set
- có tài liệu học tập mô tả rõ phạm vi đã làm và chưa làm

Đây là một bước nhỏ nhưng quan trọng: từ thời điểm này, codebase đã có khái niệm “tool” được chuẩn hóa ở mức tối thiểu. Những task sau không cần phát minh lại interface nữa, mà chỉ cần xây tiếp quanh contract này.
