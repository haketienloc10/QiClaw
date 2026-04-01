# Task 06 - Minimal memory và skill registry cho single-agent CLI runtime

## Mục tiêu của task này

Task 6 mở rộng lớp context đã có ở Task 5 bằng hai nguồn dữ liệu mới mà `promptBuilder` đã chuẩn bị chỗ sẵn từ trước:

- `memoryText`
- `skillsText`

Điểm quan trọng là Task 6 không cố xây một hệ thống agent đầy đủ, cũng không nối thẳng vào runtime loop. Mục tiêu chỉ là bổ sung hai capability tối thiểu nhưng đủ sạch để các task sau có thể dùng lại:

1. một memory store bền vững bằng SQLite để lưu các mẩu nhớ nhỏ
2. một cơ chế recall đơn giản để lấy lại các memory phù hợp theo truy vấn text
3. một renderer để biến recalled memories thành prompt text ổn định
4. một skill loader đọc markdown skill files có frontmatter tối thiểu
5. một skill registry để lookup theo tên
6. một skill renderer để biến skill đã nạp thành prompt text ổn định

Nói ngắn gọn, Task 5 đã mở cổng nhập cho memory và skills ở cấp prompt assembly, còn Task 6 thêm lớp dữ liệu để thực sự tạo ra hai string đó.

## Vì sao cần task này ngay sau Task 5

Task 5 đã chốt rằng final system prompt có thể ghép từ nhiều phần:

- base system prompt
- memory text
- skills text
- history summary

Nhưng ở thời điểm đó, `memoryText` và `skillsText` mới chỉ là tham số chờ sẵn. Chưa có:

- contract cho memory items
- chỗ lưu memory
- cách recall memory theo query
- format render memory cho prompt
- chỗ nạp skill markdown
- cách tra cứu skill theo tên
- format render skill cho prompt

Nếu không thêm lớp này, `promptBuilder` chỉ mới đúng về shape chứ chưa có dữ liệu thật để caller truyền vào.

## Phạm vi đã hoàn thành

Task 6 thêm các file chính sau:

- `/home/locdt/Notes/VSCode/QiClaw/src/memory/memoryTypes.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/memory/memoryStore.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/memory/recall.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/skills/loader.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/skills/registry.ts`
- `/home/locdt/Notes/VSCode/QiClaw/src/skills/renderer.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/memory/memoryStore.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/skills/loader.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/docs/learning/task-06-minimal-memory-and-skill-registry.md`

Thiết kế được giữ rất chặt theo MVP:

- memory chỉ có 3 loại: `fact`, `procedure`, `failure`
- recall dùng `LIKE` matching đơn giản trên `searchable_content` đã normalize từ `content`
- thứ tự recall phải deterministic
- skill loader chỉ đọc markdown file có frontmatter rất đơn giản và chấp nhận cả LF lẫn CRLF
- frontmatter yêu cầu tối thiểu `name` và `description`
- không thêm dependency mới để parse frontmatter
- không xây retrieval ranking hay plugin system phức tạp

## Workflow TDD đã được áp dụng như thế nào

Task này được làm theo đúng vòng đỏ -> xanh -> dọn sạch trong phạm vi tối thiểu.

### Bước 1: viết test trước

Hai test file mới được tạo trước implementation:

- `/home/locdt/Notes/VSCode/QiClaw/tests/memory/memoryStore.test.ts`
- `/home/locdt/Notes/VSCode/QiClaw/tests/skills/loader.test.ts`

Các test khóa các behavior cốt lõi:

#### Với memory

- lưu memory vào SQLite
- recall theo query text bằng `LIKE` trên nội dung đã normalize sẵn
- matching query với non-ASCII theo dạng normalize deterministic
- dấu gạch dưới `_` trong query được hiểu là ký tự literal, không phải wildcard SQL
- trả kết quả theo thứ tự deterministic
- persist dữ liệu qua nhiều instance của store
- giới hạn số lượng trả về theo `limit`
- render recalled memories thành prompt text ổn định

#### Với skills

- đọc các file `.md` theo thứ tự tên file đã sort
- parse frontmatter strict theo format đơn giản
- chấp nhận cả LF và CRLF trước khi parse frontmatter/body
- yêu cầu có `name` và `description`
- body markdown sau frontmatter trở thành `instructions`
- registry lookup theo tên chính xác
- renderer tạo prompt text deterministic, kể cả khi `instructions` có nhiều dòng

### Bước 2: chạy pha đỏ

