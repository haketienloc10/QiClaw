# QICLAW Shared Prompt File Design

## Context
QiClaw hiện ghép system prompt từ các file Markdown nằm trong từng agent package, dựa trên `effectivePromptFiles` và `effectivePromptOrder`. Trước đó, cách thêm `QICLAW.md` theo từng package làm phát sinh trùng lặp: mỗi builtin agent phải có một bản sao riêng, và về lâu dài project/user packages cũng có thể gặp cùng vấn đề.

Mục tiêu của thay đổi này là chuyển `QICLAW.md` thành một prompt file dùng chung cho toàn hệ thống. Chỉ tồn tại một file nguồn duy nhất tại `src/agent/shared/QICLAW.md`, nhưng mọi agent spec vẫn nhìn thấy nó như một prompt file thật trong quá trình resolve và render. Khi file này tồn tại, nó phải luôn đứng đầu system prompt.

## Goals
- Chỉ có một file dùng chung `src/agent/shared/QICLAW.md`.
- Mọi agent package (builtin, project, user) đều tự động được áp dụng file này.
- `QICLAW.md` xuất hiện trong `effectivePromptFiles` như một prompt file thật, không phải text append đặc biệt ở render-time.
- `QICLAW.md` luôn đứng đầu `effectivePromptOrder` khi hiện diện.
- Không yêu cầu mỗi agent package khai báo hoặc copy `QICLAW.md` riêng.

## Non-Goals
- Không thay đổi semantics merge/override của các prompt file khác.
- Không biến `QICLAW.md` thành file có thể override theo từng package.
- Không thay đổi `renderAgentSystemPrompt()` ngoài việc nó tiếp tục render theo state đã resolve.
- Không thêm cấu hình mới vào `agent.json`.

## Recommended Approach
Dùng một shared prompt file ở cấp source tree và merge nó vào resolved prompt state tại bước resolver, không xử lý ở bước render cuối.

Lý do:
- Giữ cho `effectivePromptFiles` và `effectivePromptOrder` phản ánh đúng trạng thái thật của prompt assembly.
- Tránh logic đặc biệt trong `specPrompt.ts`.
- Tránh nhân bản file `QICLAW.md` giữa các agent package.
- Giữ validator/test có thể kiểm chứng invariant một cách rõ ràng.

## Architecture
### 1. Shared file location
Tạo một nguồn chân lý duy nhất tại:
- `src/agent/shared/QICLAW.md`

Đây là file Markdown dùng chung cho toàn bộ agent spec. Nội dung của file này sẽ được nạp trực tiếp từ filesystem giống các prompt file khác, nhưng không thuộc về một preset package cụ thể.

### 2. Shared file path resolution
Mở rộng module path helper để cung cấp đường dẫn tuyệt đối tới shared prompt file:
- `src/agent/packagePaths.ts`

Helper mới chỉ chịu trách nhiệm trả về path tới `src/agent/shared/QICLAW.md` trong source tree hiện tại. Resolver/registry sẽ dùng helper này để đọc file chung.

### 3. Builtin resolution flow
Trong flow builtin:
- `src/agent/specRegistry.ts`

Sau khi load package hiện tại và chain cha, hệ thống sẽ merge thêm shared `QICLAW.md` vào `effectivePromptFiles` nếu file tồn tại. Sau đó logic resolve order sẽ tiếp tục chạy như hiện nay, với rule bổ sung: nếu `QICLAW.md` có trong `effectivePromptFiles`, đưa nó lên đầu `effectivePromptOrder`.

Điểm quan trọng:
- builtin manifest không còn cần liệt kê `QICLAW.md`
- builtin package directory không còn cần chứa `QICLAW.md`
- `effectivePromptFiles['QICLAW.md']` vẫn tồn tại thật và có `filePath` trỏ về shared file

### 4. Project/User/Builtin chain resolution flow
Trong flow package chain:
- `src/agent/packageResolver.ts`

Sau khi merge prompt files từ package chain theo semantics hiện tại, resolver sẽ merge thêm shared `QICLAW.md` vào `effectivePromptFiles` nếu file tồn tại. Sau đó order resolver sẽ áp cùng invariant: nếu `QICLAW.md` hiện diện thì đứng đầu danh sách.

Điểm quan trọng:
- shared file được áp dụng nhất quán cho project, user, và builtin packages
- không cần khai báo `QICLAW.md` trong manifest để file này được áp dụng
- thứ tự của các prompt file còn lại giữ nguyên semantics cũ sau `QICLAW.md`

### 5. Validation invariant
Giữ invariant ở mức resolved package trong:
- `src/agent/packageValidator.ts`

