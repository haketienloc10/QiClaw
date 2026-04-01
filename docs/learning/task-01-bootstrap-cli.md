# Task 01 - Bootstrap TypeScript CLI

## Mục tiêu của task

Task 1 chỉ dựng bộ khung nhỏ nhất để một CLI viết bằng TypeScript có thể phát triển tiếp an toàn ở các task sau. Ở trạng thái hiện tại, codebase mới đáp ứng các mục tiêu nền tảng sau:

- có `package.json` để quản lý package và script
- có `tsconfig.json` để biên dịch mã nguồn TypeScript trong `src`
- có `vitest.config.ts` để chạy test trong môi trường Node
- có module CLI đầu tiên tại `src/cli/main.ts`
- có smoke test đầu tiên để khóa contract bootstrap tối thiểu

Task này chưa thêm hành vi CLI thực tế như parse tham số, REPL, command routing, đọc ghi dữ liệu hay xử lý terminal.

## Các file chính và vai trò thực tế

### 1. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/package.json`

File này mô tả package và các lệnh làm việc cơ bản cho bootstrap hiện tại.

Hiện tại file đang phản ánh đúng bootstrap tối thiểu của Task 1:

- `name` là `single-agent-cli-runtime`
- `type` là `module` để dùng ESM
- có 3 script nền tảng:
  - `npm run build`
  - `npm run dev`
  - `npm test`
- chỉ giữ `devDependencies` thật sự cần cho bootstrap

#### Dev dependencies hiện có

- `@types/node`
- `tsx`
- `typescript`
- `vitest`

Nhóm này đủ để:

- biên dịch TypeScript
- chạy test bằng Vitest
- chạy entrypoint TypeScript trực tiếp trong giai đoạn phát triển
- cung cấp type cho môi trường Node.js

Task 1 chưa cần dependency runtime nào khác vì production code hiện tại chưa dùng parser, validation, persistence hay markdown processing.

### 2. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tsconfig.json`

File này giữ cấu hình TypeScript tối thiểu nhưng rõ ràng.

Các điểm quan trọng của cấu hình hiện tại:

- `target: ES2022`
- `module: NodeNext`
- `moduleResolution: NodeNext`
- `strict: true`
- `rootDir: "src"`
- `outDir: "dist"`
- `types: ["node"]`
- `include` chỉ build `src/**/*.ts`

Thiết lập này có hai ý nghĩa quan trọng trong Task 1:

1. TypeScript hiểu đúng runtime Node cho production code bootstrap.
2. Output build được giữ gọn: thư mục `dist` chỉ chứa production code trong `src`, không kéo theo `tests` hay `vitest.config.ts`.

Vì `tsconfig.json` chỉ include `src`, việc thêm `vitest/globals` ở đây là không cần thiết cho bootstrap hiện tại và dễ gây hiểu nhầm rằng test đang được type-check bằng config này.

### 3. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/vitest.config.ts`

File cấu hình Vitest hiện tại vẫn rất nhỏ, nhưng đã thể hiện rõ môi trường chạy test:

- `test.environment = 'node'`
- `test.include = ['tests/**/*.test.ts']`

Việc khóa environment là `node` giúp intent của project rõ ràng hơn: đây là CLI runtime, không phải ứng dụng browser.

### 4. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/src/cli/main.ts`

Đây là production entrypoint tối thiểu của Task 1.

Hiện tại file này có 3 phần chính:

1. `type Cli` với method `run(): Promise<number>`
2. `buildCli()` trả về object CLI runtime tối thiểu
3. một entrypoint block dùng `process.exitCode`

Hành vi hiện tại của `buildCli()` được giữ đúng mức tối thiểu:

- tạo object CLI
- `run()` resolve về exit code `0`
- chưa thêm side effect nào khác

Entrypoint block cũng rất nhỏ:

- chỉ chạy khi file được gọi trực tiếp
- tạo CLI qua `buildCli()`
- gọi `run()`
- gán kết quả vào `process.exitCode`

Điểm này quan trọng vì nó thể hiện rõ intent của plan: `buildCli()` là API bootstrap, còn file vẫn có thể hoạt động như điểm vào thực thi sau này.

### 5. `/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli/tests/cli/repl.test.ts`

Tên file hiện là `repl.test.ts`, nhưng nội dung thực tế mới là bootstrap smoke test. Tên file được giữ nguyên để không lệch khỏi plan, nhưng không nên hiểu đây là test cho REPL thật.

Cụ thể, test đang xác nhận rằng:

- `buildCli()` trả về một object
- object đó có method `run`
- gọi `run()` sẽ resolve về exit code `0`

Nói ngắn gọn: `repl.test.ts` hiện là file smoke test cho bootstrap, chưa phải test cho REPL behavior.

## Contract bootstrap hiện tại

Task 1 hiện khóa một contract rất nhỏ nhưng có ích cho các bước sau:

```ts
export type Cli = {
  run(): Promise<number>;
};

export function buildCli(): Cli
```

Ý nghĩa của contract này:

- code bên ngoài có một điểm vào ổn định là `buildCli()`
- CLI runtime trả về exit code rõ ràng
- các task sau có thể mở rộng hành vi bên trong `run()` mà chưa cần đổi shape API ngay lập tức

## Cách hiểu đúng về TDD trong task này

Không nên ghi các khẳng định lịch sử không thể kiểm chứng trực tiếp từ repository. Thay vào đó, tài liệu nên mô tả luồng TDD mà task này hướng tới một cách tổng quát.

Luồng TDD phù hợp cho Task 1 là:

