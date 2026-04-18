# QiClaw Memory Source Content Hash Design

## Goal
Thêm `sourceContentHash` vào mỗi record trong `index.json` để lưu hash của **bytes thực tế** của file markdown tại `markdownPath`. Mục tiêu là cho phép về sau kiểm tra file nguồn có bị sửa đổi trên disk so với lúc index record được ghi hay không.

## Scope
Phạm vi chỉ bao gồm session/global memory indexing path khi ghi markdown artifact và index record. Không thay đổi `hash` hiện có của memory entry, không thay đổi embedding format, không thêm cơ chế verification runtime trong thay đổi này.

## Approaches considered

### 1. Hash bytes thực tế của file markdown sau khi ghi ra disk
Ghi file markdown như hiện tại, sau đó đọc bytes của file tại `markdownPath`, tính hash, rồi lưu vào `sourceContentHash` trong `index.json`.

**Ưu điểm:** phản ánh đúng file vật lý đang tồn tại trên disk; phù hợp trực tiếp với mục tiêu phát hiện chỉnh sửa file ngoài hệ thống.
**Nhược điểm:** thêm một lần đọc file sau khi ghi.

### 2. Hash chuỗi markdown trước khi ghi file
Render markdown string trong memory, hash string đó, rồi ghi file và lưu hash vào index.

**Ưu điểm:** ít I/O hơn.
**Nhược điểm:** không xác minh bytes thực tế sau khi ghi; khác mục tiêu kiểm tra file trên disk có bị thay đổi hay không.

### 3. Hash record logic thay vì markdown artifact
Hash từ `summaryText` / `essenceText` / `fullText` hoặc entry object.

**Ưu điểm:** đơn giản.
**Nhược điểm:** chỉ kiểm tra logic record, không kiểm tra file markdown nguồn.

## Chosen design
Chọn **Approach 1**.

## Architecture

### Data model change
Mở rộng persisted/index record để có thêm field:
- `sourceContentHash: string`

Field này là hash của bytes thực tế của file markdown tại `markdownPath` ngay sau khi hệ thống ghi file đó thành công.

### Hash source of truth
`markdownPath` tiếp tục là file markdown artifact gắn với record. `sourceContentHash` được tính từ chính file này, không tính từ entry logic và không tính từ rendered string trước khi ghi.

### Write flow
Khi `put(entry)` chạy cho session hoặc global store:
1. render và ghi markdown artifact như hiện tại
2. đọc lại bytes thực tế của file tại `markdownPath`
3. tính `sourceContentHash`
4. ghi index record với cả `markdownPath` và `sourceContentHash`

Thứ tự này bảo đảm hash phản ánh file thật trên disk.

### Backward compatibility
Index cũ chưa có `sourceContentHash` vẫn phải đọc được. Khi đọc record cũ:
- không fail parse chỉ vì thiếu field này
- các thao tác recall hiện tại tiếp tục hoạt động bình thường

`sourceContentHash` chỉ là field mới cho record được ghi từ phiên bản sau thay đổi này.

## Hash format
Dùng cùng primitive hash nội bộ hiện có (`sha256`) để tránh thêm dependency mới. Khác với `hash` của memory entry đang bị cắt 12 ký tự, `sourceContentHash` nên lưu **full digest hex** để dùng cho integrity check ổn định và rõ ràng hơn.

## Testing strategy
TDD theo các nhóm sau:

1. **Session index write**
- sau `put()`, record trong `index.json` có `sourceContentHash`
- giá trị này khớp với hash bytes thực tế của file tại `markdownPath`

2. **Global index write**
- global record cũng có `sourceContentHash`
- giá trị khớp bytes thực tế của file markdown global

3. **Backward compatibility**
- index cũ không có `sourceContentHash` vẫn đọc được
- recall hiện tại không bị vỡ

4. **Regression**
- session/global file store tests hiện có vẫn pass
- embedding stores vẫn hoạt động vì chúng dùng cùng `super.put()` path trước khi ghi embedding index

## Files to change
- `src/memory/fileSessionStore.ts`
- `src/memory/globalMemoryStore.ts`
- `src/memory/sessionMemoryTypes.ts`
- tests liên quan cho session/global file stores

## Non-goals
- Chưa thêm lệnh hoặc maintenance job để verify lại `sourceContentHash`
- Chưa backfill tự động cho index cũ
- Chưa dùng `sourceContentHash` trong ranking, recall, hoặc embedding