Lệnh đã chạy để xác nhận test fail đúng lý do:

- `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/memory/memoryStore.test.ts tests/skills/loader.test.ts`

Lần đầu chạy sau khi cài dependency, test fail vì các module chưa tồn tại:

- `../../src/memory/memoryStore.js`
- `../../src/skills/loader.js`

Đây là failure đúng bản chất TDD: behavior đã được mô tả bằng test nhưng production code chưa có.

### Bước 3: viết code tối thiểu để pass

Sau pha đỏ rõ ràng, implementation tối thiểu mới được thêm.

Các quyết định ở pha xanh đều theo hướng cơ học, dễ test:

- memory store dùng bảng SQLite rất nhỏ
- recall chỉ split query thành terms, normalize chúng, rồi sinh điều kiện `searchable_content LIKE ? ESCAPE '\\' OR ...`
- `searchable_content` được lưu sẵn khi save và được backfill cho database cũ nếu thiếu cột này
- order dùng `created_at ASC, id ASC`
- renderer chỉ ghép string line-by-line
- skill loader tự parse frontmatter bằng regex và line parser đơn giản sau khi normalize line ending về `\n`
- file order dùng sort theo tên file
- registry chỉ là `Map<string, LoadedSkill>`

### Bước 4: chạy lại targeted tests

Sau implementation, cùng lệnh test ở trên pass toàn bộ.

Điểm quan trọng là không có phần nào bị đẩy vượt phạm vi MVP. Không thêm semantic recall, không thêm fuzzy ranking, không thêm inheritance hay plugin hooks.

## Phân tích chi tiết phần memory

## 1. `/home/locdt/Notes/VSCode/QiClaw/src/memory/memoryTypes.ts`

File này định nghĩa contract tối thiểu cho memory subsystem.

### Các type chính

- `MemoryKind = 'fact' | 'procedure' | 'failure'`
- `MemoryRecord`
- `SaveMemoryInput`

### Vì sao chỉ có 3 kind

Ba loại này phản ánh đúng mục tiêu MVP:

- `fact`: điều hệ thống biết về user, project, preference, environment
- `procedure`: cách làm nên lặp lại, ví dụ workflow hoặc rule vận hành
- `failure`: điều từng hỏng và nên tránh lặp lại

Đây là vocabulary đủ nhỏ để caller và prompt renderer dễ dùng, nhưng vẫn đủ diễn đạt ba nhóm tri thức quan trọng nhất trong agent runtime ban đầu.

Nếu thêm quá nhiều loại ngay từ đầu như `goal`, `constraint`, `preference`, `decision`, `warning`, `pattern` thì memory system sẽ trông có vẻ linh hoạt hơn nhưng thực tế lại khó ghi nhớ nhất quán và khó test hơn.

## 2. `/home/locdt/Notes/VSCode/QiClaw/src/memory/memoryStore.ts`

Đây là store chính, dùng `better-sqlite3` giống hướng đã có trong codebase.

### Schema

Bảng `memories` có các cột:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `kind TEXT NOT NULL`
- `content TEXT NOT NULL`
- `searchable_content TEXT`
- `source TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Schema này rất nhỏ nhưng đủ cho MVP:

- có id để giữ thứ tự ổn định khi timestamp bằng nhau
- có `kind` để renderer gắn nhãn
- có `content` là phần text gốc để hiển thị lại cho prompt
- có `searchable_content` là bản normalize để recall deterministic hơn
- có `source` để prompt text nói rõ memory đến từ đâu
- có `created_at` để sắp xếp deterministic và hỗ trợ recency đơn giản về sau

### Hành vi `save(...)`

`save(...)` nhận `SaveMemoryInput`, nếu không có `createdAt` thì tự gán `new Date().toISOString()`.

Sau khi insert, method trả luôn `MemoryRecord` hoàn chỉnh gồm cả `id` sinh từ SQLite.

Điểm này hữu ích vì:

- test có thể assert record vừa lưu
- caller có thể log hay dùng record ngay mà không phải query lại

### Hành vi `recall(...)`

`recall(query, limit)` đi theo hướng rất cơ học:

1. normalize query thành danh sách term
2. loại trùng term bằng `Set`
3. nếu query rỗng hoặc `limit <= 0` thì trả `[]`
4. query trên `searchable_content` thay vì `content` gốc
5. escape `%`, `_`, và `\` rồi dùng `LIKE ... ESCAPE '\'`
6. sort theo `created_at ASC, id ASC`
7. áp `LIMIT ?`