1. viết smoke test trước để mô tả contract bootstrap mong muốn
2. chạy test mục tiêu để thấy trạng thái RED
3. thêm production code nhỏ nhất để test pass
4. chạy lại test để xác nhận GREEN
5. build project để kiểm tra cấu hình compile vẫn đúng

Với task bootstrap như thế này, TDD giúp giữ scope rất chặt:

- chỉ thêm đúng API cần thiết
- tránh cài sớm REPL hoặc logic runtime chưa được yêu cầu
- có test khóa contract tối thiểu ngay từ đầu

## Những gì Task 1 thực sự đã làm

Ở trạng thái checked-in hiện tại, Task 1 mới thêm đúng các phần sau:

1. một package TypeScript dùng ESM
2. script `build`, `dev`, `test`
3. cấu hình TypeScript để build production code từ `src`
4. cấu hình Vitest cho môi trường Node
5. module `src/cli/main.ts` export `buildCli()`
6. `run()` trả về exit code `0`
7. entrypoint block gán `process.exitCode`
8. một smoke test khóa bootstrap contract

## Những gì cố ý chưa làm

Để giữ đúng scope tối thiểu, Task 1 chưa triển khai các phần sau:

- chưa có REPL thật
- chưa parse command line arguments
- chưa dùng runtime dependency như `yargs`, `zod`, `gray-matter` hay `better-sqlite3`
- chưa có lệnh con hay command dispatcher
- chưa có xử lý stdin/stdout thực tế
- chưa có error mapping sang exit code khác `0`
- chưa có integration test cho luồng chạy CLI từ shell
- chưa có publish config hay binary mapping trong `package.json`

Việc chưa có các phần này là chủ ý, không phải thiếu sót ngoài ý muốn.

## Các phần chưa làm này sẽ được hấp thụ vào task nào

Để dễ theo dõi roadmap, dưới đây là mapping trực tiếp từ từng mục “chưa làm” của Task 1 sang các task sau trong implementation plan.

- **chưa có REPL thật**
  - sẽ được hấp thụ chủ yếu ở **Task 8** qua `src/cli/repl.ts` và việc wire runtime vào CLI
- **chưa parse command line arguments**
  - phần này nằm gần nhất với **Task 8** vì đó là lúc CLI được nối với runtime thật
- **chưa dùng runtime dependency như `yargs`, `zod`, `gray-matter` hay `better-sqlite3`**
  - `better-sqlite3` đã bắt đầu được dùng ở **Task 2** cho persistence
  - `zod` dự kiến bắt đầu xuất hiện ở **Task 3** trong tool input parsing như `edit_file`
  - `gray-matter` dự kiến xuất hiện ở **Task 6** khi load skill markdown có frontmatter
  - `yargs` hợp lý nhất ở **Task 8** khi CLI bắt đầu nhận input/runtime wiring rõ hơn
- **chưa có lệnh con hay command dispatcher**
  - phần dispatcher cho tool call nằm ở **Task 4**
  - phần điều hướng ở mức CLI sẽ gần **Task 8** hơn
- **chưa có xử lý stdin/stdout thực tế**
  - sẽ được hấp thụ ở **Task 8** khi thêm REPL thật
- **chưa có error mapping sang exit code khác `0`**
  - phần này hợp lý nhất ở **Task 8** khi CLI runtime đã được wire xong và có đường đi lỗi thực tế
- **chưa có integration test cho luồng chạy CLI từ shell**
  - gần nhất với **Task 8**, vì lúc đó mới có REPL/runtime hoàn chỉnh để test end-to-end ở mức CLI
- **chưa có publish config hay binary mapping trong `package.json`**
  - chưa nằm rõ trong spec hiện tại; nếu vẫn giữ đúng plan gốc thì phần này **chưa được hấp thụ trong Task 1–8** và sẽ là phần mở rộng sau MVP

Tóm lại, Task 1 chỉ dựng bootstrap. Những phần người dùng cuối nhìn thấy rõ hơn ở bề mặt CLI chủ yếu dồn về **Task 8**, còn các phần lõi runtime và dispatch được hấp thụ dần ở **Task 2–7**.

## Vì sao cấu trúc này hợp lý cho bước bootstrap

Task 1 không nhắm tới tính năng người dùng cuối. Nó chỉ tạo nền để các task sau phát triển nhất quán hơn.

Giá trị của bootstrap hiện tại là:

- production entrypoint đã tồn tại
- test đầu tiên đã khóa API tối thiểu
- build output sạch và tách riêng khỏi test
- package manifest giữ scope tối thiểu, chưa kéo thêm runtime dependency chưa dùng

Nhờ vậy, các task sau có thể tập trung vào hành vi mới thay vì phải dựng lại nền tảng project.

## Cách chạy lại Task 1

Thực hiện trong worktree:

`/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli`

### Chạy targeted test

```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" test -- tests/cli/repl.test.ts
```

Kết quả mong đợi:

- 1 file test pass
- 2 test pass

### Build project

```bash
npm --prefix "/home/locdt/Notes/VSCode/QiClaw/.worktrees/single-agent-cli" run build
```

Kết quả mong đợi:

- TypeScript compile thành công
- output trong `dist` chỉ chứa mã build từ `src`

## Tóm tắt

Task 1 hiện là một bootstrap rất nhỏ cho CLI runtime:

- có package manifest đúng intent tối thiểu
- có TypeScript config sạch cho build output
- có Vitest config chạy trong Node
- có `buildCli()` làm điểm vào ban đầu
- có `run()` trả về exit code `0`
- có smoke test đầu tiên trong `tests/cli/repl.test.ts`, dù file này chưa kiểm tra REPL thật

Đây là nền tối thiểu, đúng phạm vi, chưa thêm hành vi runtime ngoài yêu cầu.
