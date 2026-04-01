# Phân tích temm1e và zeroclaw cho mục tiêu single-agent CLI runtime

## Mục tiêu

Tài liệu này tổng hợp phân tích hai repo sau dưới góc nhìn thiết kế một agent runtime tối giản, single-agent, chạy CLI:

- `temm1e-labs/temm1e`
- `openagen/zeroclaw`

Mục tiêu hệ thống cần xây:

- single-agent runtime chạy CLI
- có tool loop chuẩn
- có session + checkpoint + task queue
- có context budget manager
- có done criteria + verification
- có memory tối thiểu: facts, procedures, failures
- có skill registry đơn giản
- có telemetry rõ

---

## Kết luận ngắn

- `temm1e` gần yêu cầu hơn vì có rõ các mảnh runtime loop, session/task persistence, context budget, done criteria, skill registry và telemetry.
- `zeroclaw` cho nhiều pattern kiến trúc sạch hơn: builder/dependency injection, tool dispatcher abstraction, memory abstraction, observer abstraction, history compaction.
- Công thức tốt nhất cho MVP là:

> `temm1e` runtime behavior + `zeroclaw` abstractions + cắt mạnh còn single-agent local CLI.

---

## 1. Phân tích repo temm1e

### 1.1 Những phần đáng học nhất

Các module nên đọc:

- `crates/temm1e-agent/src/runtime.rs`
- `crates/temm1e-agent/src/context.rs`
- `crates/temm1e-agent/src/history_pruning.rs`
- `crates/temm1e-agent/src/budget.rs`
- `crates/temm1e-agent/src/task_queue.rs`
- `crates/temm1e-agent/src/done_criteria.rs`
- `crates/temm1e-core/src/types/session.rs`
- `crates/temm1e-core/src/traits/tool.rs`
- `crates/temm1e-skills/src/lib.rs`
- `crates/temm1e-observable/src/lib.rs`

### 1.2 Runtime loop / tool loop

Điểm mạnh:

- loop theo round rõ ràng
- append history sớm rồi mới classify
- build lại context mỗi round
- parse tool call rồi execute rồi feed tool results trở lại model
- có hard stop conditions như `max_tool_rounds`, timeout, interrupt
- có truncation/compression cho tool output lớn
- có failure tracking để tránh lặp vô hạn

Nên reuse:

- round-based loop
- hard stop conditions
- execute-tools-then-feed-results-back pattern
- truncation tool output
- verification hint trước khi kết thúc

Không nên mang hết vào MVP:

- consciousness
- hive/swarm
- blueprint authoring
- browser/desktop/channel/gateway
- vision plumbing nếu chỉ làm CLI text

### 1.3 Session + checkpoint + task queue

Điểm mạnh:

- `SessionContext` tương đối gọn và rõ
- `task_queue.rs` dùng durable SQLite queue
- có các trạng thái `Pending`, `Running`, `Completed`, `Failed`
- có `checkpoint_data` để resume unfinished work

Nên reuse:

- session object rõ ràng
- durable task/checkpoint store tối giản
- `load_incomplete()` khi startup

### 1.4 Context budget manager

Điểm mạnh:

- rough token estimation thay vì cố tính exact
- priority tiers cho các loại context
- giữ recent window vô điều kiện
- prune theo atomic turn
- chèn summary marker cho phần bị drop
- sanitize content không hợp model

Nên reuse:

- keep-recent-window
- prune by turn
- group tool_use/tool_result
- summary cho dropped history

### 1.5 Done criteria + verification

Đây là phần rất đáng học.

Điểm mạnh:

- `DoneCriteria` đơn giản nhưng hiệu quả
- có heuristic để nhận diện compound task
- có checklist xác minh trước khi kết thúc
- giúp agent bớt declare done quá sớm

Nên reuse gần như nguyên ý tưởng.

### 1.6 Memory

Repo có memory khá mạnh, nhưng với MVP thì hơi nhiều.