`searchable_content` được tạo ngay khi save bằng cách normalize text về dạng lower-case deterministic. Với hành vi hiện tại, hệ thống match ổn định cho các query non-ASCII như `VIỆT` với content chứa `Việt`, đồng thời giữ `_` trong query là ký tự literal thay vì wildcard SQL.

### Vì sao dùng `LIKE` thay vì full-text search

MVP chỉ cần matching rất đơn giản. `LIKE` có các ưu điểm:

- không cần migration riêng cho FTS
- không cần virtual table
- dễ giải thích
- dễ test equality
- đủ cho lượng memory nhỏ ban đầu

Nhược điểm rõ ràng là recall còn rất ngây thơ:

- không có ranking thông minh
- không có weight theo kind
n- không có stemming hay synonym
- không dùng source hoặc metadata để filter

Nhưng đó là cái giá chấp nhận được để giữ hệ thống nhỏ.

### Vì sao order là `created_at ASC, id ASC`

Task yêu cầu deterministic order. Với MVP này, sort tăng dần theo thời điểm tạo rồi tới id là một rule rất rõ:

- memory cũ hơn xuất hiện trước
- nếu cùng timestamp thì id phá hòa

Cách này không cố nói rằng memory cũ hơn quan trọng hơn. Nó chỉ chốt một ordering ổn định để renderer và test có output reproducible.

Nếu sau này cần ranking theo relevance hoặc recency, contract order có thể đổi ở một task chuyên về retrieval.

## 3. `/home/locdt/Notes/VSCode/QiClaw/src/memory/recall.ts`

File này làm đúng một việc: biến `MemoryRecord[]` thành text để chèn vào system prompt.

### Format hiện tại

Nếu có memory:

- dòng đầu là `Memory:`
- mỗi memory thành một dòng `- Label: content (source: source)`

Ví dụ:

- `- Fact: User prefers Vietnamese responses. (source: profile)`
- `- Procedure: Use TDD for new runtime features. (source: process)`
- `- Failure: Skipping typecheck caused avoidable regressions. (source: postmortem)`

Nếu không có memory, hàm trả `''`.

### Vì sao renderer không nhóm phức tạp hơn

Có thể tưởng tượng nhiều format giàu hơn như:

- nhóm theo kind bằng các subsection riêng
- thêm timestamp
- thêm source ID hoặc tags
- tự truncate theo budget

Nhưng ở Task 6 điều đó chưa cần. `promptBuilder` đã biết cách bỏ qua chuỗi rỗng, nên chỉ cần một renderer deterministic và rõ ràng là đủ.

## Phân tích chi tiết phần skills

## 4. `/home/locdt/Notes/VSCode/QiClaw/src/skills/registry.ts`

File này định nghĩa `LoadedSkill` và `SkillRegistry`.

### `LoadedSkill`

Shape tối thiểu gồm:

- `name`
- `description`
- `instructions`

Tức là một skill sau khi load vào hệ thống được rút về đúng 3 phần đủ dùng cho prompt assembly:

- tên để lookup
- mô tả ngắn để hiểu skill dùng làm gì
- instructions là phần body thật để chèn vào prompt khi cần

### `SkillRegistry`

Registry hiện chỉ là `Map<string, LoadedSkill>` và có method:

- `getByName(name)`

Điều này phản ánh đúng yêu cầu tối thiểu của task: lookup by name.

Registry chưa làm các việc như:

- alias
n- namespace
- fuzzy search
- duplicate validation mạnh tay
- category filtering
- dependency graph giữa skills

Tất cả các phần đó đều vượt MVP.

## 5. `/home/locdt/Notes/VSCode/QiClaw/src/skills/loader.ts`

Đây là phần interesting nhất của skill subsystem vì nó biến markdown files thành object runtime.

### Hành vi chính

`loadSkillsFromDirectory(directory)` sẽ:

1. đọc toàn bộ entries trong directory
2. lọc các file `.md`
3. sort theo tên file tăng dần
4. đọc từng file
5. parse frontmatter và body
6. trả mảng `LoadedSkill[]`

### Vì sao deterministic file order quan trọng

Nếu skill loader phụ thuộc vào thứ tự đọc file từ filesystem mà không sort, output có thể dao động giữa các môi trường hoặc lần chạy khác nhau. Điều đó làm test khó ổn định và prompt text có thể thay đổi không cần thiết.

Sort theo tên file là rule đơn giản nhất để khóa thứ tự.

### Frontmatter format được giữ strict