Rule:
- nếu `effectivePromptFiles` có `QICLAW.md`
- thì `effectivePromptOrder[0]` phải là `QICLAW.md`

Validator này khóa regression nếu sau này có nơi khác thay đổi logic resolve order nhưng quên ưu tiên shared file.

### 6. Render behavior
Không thay đổi vai trò của:
- `src/agent/specPrompt.ts`

Module này tiếp tục render hoàn toàn theo `effectivePromptOrder`. Vì shared file đã được merge ở bước resolver, render layer không cần biết đây là file dùng chung hay file theo package.

## Data Flow
1. Xác định package cần resolve.
2. Load manifest và prompt files từ package directory như hiện nay.
3. Resolve inheritance chain như hiện nay.
4. Nạp shared file `src/agent/shared/QICLAW.md` nếu file tồn tại.
5. Merge shared file vào `effectivePromptFiles`.
6. Tính `effectivePromptOrder` theo manifest/inheritance hiện tại.
7. Nếu `QICLAW.md` hiện diện, move nó lên đầu order.
8. Validate invariant.
9. Render prompt theo `effectivePromptOrder`.

## File Changes
### Create
- `src/agent/shared/QICLAW.md`

### Modify
- `src/agent/packagePaths.ts`
- `src/agent/specRegistry.ts`
- `src/agent/packageResolver.ts`
- `src/agent/packageValidator.ts`
- `scripts/copy-agent-assets.mjs`
- `tests/agent/specRegistry.test.ts`
- `tests/agent/packageResolver.test.ts`
- `tests/agent/specPrompt.test.ts`

### Remove or stop using
- `src/agent/builtin-packages/default/QICLAW.md`
- `src/agent/builtin-packages/readonly/QICLAW.md`
- `QICLAW.md` entry trong builtin `agent.json` nếu đã được thêm trước đó

## Testing Strategy
### Builtin resolution tests
Trong `tests/agent/specRegistry.test.ts`:
- xác nhận builtin package resolve ra `effectivePromptOrder` bắt đầu bằng `QICLAW.md`
- xác nhận `effectivePromptFiles['QICLAW.md']` trỏ về shared file, không phải package-local file
- xác nhận builtin manifest không cần liệt kê `QICLAW.md` để shared file vẫn được áp dụng

### Package chain tests
Trong `tests/agent/packageResolver.test.ts`:
- xác nhận project/user/builtin chain đều có `QICLAW.md` ở đầu nếu shared file tồn tại
- xác nhận thứ tự các prompt file khác vẫn giữ nguyên sau `QICLAW.md`
- xác nhận validator fail nếu `QICLAW.md` tồn tại nhưng không đứng đầu

### Render tests
Trong `tests/agent/specPrompt.test.ts`:
- xác nhận output render bắt đầu bằng nội dung của `QICLAW.md`
- xác nhận runtime constraints vẫn được append sau các prompt sections như cũ

### Asset copy/build tests
Thông qua build flow:
- `scripts/copy-agent-assets.mjs` cần copy thêm `src/agent/shared` sang `dist/agent/shared`
- build phải giữ được shared file cho runtime từ dist

## Error Handling
- Nếu shared file không tồn tại, hệ thống hoạt động như trước và không inject `QICLAW.md`.
- Nếu shared file tồn tại nhưng không đọc được, resolver nên surfacing lỗi I/O thay vì âm thầm bỏ qua, giống cách xử lý prompt file hiện có.
- Nếu shared file đã được merge mà order không bắt đầu bằng `QICLAW.md`, validator phải báo lỗi rõ ràng.

## Trade-offs Considered
### A. Inject ở render-time
Ưu điểm: ít sửa hơn.
Nhược điểm: `effectivePromptFiles` và `effectivePromptOrder` không phản ánh đúng prompt thực tế; validator/test khó nhất quán.

### B. Fallback từ mỗi package sang shared file
Ưu điểm: gần với mô hình package-local hiện tại.
Nhược điểm: semantics phức tạp hơn, vẫn giữ tư duy package-owned cho một file vốn là global.

### C. Shared file merged tại resolver
Ưu điểm: state nhất quán, ít lặp, dễ test, đúng với yêu cầu “một file dùng chung”.
Nhược điểm: cần chạm vào cả resolver path và asset copy.

Đây là phương án được chọn.

## Success Criteria
- Chỉ còn một file `src/agent/shared/QICLAW.md` là nguồn nội dung duy nhất.
- Mọi agent spec resolve được `QICLAW.md` mà không cần khai báo riêng trong từng package.
- `QICLAW.md` luôn đứng đầu system prompt khi tồn tại.
- Build vẫn đóng gói đầy đủ asset cần thiết.
- Test cho builtin flow, package chain flow, validator, và render đều pass.
