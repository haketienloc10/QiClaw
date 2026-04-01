# AgentSpec Master Design Memo

**Index pack:** [README.md](./README.md)  
**Ví dụ điền mẫu:** [2026-04-01-agentspec-fill-in-examples.md](./2026-04-01-agentspec-fill-in-examples.md)

## Goal

Tài liệu này tổng hợp ngắn gọn toàn bộ chuỗi artefact thiết kế `AgentSpec` cho QiClaw thành một memo dễ đọc lại sau này.

Nó không thay thế các artefact chi tiết, mà đóng vai trò:
- bản tóm tắt kiến trúc cấp cao,
- điểm neo để nhớ những gì đã chốt,
- danh sách những gì còn mở hoặc cố ý hoãn,
- chỉ dẫn xem nên đọc artefact nào nếu muốn đào sâu.

---

# 1. Context

QiClaw hiện đã có một lõi single-agent runtime tương đối rõ, với các boundary hiện diện trong code:
- execution loop: `src/agent/loop.ts`
- runtime wiring mỏng: `src/agent/runtime.ts`
- provider-neutral contract: `src/provider/model.ts`
- tool contract: `src/tools/tool.ts`
- context assembly: `src/context/promptBuilder.ts`
- completion/verifier concern: `src/agent/verifier.ts`, `src/agent/doneCriteria.ts`

Mục tiêu của chuỗi khảo sát này là làm rõ `AgentSpec` nên đóng vai trò gì nếu QiClaw tiến hóa thành **reusable core runtime** cho nhiều **specialized workspace agents**.

Constraint xuyên suốt:
- không nhảy vào implementation,
- không khóa sớm vào file structure,
- không chốt TypeScript interface,
- ưu tiên boundary clarity hơn config shape.

---

# 2. Core conclusion

## AgentSpec nên là gì
`AgentSpec` nên là một **first-class runtime contract**.

Nó nên mô tả:
- agent là ai,
- agent được phép gì,
- agent bị ràng buộc bởi gì,
- agent được xem là hoàn tất như thế nào.

## AgentSpec không nên là gì
Nó không nên trở thành:
- execution engine,
- disguised composition root,
- product config bag,
- provider config,
- CLI/session/persistence config,
- observability backend config.

---

# 3. Refined AgentSpec shape v2

## Core blocks
- **Identity**
- **Capabilities**
- **Policies**
- **Completion**

## Optional profiles giữ lại
- **ContextProfile**
- **DiagnosticsProfile** *(thin)*

## Deferred khỏi stable shape
- **ContinuityProfile**

Lý do ngắn gọn:
- `ContextProfile` có semantic value thật và chịu override pressure thật.
- `DiagnosticsProfile` có giá trị ở mức expectation/sensitivity nhưng phải giữ rất mỏng.
- `ContinuityProfile` hiện dễ bị kéo lệch bởi current CLI/session path hơn là do semantic differentiation giữa agents.

---

# 4. Core semantic spine

## Identity
- `Purpose`
- `Behavioral framing`
- `Scope boundary`

## Capabilities
- `Allowed capability classes`
- `Workspace relationship`
- `Capability exclusions`

## Policies
- `Safety stance`
- `Tool-use policy`
- `Escalation policy`
- `Mutation policy`

## Completion
- `Completion mode`
- `Done criteria shape`
- `Evidence requirement`
- `Stop-vs-done distinction`

Đây là bộ field có vẻ đủ mạnh để phân biệt các specialized workspace agents đã thử nghiệm mà chưa kéo AgentSpec thành config bag.

---

# 5. Optional profile spine

## ContextProfile
- `Context participation`
- `Context priority hints`
- `Augmentation intent`
- `Evidence-context relationship`

## DiagnosticsProfile (thin)
- `Diagnostics participation level`
- `Traceability expectation`
- `Redaction sensitivity`

---

# 6. Ownership model

## Spec-owned
Những gì thuộc `AgentSpec`:
- core blocks
- `ContextProfile`
- `DiagnosticsProfile` mỏng

## Runtime-owned
Những gì runtime phải resolve/materialize/enforce:
- concrete providers
- concrete tool implementations
- prompt/context assembly
- verifier execution
- observer plumbing
- context retrieval/compaction/rendering strategies

## Host-owned
Những gì phải để ngoài `AgentSpec`:
- CLI / REPL / service shell
- env/config/bootstrap
- session lifecycle
- persistence backends
- display/logging sinks
- current interactive auto-resume workflow

---

# 7. Những anti-patterns chính cần tránh

## 1. Prompt collapse
Mọi semantics bị nhét vào prompt text.

## 2. Capability collapse
Capabilities bị biến thành danh sách concrete tools.

## 3. Policy collapse
Policies bị biến thành runtime knobs hoặc env/config flags.

## 4. Completion collapse
Completion bị nuốt vào verifier heuristics hoặc bị rút gọn thành “assistant trả lời xong”.

## 5. Host leakage
CLI/session/persistence/presentation tràn vào AgentSpec.

## 6. Continuity overreach
Vì repo hiện có session/checkpoint code nên tưởng mọi agent cần continuity profile.

---

# 8. Quyết định đã chốt vs còn mở

## Đã chốt
- `AgentSpec` là first-class runtime contract.
- `Completion` là block lõi riêng, không được chìm vào prompt.
- `Capabilities` ở mức semantic boundary, không phải concrete dependency list.
- `ContextProfile` được giữ như optional profile thật.
- `DiagnosticsProfile` chỉ nên tồn tại ở mức rất mỏng.
- `ContinuityProfile` bị trì hoãn khỏi stable shape hiện tại.