Task yêu cầu frontmatter đơn giản và tránh dependency mới như `gray-matter`. Vì vậy parser hiện tại chỉ hỗ trợ format rất hẹp:

- file phải bắt đầu bằng block `---`
- trước khi parse, line ending được normalize để chấp nhận cả LF và CRLF
- mỗi dòng frontmatter phải là `key: value`
- bắt buộc có `name`
- bắt buộc có `description`
- phần còn lại sau frontmatter là `instructions`

Ví dụ hợp lệ:

```md
---
name: tdd
description: Follow red-green-refactor.
---
Write a failing test first.
```

### Vì sao parser strict là lựa chọn đúng ở đây

Parser strict giúp có 3 lợi ích:

1. implementation nhỏ
2. error cases rõ ràng
3. caller không bị ảo tưởng rằng hệ thống đã hỗ trợ YAML frontmatter đầy đủ

Nếu parser nửa vời nhưng cố “hỗ trợ nhiều”, các edge case sẽ nhanh chóng phình ra:

- quoted string
- multiline YAML
- list
- nested object
- comment line
- duplicate key

Task 6 cố ý tránh vùng đó.

## 6. `/home/locdt/Notes/VSCode/QiClaw/src/skills/renderer.ts`

Renderer của skills cũng đi theo hướng giống memory: rất mechanical.

### Format hiện tại

Nếu có skills:

- dòng đầu là `Skills:`
- mỗi skill có ít nhất 2 dòng
  - `- <name>: <description>`
  - từng dòng của `instructions` được render thành một dòng riêng với indent 2 spaces

Nếu không có skills, trả `''`.

### Vì sao body không giữ markdown phức tạp

Ở mức hiện tại, `instructions` chỉ được trim rồi render như text. Không có parser markdown riêng, không tách heading, không normalize bullet list nhiều tầng. Tuy vậy, renderer vẫn giữ multiline instructions readable bằng cách indent nhất quán từng dòng thay vì chỉ prefix dòng đầu tiên.

Lý do là vì Task 6 chỉ cần “đủ để promptBuilder nhận một string skillsText hợp lệ”. Rich formatting có thể để cho các task sau nếu prompt assembly trở nên tinh vi hơn.

## Các behavior đã được khóa bằng test

## Test memory

File: `/home/locdt/Notes/VSCode/QiClaw/tests/memory/memoryStore.test.ts`

### Behavior 1: save + recall hoạt động và order deterministic

Test tạo 3 memory thuộc các kind khác nhau, sau đó recall với query `test build`.

Kỳ vọng:

- cả memory chứa `test` và memory chứa `build` đều được lấy ra
- order là theo `createdAt`, sau đó `id`
- record trả về có đủ `id`, `kind`, `content`, `source`, `createdAt`

### Behavior 2: persistence qua nhiều store instance

Test lưu dữ liệu bằng một instance, rồi tạo instance mới đọc lại cùng file SQLite.

Điều này chứng minh store thực sự backed by SQLite file, không chỉ là in-memory adapter giả.

### Behavior 3: recall limit được áp dụng

Test query `runtime` với `limit = 1` và xác nhận chỉ lấy ra đúng một memory đầu tiên theo order đã chốt.

### Behavior 4: renderer tạo prompt text ổn định

Test `renderRecalledMemories(...)` assert exact string output. Đây là điểm quan trọng vì prompt text phải deterministic để debug và refactor dễ hơn.

## Test skills

File: `/home/locdt/Notes/VSCode/QiClaw/tests/skills/loader.test.ts`

### Behavior 1: loader sort file order trước khi parse

Test tạo hai file:

- `b-review.md`
- `a-tdd.md`

Kỳ vọng output trả theo thứ tự `a-tdd.md` rồi `b-review.md`, không phải thứ tự filesystem trả về.

### Behavior 2: loader parse frontmatter và body đúng shape

Mỗi file test có:

- `name`
- `description`
- body một dòng

Kỳ vọng output `LoadedSkill[]` có đúng `name`, `description`, `instructions`.

### Behavior 3: thiếu frontmatter bắt buộc thì throw

Test tạo file thiếu `description` và assert loader throw lỗi chứa thông điệp `Skill file is missing required frontmatter`.

### Behavior 4: registry lookup exact match

Test `SkillRegistry.getByName('review')` trả skill tương ứng, còn `getByName('missing')` trả `undefined`.

### Behavior 5: renderer tạo prompt text ổn định

Test `renderSkillsForPrompt(...)` assert exact string output, gồm header, dòng description và dòng instructions cho từng skill.

