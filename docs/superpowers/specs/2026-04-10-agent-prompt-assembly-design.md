# Agent Prompt Assembly Design

## Goal

Đơn giản hóa cấu hình agent để package chỉ cần khai báo danh sách file markdown cần ghép vào system prompt. Runtime không còn parse nội dung markdown thành `AgentSpec` structured object cho các field như `purpose`, `safetyStance`, `toolUsePolicy`.

## Problem

Hiện tại [src/agent/specRegistry.ts](src/agent/specRegistry.ts) đang hardcode các slot như `AGENT.md`, `SOUL.md`, `STYLE.md`, `TOOLS.md`, `USER.md`, sau đó parse từng dòng theo prefix cố định để derive ra `AgentSpec`.

Hệ quả:
- khó mở rộng khi muốn thêm/bớt phần prompt,
- markdown bị ràng buộc vào schema thay vì là nội dung tự do,
- mỗi thay đổi cấu trúc prompt lại kéo theo thay đổi type, validator và parser,
- inheritance prompt hiện thiên về slot override thay vì assembly đơn giản.

## Design Decision

Chuyển agent package sang mô hình **manifest-driven prompt assembly**:
- `agent.json` khai báo thứ tự các file markdown cần nạp,
- runtime resolve chain `extends`,
- parent đóng góp prompt trước,
- child append prompt sau,
- kết quả cuối cùng là **một prompt string hoàn chỉnh**.

Các metadata prompt-level như `purpose`, `behavioralFraming`, `safetyStance`, `toolUsePolicy` sẽ bị bỏ hẳn khỏi runtime model. Chúng chỉ còn tồn tại dưới dạng nội dung markdown nếu package muốn diễn đạt chúng.

## Target Model

### Manifest

`agent.json` tiếp tục giữ các phần runtime-level metadata đang có giá trị thực thi:
- `extends`
- `policy`
- `completion`
- `diagnostics`

Thêm trường mới để điều khiển prompt assembly:
- `promptFiles: string[]`

Ví dụ:

```json
{
  "extends": "default",
  "promptFiles": ["AGENT.md", "STYLE.md", "USER.md"],
  "policy": {
    "allowedCapabilityClasses": ["read", "search"],
    "maxToolRounds": 2,
    "mutationMode": "none"
  }
}
```

### Loaded package

Loaded package không còn map prompt files theo slot cố định. Thay vào đó:
- load mọi file `.md` có mặt trong thư mục package,
- manifest `promptFiles` chỉ định file nào sẽ được dùng và theo thứ tự nào,
- mỗi prompt file được lưu như `{ filePath, content }` theo key là tên file.

### Resolved package

Resolved package cần mang đủ dữ liệu để render prompt cuối:
- `effectivePolicy`
- `effectiveCompletion`
- `effectiveDiagnostics`
- `effectivePromptFiles` theo key filename
- `effectivePromptOrder: string[]`
- `resolvedFiles`

Không còn `AgentSpec` structured prompt model trong resolved path.

## Extends Semantics

Rule merge được chốt như sau:
- parent được resolve trước,
- child được resolve sau,
- thứ tự prompt cuối là `parent promptFiles` rồi tới `child promptFiles`.

Ví dụ:
- parent: `["base.md", "safety.md"]`
- child: `["repo.md", "style.md"]`
- prompt cuối: `base.md`, `safety.md`, `repo.md`, `style.md`

Pha đầu **không hỗ trợ**:
- replace file từ parent,
- insert-before / insert-after,
- dedupe tự động theo filename,
- section aliasing.

Lý do: giữ mental model đơn giản, đúng mục tiêu content-first assembly.

## Validation Rules

### Manifest shape

Validator cần kiểm tra:
- `promptFiles` phải là mảng string nếu có,
- mỗi entry phải là tên file không rỗng,
- base package (không `extends`) phải có `promptFiles` không rỗng,
- child package có thể có `promptFiles` rỗng hoặc không khai báo nếu chỉ muốn override policy/completion/diagnostics.

### File existence

Sau khi load package:
- mọi file được liệt kê trong `promptFiles` phải tồn tại trong package directory,
- file phải là markdown thực tế có thể đọc được.

### Resolved result

Sau khi merge chain:
- prompt order cuối phải không rỗng,
- runtime policy hiện tại vẫn giữ các invariant sẵn có, ví dụ `mutationMode: none` không đi cùng `write` hoặc `execute`.

## Prompt Rendering

`renderAgentSystemPrompt` sẽ đổi từ slot-based render sang order-based render:
- duyệt `effectivePromptOrder`,
- lấy `content` tương ứng từ `effectivePromptFiles`,
- join bằng `\n\n`,
- append runtime constraints summary như hiện tại.

Điểm quan trọng: renderer không biết `AGENT.md` hay `SOUL.md`. Nó chỉ biết thứ tự file và nội dung file.

## Scope of Refactor

### [src/agent/spec.ts](src/agent/spec.ts)

Đổi model type:
- bỏ `agentPromptSlotFileNames` và `AgentPromptSlotFileName`,
- bỏ toàn bộ các interface prompt-structured như `AgentIdentitySpec`, `AgentCapabilitiesSpec`, `AgentPoliciesSpec`, `AgentContextProfile`, `AgentDiagnosticsProfile`, `AgentSpec`,
- thêm type cho manifest-driven prompt list và resolved prompt order.

