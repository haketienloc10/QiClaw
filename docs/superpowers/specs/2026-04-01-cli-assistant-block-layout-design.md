# CLI Assistant Block Layout Design

## Goal
Cập nhật UI CLI của QiClaw trên branch hiện tại để cả prompt mode và interactive mode đều render output assistant theo block rõ ràng: có đúng 1 dòng trống sau user input, header `QiClaw`, toàn bộ assistant body thụt 2 spaces, tool activity nằm trong body đã thụt dòng, và footer giữ nguyên format hiện tại nhưng không thụt dòng.

## Current state
- `src/cli/main.ts` chịu trách nhiệm wiring CLI observer, REPL, prompt mode và footer flush.
- `src/cli/repl.ts` hiện chỉ in `finalAnswer` trực tiếp sau mỗi turn trong interactive mode.
- `src/telemetry/display.ts` hiện format tool activity summaries và footer summary, nhưng không quản lý assistant block layout.
- Footer hiện đã có format đúng yêu cầu và phải được giữ nguyên, chỉ cần đảm bảo nó không bị indent.

## Requirements
1. Áp dụng cho cả `--prompt` mode và interactive REPL.
2. Sau khi user submit, phải có đúng 1 dòng trống trước assistant output block.
3. Assistant output block bắt đầu bằng header `QiClaw` ở đầu dòng.
4. Toàn bộ final answer phải được indent 2 spaces trên mọi dòng.
5. Tool activity lines phải giữ nội dung compact hiện tại nhưng cũng nằm trong assistant body đã indent 2 spaces.
6. Footer summary giữ nguyên format hiện tại và luôn bắt đầu ở đầu dòng, không indent.
7. Patch ít xâm lấn, không đổi telemetry schema, không phá flow CLI hiện có.

## Recommended approach
Sửa ở CLI render layer bằng một assistant block writer nhỏ, thay vì đẩy layout vào telemetry formatter.

### Why this approach
- `src/telemetry/display.ts` hiện chỉ nên quyết định nội dung từng dòng tool/footer, không nên biết về final answer text block.
- `src/cli/main.ts` và `src/cli/repl.ts` đã là nơi nối stdout + observer + final answer, nên phù hợp để thêm block layout state nhẹ.
- Cách này giữ footer path riêng biệt và giảm nguy cơ làm hỏng telemetry/debug logic.

## Design

### 1. Assistant block writer responsibilities
Thêm một writer/presenter nhẹ ở CLI layer để quản lý 3 loại output:
- assistant body lines
- final answer text
- footer lines

Writer này cần các hành vi sau:
- `writeAssistantLine(text)`
  - nếu đây là output assistant đầu tiên của turn:
    - in đúng 1 dòng trống
    - in `QiClaw`
  - sau đó in `  ${text}`
- `writeAssistantTextBlock(text)`
  - đảm bảo prelude `QiClaw` đã được in
  - split theo dòng và indent mọi dòng bằng 2 spaces
  - preserve dòng trống nội bộ bằng cách in `  ` cho dòng rỗng trong body
- `writeFooterLine(text)`
  - in thẳng text ở đầu dòng, không indent
- `resetTurn()`
  - reset state để turn sau lại in prelude đúng một lần

### 2. Prompt mode flow
Trong prompt mode của `src/cli/main.ts`:
- giữ `runOnce(parsed.prompt)` như hiện tại
- thay vì `stdout.write(finalAnswer + '\n')` trực tiếp:
  - dùng assistant block writer để render final answer block
- tool activity observer callback cũng đi qua assistant writer để được indent 2 spaces
- sau cùng, footer flush phải đi qua path không indent
- sau khi xong turn, reset turn state

### 3. Interactive mode flow
Trong interactive mode:
- giữ loop hiện tại của `src/cli/repl.ts`
- thay vì `writeLine(result.finalAnswer)` trực tiếp, cho `writeLine` từ caller trở thành assistant-block-aware writer
- `afterTurnRendered()` tiếp tục flush footer như hiện tại
- sau footer flush thì reset state cho turn tiếp theo
- `/exit` và `Goodbye.` không đi qua assistant block writer

### 4. Telemetry display responsibilities
`src/telemetry/display.ts` giữ nguyên trách nhiệm hiện tại:
- format tool activity summary line
- format footer line

Không thêm logic header `QiClaw`, indent final answer, hay spacing trước assistant block vào file này.
Nếu cần, chỉ đổi callback wiring ở `src/cli/main.ts` để phân biệt:
- tool activity -> assistant body writer
- footer -> footer writer

### 5. Output contract
Ví dụ target cho cả hai mode:

```text
> đọc code thay đổi và tóm tắt ngắn gọn cho tôi

QiClaw
  Tôi sẽ kiểm tra các file thay đổi trước, rồi đọc diff để tóm tắt ngắn.

  · shell git status --porcelain=v1
  · shell git diff

  Tóm tắt:
  - ...

─ completed • 2 provider • 2 tools • 516 in / 274 out • 4.8s
```

Contract cụ thể:
- có đúng 1 dòng trống giữa dòng prompt và `QiClaw`
- `QiClaw` không indent
- mọi dòng sau đó thuộc assistant body đều indent 2 spaces
- footer không indent

## Files to modify
- `src/cli/main.ts`
  - thêm/wire assistant block writer cho prompt mode + observer callbacks + footer flush
- `src/cli/repl.ts`
  - giữ flow chính, chỉ hỗ trợ caller render final answer qua writer phù hợp
- có thể thêm helper nhỏ trong CLI layer nếu cần tách trách nhiệm render block
- `tests/cli/repl.test.ts`
  - thêm/cập nhật assertions cho prompt mode và interactive mode
- `tests/telemetry/display.test.ts`
  - chỉ sửa nếu thay đổi callback contract; còn không thì giữ nguyên

## Testing strategy
1. Prompt mode renders:
   - 1 dòng trống trước `QiClaw`
   - final answer multiline được indent 2 spaces
   - tool activity lines được indent 2 spaces
   - footer không indent
2. Interactive mode renders theo cùng contract.
3. `/exit` flow và `Goodbye.` không thay đổi.
4. Footer string giữ nguyên format hiện tại.
5. Compact tool summaries hiện có (`shell`, `read_file`, `edit_file`, `search`) giữ nguyên nội dung, chỉ đổi vị trí/indent trong layout.

## Risks and mitigations
- **Rủi ro double-spacing giữa turn:** reset writer state ngay sau footer flush hoặc sau turn hoàn tất.
- **Rủi ro footer bị indent:** tách riêng đường ghi footer khỏi assistant body writer.
- **Rủi ro prompt mode và interactive mode lệch nhau:** dùng cùng một block writer abstraction cho cả hai.
- **Rủi ro phá telemetry logic:** không sửa emitter/schema, chỉ sửa layer render stdout.