## Các quyết định thiết kế quan trọng

## 1. Dùng SQLite cho memory thay vì file JSON

Dù memory MVP rất nhỏ, việc dùng SQLite ngay từ đầu có lợi thế:

- phù hợp với dependency đã có trong repo
- schema rõ ràng
- persist thật, không cần đọc/ghi toàn bộ file mỗi lần
- dễ mở rộng cho query sau này

Nếu dùng JSON file, implementation ban đầu có thể còn ngắn hơn, nhưng sẽ nhanh chóng thiếu cấu trúc khi cần query, sort, dedupe hoặc limit.

## 2. Tách `memoryTypes` ra file riêng

Việc tách `memoryTypes.ts` giúp phần contract của memory subsystem không bị trộn vào implementation SQLite. Đây là bước nhỏ nhưng tốt cho việc:

- test import type rõ hơn
- sau này thay store backend không cần đổi renderer/types
- giữ file store tập trung vào persistence

## 3. `recall.ts` chỉ render, không query

Tên file `recall.ts` ở đây được dùng cho recall text rendering, không phải nơi trực tiếp chạm SQLite. Điều này giữ separation khá sạch:

- `memoryStore.ts` lo save/query
- `recall.ts` lo biến query result thành prompt text

Nếu sau này thêm ranking hay filtering layer riêng, có thể chen nó ở giữa mà không phá renderer.

## 4. Skill loader không phụ thuộc gray-matter

Đây là quyết định đúng với constraint “prefer no new dependency”.

Bởi vì format frontmatter mong muốn rất đơn giản, dùng regex + line parser là đủ. Không nên kéo thêm dependency lớn chỉ để parse 2 field nhỏ.

## 5. Registry chỉ lookup exact name

Exact match là đủ cho MVP vì caller thường đã biết skill nào muốn lấy. Nếu chưa biết, phần chọn skill nên là trách nhiệm của một selection layer về sau, không phải của registry nền.

## Những gì Task 6 cố ý chưa làm

Đây là phần rất quan trọng để tránh scope creep.

## 1. Chưa có memory ranking thông minh

Hiện recall chỉ dùng OR `LIKE` matching trên `content`.

Chưa có:

- score theo số term match
- boost theo `kind`
- boost theo recency
- embedding/vector search
- semantic expansion

### Nên để cho task sau nào

Phù hợp với một task chuyên về memory retrieval nâng cao hoặc long-session personalization.

## 2. Chưa có memory dedupe, update, delete

Store hiện mới có:

- `save`
- `recall`

Chưa có:

- sửa memory đã lưu
- xóa memory cũ
- merge memory tương tự nhau
- unique constraint theo content/source

### Nên để cho task sau nào

Phù hợp với task memory lifecycle management hoặc memory consolidation.

## 3. Chưa có prompt-budget-aware truncation cho memory/skills text

Renderer hiện chỉ biến toàn bộ input thành string. Chưa có:

- cắt bớt skills theo ngân sách
- cắt bớt memories theo ngân sách
- chọn subset tối ưu theo budget bucket từ Task 5

### Nên để cho task sau nào

Phù hợp với task prompt assembly/runtime wiring sau khi memory và skills thực sự được nối vào agent loop.

## 4. Chưa có recursive hoặc namespaced skill discovery

Loader hiện chỉ đọc đúng một directory, không duyệt đệ quy và không có namespace.

Chưa có:

- subdirectory traversal
- `team/skill-name` style lookup
- alias hoặc override resolution

### Nên để cho task sau nào

Phù hợp với task skill packaging hoặc multi-source skill catalogs.

## 5. Chưa có validation mạnh cho duplicate skill names

Nếu hai file khác nhau cùng `name`, registry hiện tại sẽ bị bản ghi sau ghi đè trong `Map`.

Task 6 chưa khóa hành vi này bằng test hay chặn bằng error.

### Nên để cho task sau nào

Phù hợp với task hardening/validation cho skill ingestion.

## 6. Chưa có runtime loop integration

Task 6 mới dừng ở mức helper và storage layer. Chưa có nơi nào trong runtime thực hiện chuỗi:

1. nhận query hiện tại
2. recall memories liên quan
3. chọn skills cần dùng
4. render thành `memoryText` và `skillsText`
5. truyền hai string đó vào `buildPromptWithContext(...)`

### Nên để cho task sau nào

Phù hợp với task orchestration hoặc agent runtime wiring sau này.

## 7. Chưa có học lại từ outcome thật của agent