Điểm đáng học:

- có local memory backend
- có structured recall
- có tách giữa transcript/session và memory lâu dài

Không nên copy ở V1:

- lambda-memory đầy đủ với decay tiers
- model-emitted `<memory>` protocol
- layered fidelity/hot-warm-cool-faded

### 1.7 Skill registry

Điểm mạnh:

- markdown + YAML frontmatter
- local/global skill directories
- registry rất đơn giản, dễ hiểu

Nên reuse:

- skill là file markdown có metadata
- local workspace registry
- inject dạng compact

### 1.8 Telemetry

Điểm mạnh:

- local metrics collector
- optional OTEL export
- metric categories rõ

MVP nên giữ:

- provider latency
- tool executions/errors
- token usage
- task completions
- turn duration

---

## 2. Phân tích repo zeroclaw

### 2.1 Những phần đáng học nhất

Các module nên đọc:

- `src/agent/agent.rs`
- `src/agent/loop_.rs`
- `src/agent/dispatcher.rs`
- `src/agent/prompt.rs`
- `src/agent/memory_loader.rs`
- `src/runtime/traits.rs`
- `src/tools/mod.rs`
- `src/memory/mod.rs`
- `src/observability/traits.rs`
- `src/skills/mod.rs`

### 2.2 Runtime abstraction

Điểm mạnh:

- `RuntimeAdapter` rất gọn
- capability-driven execution: shell/filesystem/storage/long-running/memory_budget
- giúp tool exposure phụ thuộc môi trường runtime

Nên reuse gần như nguyên ý tưởng.

### 2.3 Agent builder / dependency injection

Điểm mạnh:

- `Agent` gom dependency qua builder
- loop không gắn cứng với provider/tool format cụ thể
- dễ test, dễ thay provider/runtime/tool registry

Nên reuse:

- `AgentBuilder`
- inject provider, tools, memory, observer, prompt builder

### 2.4 Tool dispatcher abstraction

Đây là phần hay nhất của repo cho MVP.

Điểm mạnh:

- tách rõ parsing provider response
- tách formatting tool results
- tách protocol tool calling
- có thể hỗ trợ native tool calling hoặc XML/tool protocol khác

Nên reuse:

- abstraction dispatcher
- structured tool result messages
- bounded loop + max iteration count

### 2.5 History compaction

Điểm mạnh:

- auto compact khi history dài
- replace block cũ bằng 1 compaction summary
- dùng message count + char cap làm guardrail thực dụng

Nên reuse:

- compaction summary thay vì giữ full transcript mãi mãi

### 2.6 Memory abstraction

Điểm mạnh:

- memory trait rõ ràng: store, recall, get, list, forget, count
- nhiều backend nhưng interface ổn
- memory loader inject top-k relevant items vào prompt
- có threshold relevance

Nên reuse:

- trait-based memory
- sqlite backend trước tiên
- optional `session_id`
- bỏ assistant-generated summaries khỏi memory injection

### 2.7 Observer / observability

Điểm mạnh:

- `Observer` trait + noop/log/prometheus/otel/multi
- instrumentation được decouple khỏi agent logic

Nên reuse:

- observer interface
- noop + logger backend ở V1

### 2.8 Skills

Điểm mạnh:

- skill manifest rõ
- load local skills
- có compact/full prompt rendering mode
- có security/audit stance tốt hơn nhiều repo khác

Nên reuse:

- local manifest
- compact prompt mode

Không cần ở V1:

- open-skills sync
- skillforge/meta tooling

### 2.9 Những phần không cần cho MVP

- SOP engine
- cron subsystem
- multi-backend memory
- tool surface quá rộng
- browser/composio/hardware/delegate

---

## 3. Mapping trực tiếp vào yêu cầu hệ thống

### 3.1 Single-agent CLI runtime

Khuyên lấy:

- flow loop của `temm1e`
- trait/builder style của `zeroclaw`

### 3.2 Tool loop chuẩn

MVP nên có:

- max tool iterations
- append tool_result vào history
- truncate output tool lớn
- guard chống loop vô hạn
- final answer khi không còn tool call

### 3.3 Session + checkpoint + task queue

Khuyên lấy từ `temm1e`:

- session object rõ ràng
- task/checkpoint store tối giản
- resume unfinished work

MVP nên giữ:

- `session_id`
- `history`
- `current_task`
- `checkpoint_data`
- `status: pending/running/completed/failed`

### 3.4 Context budget manager

Khuyên kết hợp:

- từ `temm1e`: priority tiers, keep recent window, atomic turns
- từ `zeroclaw`: auto compaction summary

### 3.5 Done criteria + verification

Khuyên lấy từ `temm1e`:

- checklist “done when”
- final verification pass
- chặn kết thúc quá sớm

### 3.6 Memory tối thiểu

Khuyên kết hợp:

- schema đơn giản: `facts`, `procedures`, `failures`
- pattern trait-based memory từ `zeroclaw`
- tránh advanced decay/packing của `temm1e`

### 3.7 Skill registry đơn giản

Khuyên làm:

- chỉ local workspace `skills/`
- file `.md` + frontmatter
- inject dạng compact

### 3.8 Telemetry rõ

Khuyên kết hợp:

- observer abstraction từ `zeroclaw`
- metric set tối thiểu từ `temm1e`

---

## 4. Cái gì nên copy, cái gì nên tránh

### 4.1 Nên copy từ temm1e

- runtime turn loop
- session/task queue shape
- done criteria
- context budgeting + pruning
- simple skill registry
- practical telemetry

### 4.2 Nên copy từ zeroclaw

- `AgentBuilder`
- `ToolDispatcher`
- observer abstraction
- memory loader abstraction
- history compaction summary

### 4.3 Tránh ở V1

Từ `temm1e`:

- consciousness
- hive/swarm
- blueprint system
- MCP/browser/desktop/channel/gateway
- lambda-memory full version

Từ `zeroclaw`:

- SOP engine
- cron subsystem
- nhiều memory backend
- skillforge/open-skills sync
- quá nhiều tools

---

## 5. Blueprint MVP rút ra từ hai repo

### 5.1 Module tree khuyến nghị

```text
src/
  cli/
    main.ts
    repl.ts

  agent/
    runtime.ts
    loop.ts
    dispatcher.ts
    doneCriteria.ts
    verifier.ts

  session/
    session.ts
    checkpointStore.ts
    taskQueue.ts

  context/
    promptBuilder.ts
    budgetManager.ts
    historyPruner.ts
    compactor.ts

  memory/
    memoryStore.ts
    memoryTypes.ts
    recall.ts

  tools/
    tool.ts
    registry.ts
    shell.ts
    readFile.ts
    editFile.ts
    search.ts

  skills/
    registry.ts
    loader.ts
    renderer.ts

  telemetry/
    observer.ts
    logger.ts
    metrics.ts

  provider/
    model.ts
    anthropic.ts
```

### 5.2 Phases học và phát triển

#### Phase 1
- CLI REPL
- 1 provider
- basic tool loop
- 3–4 tools cơ bản
- session history trong file

#### Phase 2
- checkpoint store
- task queue
- context budget manager
- tool output truncation

#### Phase 3
- done criteria
- verification step
- memory `facts/procedures/failures`

#### Phase 4
- skill registry markdown
- compact skill injection
- telemetry/event log

---

## 6. Kết luận cuối

Nếu phải chọn một hướng thiết kế duy nhất:

- lấy `temm1e` làm nguồn cảm hứng chính cho runtime behavior
- lấy `zeroclaw` làm nguồn làm sạch kiến trúc
- giữ phạm vi thật chặt: single-agent, local CLI, local persistence, local skills, local telemetry

Công thức phù hợp nhất:

> `temm1e` runtime behavior + `zeroclaw` abstractions + TypeScript/Node MVP tối giản
