# QiClaw Embedding Memory Store Design

## Goal
Khi `QICLAW_MEMORY_PROVIDER=ollama` được bật, interactive memory recall/capture phải ưu tiên dùng backend embedding; nếu không có config thì dùng lexical store hiện tại. Nếu embedding backend lỗi lúc runtime, hệ thống tự fallback sang lexical và phát ra warning/debug rõ ràng.

## Scope
Phạm vi chỉ bao gồm session/global memory backend selection cho interactive recall, `/recal`, và capture. Không thay đổi policy chọn candidate, không tinh chỉnh ranking, không đổi UI beyond warning/debug cần thiết.

## Approaches considered

### 1. Wire engine selection bằng factory store riêng biệt
Tạo embedding-backed session/global store mới trong `src/memory/`, rồi thêm factory chọn backend theo `memoryConfig`.

**Ưu điểm:** boundary rõ, `sessionMemoryEngine` không biết backend cụ thể, test dễ, fallback tập trung một chỗ.
**Nhược điểm:** thêm vài file mới và interface chung.

### 2. If/else trực tiếp trong `sessionMemoryEngine.ts`
Chọn store class tại từng call site.

**Ưu điểm:** ít file mới hơn.
**Nhược điểm:** lặp logic ở prepare/inspect/capture, khó bảo trì, dễ lệch hành vi fallback.

### 3. Bọc hybrid adapter quanh lexical store
Một wrapper gọi embedding trước rồi lexical sau.

**Ưu điểm:** caller ít đổi.
**Nhược điểm:** abstraction dày hơn cần thiết, khó tách session/global rõ ràng.

## Chosen design
Chọn **Approach 1**.

## Architecture

### Store interface boundary
Thêm interface chung cho session/global memory store operations đang được `sessionMemoryEngine` dùng:
- `open()`
- `readMeta()`
- `writeMeta()` nếu cần cho maintenance path
- `put()`
- `seal()`
- `recall()`
- `recallByHashPrefix()` với session store
- `touchByHashes()`
- `supersedeByHashes()` nếu có
- `invalidateByHashes()` nếu có
- `paths()`

Factory trả về implementation phù hợp:
- không có `memoryConfig` → lexical `FileSessionStore` / `GlobalMemoryStore`
- có `memoryConfig` → embedding-backed store mới

### Embedding-backed stores
Thêm source implementation mới trong `src/memory/` cho:
- session embedding store
- global embedding store

Các store này sẽ:
- giữ cùng shape `SessionMemoryMeta` / checkpoint metadata để phần còn lại không đổi
- dùng Ollama embeddings để index/search
- giữ metadata file tương thích với flow hiện tại
- trả `retrievalScore` từ backend embedding search

### Fallback policy
Nếu `memoryConfig` có mặt nhưng embedding store lỗi ở bất kỳ bước runtime quan trọng nào (`open`, `recall`, `put`, `seal`, `touch`, `supersede`, `invalidate`):
1. ghi warning/debug event rõ ràng rằng embedding backend đã fail
2. tạo lexical store tương ứng
3. tiếp tục thao tác bằng lexical store

Fallback là per-operation session runtime, không fail cứng CLI/TUI.

## Data flow

### Recall path
`prepareInteractiveSessionMemory()` và `inspectInteractiveRecall()` gọi store factory.
- embedding config có → embedding store được chọn
- nếu embedding recall lỗi → fallback lexical cho thao tác đó
- kết quả trả về vẫn là `SessionMemoryCandidate[]`

### Capture path
`captureInteractiveTurnMemory()` ghi vào store đã được chọn từ prepare path nếu có. Nếu capture global memory với embedding backend lỗi, fallback lexical global store và tiếp tục.

## Warning/debug behavior
Khi fallback xảy ra, phát warning/debug có đủ tối thiểu:
- phase: `open`, `recall`, `put`, `seal`, `touch`, `supersede`, `invalidate`
- scope: `session` hoặc `global`
- backend: `embedding`
- fallback: `lexical`
- error message đã format

Warning/debug phải đủ để người dùng biết embedding không thực sự đang được dùng.

## Testing strategy
TDD theo các nhóm sau:

1. **Factory selection**
- có `memoryConfig` chọn embedding store
- không có `memoryConfig` chọn lexical store

2. **Recall behavior**
- embedding store được dùng cho `prepareInteractiveSessionMemory()`
- embedding store được dùng cho `inspectInteractiveRecall()`
- embedding recall lỗi thì lexical fallback vẫn trả candidate hợp lệ

3. **Capture behavior**
- embedding store được dùng cho `captureInteractiveTurnMemory()`
- embedding global persistence lỗi thì fallback lexical global vẫn tiếp tục

4. **Warning/debug**
- fallback phát warning/debug với phase và scope đúng

5. **Regression**
- toàn bộ test hiện có cho slash command, REPL, session memory flow vẫn pass

## Files to add or change

### Add
- `src/memory/embeddingSessionStore.ts`
- `src/memory/embeddingGlobalMemoryStore.ts`
- `src/memory/memoryStoreFactory.ts`
- test files tương ứng cho factory/store mới

### Modify
- `src/memory/sessionMemoryEngine.ts`
- các test memory/cli liên quan

## Non-goals
- Không thay đổi thuật toán merge candidate hiện tại
- Không thêm reranking ngữ nghĩa nhiều tầng
- Không sửa UI `/recal` ngoài warning/debug cần thiết