## Còn mở nhưng chưa nên chốt ngay
- Có cần field riêng cho `change boundary discipline` không?
- Có cần field riêng cho `judgment basis / evaluation basis` không?
- `ContextProfile` có cần tách sâu hơn trong tương lai không?
- `DiagnosticsProfile` có nên tồn tại trong mọi agent hay chỉ một số agent?

## Cố ý hoãn
- TypeScript interface
- field names cụ thể
- serialization/config format
- inheritance/composition rules
- provider/backend selection mechanics
- persistence abstraction
- plugin/discovery mechanism

---

# 9. Validation highlights

Chuỗi validation với các agent giả định cho thấy shape hiện tại đứng vững tương đối tốt với 9 pattern chính:
- Repo Inspection Agent
- Code Review Agent
- Refactor/Edit Agent
- Architecture Analysis Agent
- Planning Agent
- Verification-heavy Agent
- Long-running Task Agent
- Multi-agent Coordination Agent
- Human-in-the-loop Approval Agent

Kết luận nổi bật:
- `Completion` thực sự là một trục phân biệt mạnh.
- `Mutation policy` là field lõi quan trọng hơn tưởng tượng.
- `ContextProfile` thay đổi đáng kể giữa inspect / review / edit / architecture-analysis / planning / verification-heavy / long-running-task / multi-agent-coordination / human-in-the-loop-approval agents.
- `DiagnosticsProfile` có giá trị, nhưng không đủ mạnh để được phép phình.
- `Architecture Analysis Agent` xác nhận rằng shape hiện tại không chỉ dùng được cho inspect/review/edit, mà còn đủ sức mô tả một agent thiên về abstraction-first reasoning mà chưa cần kéo implementation planning vào core shape.
- `Planning Agent` cho thấy completion kiểu plan-construction có semantics đủ khác để cần được coi là first-class completion mode.
- `Verification-heavy Agent` cho thấy evidence threshold và stop-vs-done distinction có thể tăng mạnh mà chưa cần bẻ cong core shape.
- `Long-running Task Agent` cho thấy continuity vẫn nên deferred khỏi stable shape hiện tại, nhưng là vùng pressure thật cần tiếp tục theo dõi vì progress/pause/resume semantics có thể trở thành semantic differentiator về sau.
- `Multi-agent Coordination Agent` cho thấy coordination semantics có thể được mô tả ở mức identity/capability/policy/completion mà chưa cần kéo scheduler topology, transport hay worker orchestration details vào core shape.
- `Human-in-the-loop Approval Agent` cho thấy approval semantics tạo áp lực thật lên escalation, mutation boundary, và completion, nhưng vẫn có thể được giữ trong semantic contract mà không kéo approval UI hay auth plumbing vào AgentSpec.

Các ví dụ hoàn chỉnh được lưu tại:
- [2026-04-01-agentspec-fill-in-examples.md](./2026-04-01-agentspec-fill-in-examples.md)
- quay lại index pack: [README.md](./README.md)

---

# 10. Recommended next design move

Nếu tiếp tục đào sâu sau memo này, có 2 hướng hợp lý:

## Option A — thêm ví dụ pattern
Viết thêm fill-in mẫu cho:
- Multi-agent Coordination Agent (nếu sau này QiClaw mở rộng khỏi single-agent workspace path)
- Human-in-the-loop Approval Agent (nếu approval semantics trở thành differentiator riêng)
- Escalation-heavy Triage Agent (nếu cần stress-test escalation policy như primary differentiator)

## Option B — tiến gần hơn tới schema nhưng vẫn chưa code
Làm một artefact kiểu:
- conceptual-to-schema bridge,
- mô tả mỗi field có thể mang loại nội dung gì,
- nhưng chưa rơi vào TypeScript interface cụ thể.

Nếu ưu tiên tính thực dụng và truyền đạt nội bộ, **Option A** thường hữu ích hơn trước.

---

# 11. Reading guide

Nếu cần đọc lại nhanh:
1. Đọc memo này trước.
2. Nếu cần shape chính thức hơn: xem `Refined AgentSpec shape v2` trong plan/artefacts trước đó.
3. Nếu cần hiểu từng field: xem `Semantic field prompts`.
4. Nếu cần ví dụ cụ thể: xem `docs/superpowers/specs/2026-04-01-agentspec-fill-in-examples.md`.

---

# 12. One-paragraph takeaway

`AgentSpec` của QiClaw nên được hiểu như một **semantic runtime contract** cho specialized workspace agents. Nó cần đủ mạnh để mô tả **identity, capability boundary, behavioral constraints, và completion semantics**, nhưng phải đủ kỷ luật để không biến thành config bag cho CLI, provider, persistence hay observability. Ở giai đoạn hiện tại, shape phù hợp nhất là **4 core blocks** (`Identity`, `Capabilities`, `Policies`, `Completion`) cộng với **1 optional profile mạnh** (`ContextProfile`) và **1 optional profile rất mỏng** (`DiagnosticsProfile`), trong khi `ContinuityProfile` nên được trì hoãn cho tới khi có bằng chứng rõ rằng continuity là semantic differentiator của agent chứ không chỉ là đặc điểm của host/runtime path hiện tại.