Giữ lại các runtime metadata type đang còn ý nghĩa thực thi:
- `AgentRuntimePolicy`
- `AgentCompletionMetadata`
- `AgentPackageDiagnosticsManifest`
- `LoadedAgentPackage`
- `ResolvedAgentPackage`

### [src/agent/packageLoader.ts](src/agent/packageLoader.ts)

Đổi loader để:
- load `agent.json`,
- load tất cả file `.md` trong thư mục package,
- lưu vào map theo filename,
- không filter theo danh sách slot cố định.

### [src/agent/packageResolver.ts](src/agent/packageResolver.ts)

Đổi resolver để:
- merge `promptFiles` theo chain extends với rule parent-first append-child,
- tạo `effectivePromptOrder`,
- build `resolvedFiles` từ manifest và toàn bộ markdown file thực sự tham gia vào prompt.

### [src/agent/packageValidator.ts](src/agent/packageValidator.ts)

Đổi validator để:
- validate `manifest.promptFiles`,
- validate file được tham chiếu có tồn tại,
- bỏ yêu cầu base package phải có `AGENT.md` và `USER.md`,
- bỏ mọi assumption về slot names.

### [src/agent/specRegistry.ts](src/agent/specRegistry.ts)

Refactor mạnh:
- bỏ `getBuiltinAgentSpec`,
- bỏ `deriveAgentSpecFromResolvedPackage`,
- bỏ parser đọc prefix lines,
- bỏ path compile từ inline `AgentSpec` sang resolved package nếu path này không còn consumer thực tế,
- giữ vai trò registry ở mức resolve builtin package / list presets nếu còn cần.

### [src/agent/runtime.ts](src/agent/runtime.ts)

Đổi runtime để:
- không còn giữ `agentSpec?: AgentSpec`,
- không gọi `getBuiltinAgentSpec`,
- chỉ làm việc với `ResolvedAgentPackage` và `systemPrompt` đã render.

### [src/agent/specPrompt.ts](src/agent/specPrompt.ts)

Đổi renderer sang filename-order assembly thay cho slot-order assembly.

### [src/agent/packagePreview.ts](src/agent/packagePreview.ts)

Đổi preview để hiển thị:
- danh sách file prompt theo thứ tự thực tế,
- prompt text đã render.

Không còn preview theo `AGENT.md` / `SOUL.md` / `STYLE.md` cố định.

### [src/agent/loop.ts](src/agent/loop.ts)

Rà soát fallback hiện còn đọc từ `agentSpec` cho completion/context profile. Sau refactor, loop chỉ đọc từ `resolvedPackage.effectivePolicy` và `resolvedPackage.effectiveCompletion`.

### Builtin packages

Các package trong [src/agent/builtin-packages/](src/agent/builtin-packages/) cần:
- cập nhật `agent.json` để khai báo `promptFiles`,
- giữ các file markdown hiện có nếu nội dung vẫn phù hợp,
- không còn phụ thuộc việc các file phải mang nghĩa slot cố định.

## Non-Goals

Pha này không làm các việc sau:
- thiết kế DSL mới cho prompt sections,
- hỗ trợ prompt replacement theo key,
- hỗ trợ partial override trong một file markdown,
- giữ backward compatibility với API `AgentSpec` cũ nếu không còn consumer nội bộ,
- tự động migrate package cũ ngoài builtin packages và code hiện tại của repo.

## Migration Strategy

1. Nới type/model sang filename-based prompt files.
2. Cập nhật loader + validator + resolver.
3. Cập nhật renderer + preview.
4. Xóa dependency vào `AgentSpec` trong runtime/loop.
5. Cập nhật builtin packages sang `promptFiles` manifest.
6. Chạy preview/runtime smoke tests để xác nhận prompt assembly đúng thứ tự.

## Testing Strategy

Cần cover tối thiểu các trường hợp sau:
- base package với `promptFiles` hợp lệ render đúng thứ tự,
- child package append prompt sau parent,
- package khai báo file không tồn tại bị báo lỗi rõ ràng,
- base package thiếu `promptFiles` hoặc danh sách rỗng bị reject,
- `renderAgentSystemPrompt` tạo prompt đúng thứ tự file đã resolve,
- preview hiển thị đúng danh sách file tham gia prompt,
- runtime vẫn lọc tools theo `effectivePolicy` như cũ,
- loop vẫn đọc completion/policy từ resolved package sau khi bỏ `agentSpec`.

## Risks

### 1. Còn consumer ẩn của `AgentSpec`

`AgentSpec` hiện vẫn còn được tham chiếu ở [src/agent/runtime.ts](src/agent/runtime.ts) và [src/agent/loop.ts](src/agent/loop.ts). Cần xóa sạch dependency này trước khi bỏ type.

### 2. Prompt duplication qua extends

Với rule append đơn giản, parent và child có thể cùng nhắc lại cùng nội dung. Đây là hành vi chấp nhận được ở pha đầu, vì mục tiêu là đơn giản hóa thay vì tối ưu hóa prompt graph.

### 3. Preview/output thay đổi

Các công cụ đang hiển thị preview theo slot sẽ phải đổi UI/format theo danh sách filename thực tế.

## Final Decision

Thiết kế được chốt:
- agent package dùng `promptFiles: string[]` trong manifest,
- runtime assemble prompt từ markdown files theo thứ tự manifest,
- `extends` merge theo rule parent trước, child append sau,
- bỏ hẳn metadata prompt-level structured extraction và `AgentSpec`-style prompt contract.