Mặc dù đã có `failure` như một kind, Task 6 chưa có pipeline tự động ghi memory từ kết quả runtime hay post-run analysis.

### Nên để cho task sau nào

Phù hợp với task reflective memory capture hoặc post-task summarization.

## Quan hệ giữa Task 5 và Task 6

Task 5 và Task 6 ghép lại cho ta một khung context assembly rõ hơn:

### Task 5 cung cấp

- budget vocabulary
- history pruning
- deterministic history summary
- final prompt assembly qua `promptBuilder`

### Task 6 cung cấp

- nguồn dữ liệu bền cho memory
- recall text tối thiểu
- nguồn dữ liệu file-based cho skills
- registry lookup và skill prompt text tối thiểu

Nghĩa là sau Task 6, codebase đã có gần đủ các “mảnh rời” để một task kế tiếp nối chúng vào runtime loop thật.

## Cách đọc code Task 6 theo thứ tự hợp lý

Nếu muốn học lại sau này, nên đọc theo thứ tự sau:

1. `/home/locdt/Notes/VSCode/QiClaw/tests/memory/memoryStore.test.ts`
2. `/home/locdt/Notes/VSCode/QiClaw/tests/skills/loader.test.ts`
3. `/home/locdt/Notes/VSCode/QiClaw/src/memory/memoryTypes.ts`
4. `/home/locdt/Notes/VSCode/QiClaw/src/memory/memoryStore.ts`
5. `/home/locdt/Notes/VSCode/QiClaw/src/memory/recall.ts`
6. `/home/locdt/Notes/VSCode/QiClaw/src/skills/registry.ts`
7. `/home/locdt/Notes/VSCode/QiClaw/src/skills/loader.ts`
8. `/home/locdt/Notes/VSCode/QiClaw/src/skills/renderer.ts`
9. `/home/locdt/Notes/VSCode/QiClaw/src/context/promptBuilder.ts`

Đọc theo thứ tự này sẽ thấy rất rõ nhịp TDD:

- test mô tả contract trước
- type xác định shape dữ liệu
- store/loader tạo dữ liệu
- renderer biến dữ liệu thành text cho prompt
- prompt builder là nơi ghép text vào final system prompt ở task trước

## Bài học thiết kế rút ra từ Task 6

## Bài học 1: vocabulary nhỏ giúp memory dùng được thật

Ba kind `fact/procedure/failure` có vẻ ít, nhưng lại giúp caller dễ quyết định nên lưu gì. Vocabulary càng nhỏ thì xác suất dùng nhất quán càng cao.

## Bài học 2: deterministic trước, ranking sau

Trong giai đoạn nền móng, một recall “không thông minh lắm nhưng ổn định” có giá trị hơn một recall “có vẻ thông minh” nhưng khó giải thích và khó test.

## Bài học 3: frontmatter strict là một ưu điểm, không phải hạn chế

Khi hệ thống mới hình thành, việc chỉ hỗ trợ một subset rất nhỏ của frontmatter làm behavior dễ dự đoán hơn nhiều.

## Bài học 4: renderers nên ngu nhưng ổn định

Memory renderer và skill renderer hiện gần như chỉ ghép string. Điều đó tốt cho MVP vì:

- dễ assert exact output
- dễ debug prompt assembly
- không chôn policy phức tạp vào presentation layer

## Bài học 5: lưu trữ và lựa chọn nên là hai lớp khác nhau

Memory store chỉ lo persist/query cơ học. Nó chưa phải bộ não chọn memory tốt nhất. Tách hai chuyện này ra từ đầu giúp hệ thống dễ tiến hóa hơn.

## Kết luận

Task 6 đã thêm hai subsystem tối thiểu nhưng quan trọng cho runtime:

- memory subsystem có type contract rõ ràng, store SQLite nhỏ gọn, recall theo `LIKE`, và renderer deterministic
- skill subsystem có loader markdown với frontmatter strict, registry lookup theo tên, và renderer deterministic
- các behavior cốt lõi đã được khóa bằng test trước khi viết implementation
- toàn bộ thiết kế giữ đúng phạm vi MVP và tránh overbuild

Sau Task 6, `promptBuilder` không còn chỉ nhận `memoryText` và `skillsText` như các ô trống chờ sẵn nữa. Bây giờ codebase đã có những viên gạch đầu tiên để tạo ra hai phần text đó một cách thật sự, bền vững, dễ test, và đủ đơn giản để các task tiếp theo nối vào runtime loop.
