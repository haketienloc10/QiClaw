# AgentSpec Design Pack

Bộ tài liệu này gom các artefact thiết kế liên quan đến `AgentSpec` cho QiClaw.

**Điểm bắt đầu khuyến nghị:** [Master memo](./2026-04-01-agentspec-master-design-memo.md)  
**Ví dụ điền mẫu:** [Fill-in examples](./2026-04-01-agentspec-fill-in-examples.md)

Mục tiêu của pack:
- giữ lại reasoning kiến trúc ở mức framework/runtime,
- tránh mất ngữ cảnh qua nhiều buổi thiết kế,
- tạo shared language trước khi đi vào schema hay implementation.

## Nên đọc theo thứ tự này

### 1. Master memo
Bắt đầu ở đây để nắm toàn cảnh nhanh:
- [2026-04-01-agentspec-master-design-memo.md](./2026-04-01-agentspec-master-design-memo.md)

Nội dung chính:
- `AgentSpec` là gì / không là gì
- `Refined AgentSpec shape v2`
- core semantic spine
- optional profiles
- ownership model
- anti-patterns

### 2. Fill-in examples
Sau đó đọc các ví dụ điền mẫu:
- [2026-04-01-agentspec-fill-in-examples.md](./2026-04-01-agentspec-fill-in-examples.md)

Hiện có 9 pattern chính:
- Repo Inspection Agent
- Code Review Agent
- Refactor/Edit Agent
- Architecture Analysis Agent
- Planning Agent
- Verification-heavy Agent
- Long-running Task Agent
- Multi-agent Coordination Agent
- Human-in-the-loop Approval Agent

Tài liệu này hữu ích để kiểm tra shape hiện tại có đủ expressive power hay không.

## Khi nào nên mở lại từng tài liệu

- Nếu cần nhớ **đã chốt kiến trúc gì**: đọc master memo.
- Nếu cần thiết kế **một specialized agent mới**: bắt đầu từ fill-in examples.
- Nếu cần tranh luận về **shape hay boundary**: đối chiếu master memo trước, rồi dùng examples để stress-test.

## Điều bộ tài liệu này cố ý chưa làm

- không chốt TypeScript interface
- không chốt file/config schema
- không đi vào implementation plan
- không encode provider/CLI/persistence details vào `AgentSpec`

## Current status

Shape khuyến nghị hiện tại:
- Core blocks:
  - Identity
  - Capabilities
  - Policies
  - Completion
- Optional profiles:
  - ContextProfile
  - DiagnosticsProfile *(thin)*
- Deferred:
  - ContinuityProfile
