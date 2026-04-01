# QiClaw Technical Handover: Single-Agent CLI Runtime

> Tài liệu này mô tả **trạng thái code hiện tại của repo**, không mô tả một kiến trúc lý tưởng hay roadmap tương lai.
>
> Quy ước dùng xuyên tài liệu:
> - **Confirmed**: xác nhận trực tiếp từ source code hoặc test đã đọc.
> - **Inferred**: suy luận hợp lý từ cấu trúc hiện tại hoặc từ bộ `docs/learning/task-01..08`, nhưng chưa thấy được wire end-to-end trong default runtime path.
> - **Needs verification**: chưa đủ bằng chứng để khẳng định mạnh; cần đọc thêm file hoặc chạy verify.

---

## 1. Project Overview

### Project này làm gì?

QiClaw hiện là một **single-agent CLI runtime tối giản** viết bằng TypeScript. Nó cung cấp một vòng lặp cơ bản để:

1. nhận input từ người dùng qua CLI hoặc REPL,
2. xây prompt từ context hiện có,
3. gọi một `ModelProvider`,
4. thực thi các `tool call` mà provider yêu cầu,
5. đưa kết quả tool quay lại transcript,
6. lặp cho tới khi provider dừng hoặc chạm giới hạn số vòng tool,
7. verify xem turn đó có thực sự “xong” hay chưa.

### Bài toán mà project giải quyết

Ở mức thực tế hiện tại, project đang giải quyết bài toán:

- dựng một **agent runtime nhỏ nhưng có cấu trúc tốt**,
- tách rõ các lớp như CLI, provider, tools, verification, telemetry,
- cho phép mở rộng dần lên thành một hệ thống agent mạnh hơn,
- nhưng vẫn giữ được tính deterministic, dễ test, và dễ hiểu cho người mới.

Nó chưa phải một product agent hoàn chỉnh. Nó giống một **bộ khung runtime có kỷ luật** hơn là một trợ lý AI đầy đủ tính năng.

### Ai là người dùng hoặc tác nhân chính?

Có hai lớp “người dùng” cần phân biệt:

| Tác nhân | Vai trò |
|---|---|
| Người dùng CLI | Chạy `npm run dev` hoặc `npm run dev -- --prompt "..."` để nói chuyện với runtime |
| Nhà phát triển repo | Đọc, sửa, mở rộng các lớp như provider, tool, memory, telemetry, session |

### Input / output chính của hệ thống

#### Input chính
- Chuỗi nhập từ người dùng qua CLI.
- Danh sách tool runtime cho phép dùng trong turn.
- `baseSystemPrompt`.
- Context text tùy chọn như `memoryText`, `skillsText`, `historySummary`.
- Transcript lịch sử của turn hiện tại hoặc lịch sử được truyền vào.

#### Output chính
- `finalAnswer`: câu trả lời cuối cùng của assistant.
- `history`: transcript đầy đủ của turn, gồm `user`, `assistant`, `tool` messages.
- `verification`: kết quả verify có đạt hay không.
- `stopReason`: vì sao loop dừng (`completed` hoặc `max_tool_rounds_reached`).

### Ví dụ flow thực tế ngắn gọn

Ví dụ người dùng chạy:

```bash
npm run dev -- --prompt "Read note.txt and summarize it"
```

Flow mức cao:

1. CLI parse `--prompt` trong [src/cli/main.ts](../../src/cli/main.ts).
2. CLI tạo runtime mặc định bằng [src/agent/runtime.ts](../../src/agent/runtime.ts).
3. CLI gọi REPL one-shot qua [src/cli/repl.ts](../../src/cli/repl.ts).
4. REPL gọi `runAgentTurn(...)` trong [src/agent/loop.ts](../../src/agent/loop.ts).
5. Provider có thể yêu cầu `read_file`.
6. Runtime thực thi tool, thêm kết quả vào transcript.
7. Provider trả câu trả lời cuối.
8. Verifier kiểm tra turn có đủ điều kiện hoàn tất không.
9. CLI in `finalAnswer` ra stdout.

### Mức độ chắc chắn

**Confirmed**
- Entry path mặc định là [src/cli/main.ts](../../src/cli/main.ts) -> [src/cli/repl.ts](../../src/cli/repl.ts) -> [src/agent/runtime.ts](../../src/agent/runtime.ts) -> [src/agent/loop.ts](../../src/agent/loop.ts).
- `runAgentTurn(...)` trả `stopReason`, `finalAnswer`, `history`, `toolRoundsUsed`, `doneCriteria`, `verification` tại [src/agent/loop.ts](../../src/agent/loop.ts#L32-L39).
- Test đã khóa nhiều hành vi cốt lõi ở [tests/agent/loop.test.ts](../../tests/agent/loop.test.ts).

**Inferred**
- Repo được xây theo hướng “incremental agent runtime” hơn là end-user product hoàn chỉnh.

**Needs verification**
- Chưa có bằng chứng về bất kỳ production deployment path nào ngoài CLI local runtime.

---

## 2. Big Picture Architecture

### Bức tranh tổng thể

QiClaw chia kiến trúc thành các lớp khá rõ. Đây là điểm mạnh lớn nhất của repo này đối với người mới học agent.

```text
[User Terminal]
   |
   v
[CLI Entrypoint: src/cli/main.ts]
   |
   v
[REPL / One-shot Runner: src/cli/repl.ts]
   |
   v
[Runtime Composition: src/agent/runtime.ts]
   |        |            \
   |        |             \
   |        |              -> [Telemetry Observer]
   |        -> [Builtin Tool Registry]
   -> [Model Provider]
                |
                v
        [Agent Loop: src/agent/loop.ts]
           |        |          |
           |        |          -> [Verifier / Done Criteria]
           |        -> [Prompt Builder]
           -> [Tool Dispatch]
                    |
                    v
             [read_file | edit_file | search | shell]

Supporting subsystems (exist in repo but not fully wired by default):
- Context budget / history compaction
- Memory store / recall renderer
- Skill loader / registry / renderer
- Session checkpoint store
- SQLite task queue
- JSONL telemetry logger
```

### Các khối chính của hệ thống

| Khối | File chính | Trách nhiệm |
|---|---|---|
| CLI entrypoint | [src/cli/main.ts](../../src/cli/main.ts) | Parse args, tạo runtime, chọn prompt mode hoặc interactive mode |
| REPL | [src/cli/repl.ts](../../src/cli/repl.ts) | Chạy one-shot hoặc vòng lặp interactive |
| Runtime composition | [src/agent/runtime.ts](../../src/agent/runtime.ts) | Ghép provider, tool list, cwd, observer |
| Agent loop | [src/agent/loop.ts](../../src/agent/loop.ts) | Orchestrate toàn bộ một agent turn |
| Provider contract | [src/provider/model.ts](../../src/provider/model.ts) | Chuẩn hóa request/response với model |
| Provider implementation | [src/provider/anthropic.ts](../../src/provider/anthropic.ts) | Provider stub mặc định |
| Tool layer | [src/tools/](../../src/tools/) | Định nghĩa contract và built-in tools |
| Verification | [src/agent/doneCriteria.ts](../../src/agent/doneCriteria.ts), [src/agent/verifier.ts](../../src/agent/verifier.ts) | Quyết định “xong” nghĩa là gì |
| Context shaping | [src/context/](../../src/context/) | Budget, prune, compact, prompt assembly |
| Durable primitives | [src/session/](../../src/session/), [src/memory/](../../src/memory/) | Queue, checkpoint, memory persistence |
| Skills | [src/skills/](../../src/skills/) | Load/render skill markdown |
| Telemetry | [src/telemetry/](../../src/telemetry/) | Observer, metrics, JSONL logger |

### Cách các khối giao tiếp với nhau

Về bản chất, có 3 giao diện quan trọng nhất:

1. **`Message`** trong [src/core/types.ts](../../src/core/types.ts#L1-L7)
   - Là định dạng transcript chung cho `system`, `user`, `assistant`, `tool`.

2. **`ModelProvider`** trong [src/provider/model.ts](../../src/provider/model.ts#L28-L32)
   - Là giao diện giữa runtime và model provider.

3. **`Tool`** trong [src/tools/tool.ts](../../src/tools/tool.ts#L18-L23)
   - Là giao diện giữa runtime và built-in/custom tools.

### Vì sao kiến trúc được chia như vậy?

Thiết kế này giải quyết một vấn đề rất hay gặp khi làm agent runtime: nếu bạn trộn tất cả vào một file “chat loop”, hệ thống sẽ rất nhanh trở nên khó hiểu.

QiClaw tách lớp để:

- CLI không phải biết logic tool dispatch.
- REPL không phải biết provider hoạt động thế nào.
- Provider không phải biết shell/read file/edit file.
- Tool không phải biết verification.
- Verification không phải biết REPL.

Nói cách khác, repo này đang cố giữ nguyên tắc: **mỗi lớp chỉ nên biết phần tối thiểu cần biết**.

### Mức độ chắc chắn

**Confirmed**
- Runtime composition nằm ở [src/agent/runtime.ts](../../src/agent/runtime.ts#L19-L25).
- Loop orchestration nằm ở [src/agent/loop.ts](../../src/agent/loop.ts#L41-L132).
- Prompt assembly nằm ở [src/context/promptBuilder.ts](../../src/context/promptBuilder.ts#L16-L24).

**Inferred**
- Kiến trúc này được chọn để tối ưu testability và mở rộng từng bước.
- `docs/learning/task-01..08` củng cố mạnh giả thuyết này.

**Needs verification**
- Chưa có bằng chứng rằng mọi supporting subsystem đã được wire vào default runtime path.

---

## 3. Core Concepts

Phần này cực kỳ quan trọng cho người mới, vì nếu hiểu sai khái niệm, bạn sẽ đọc code sai ngay từ đầu.

### 3.1 Agent turn

**Định nghĩa dễ hiểu**
- Một `agent turn` là một lần runtime nhận một yêu cầu từ user và cố hoàn thành nó, có thể bao gồm nhiều vòng gọi model và tool.

**Vai trò trong project này**
- Đây là đơn vị xử lý trung tâm của toàn hệ thống.
- Thay vì nghĩ “chat session”, trước hết hãy nghĩ “một turn độc lập”.

**Ví dụ trong code**
- Hàm `runAgentTurn(...)` ở [src/agent/loop.ts](../../src/agent/loop.ts#L41-L132).

**Lỗi hiểu sai phổ biến**
- Sai: “Một lần user nhập trong REPL là cả session stateful.”
- Đúng hơn: trong default runtime path hiện tại, mỗi lần nhập là một turn gần như độc lập, trừ khi caller tự truyền `history` vào.

### 3.2 Message / transcript

**Định nghĩa dễ hiểu**
- Transcript là danh sách các message mà runtime coi là “lịch sử sự thật” của một turn.

**Vai trò trong project này**
- Transcript vừa là input cho provider, vừa là dữ liệu cho verifier.
- Tool output cũng được đưa vào transcript như message role `tool`.

**Ví dụ trong code**
- `Message` ở [src/core/types.ts](../../src/core/types.ts#L1-L7).
- `history` được khởi tạo và cập nhật ở [src/agent/loop.ts](../../src/agent/loop.ts#L43-L47) và [src/agent/loop.ts](../../src/agent/loop.ts#L87-L110).

**Hiểu sai phổ biến**
- Sai: tool result là dữ liệu phụ nằm ngoài transcript.
- Đúng: trong QiClaw, tool result là một phần của transcript.

### 3.3 Tool

**Định nghĩa dễ hiểu**
- Tool là một capability mà agent có thể gọi để tương tác với workspace hoặc hệ thống.

**Vai trò trong project này**
- Tool là cầu nối giữa model reasoning và thế giới bên ngoài.

**Ví dụ trong code**
- Contract `Tool<TInput>` ở [src/tools/tool.ts](../../src/tools/tool.ts#L18-L23).
- Built-ins: `read_file`, `edit_file`, `search`, `shell` ở [src/tools/registry.ts](../../src/tools/registry.ts#L7-L27).

**Hiểu sai phổ biến**
- Sai: model tự gọi file system.
- Đúng: model chỉ phát ra `toolCalls`; runtime mới là nơi thực thi tool thật.

### 3.4 Provider

**Định nghĩa dễ hiểu**
- Provider là adapter nói chuyện với model backend.

**Vai trò trong project này**
- Cho runtime một giao diện chung `generate(request) -> response`.

**Ví dụ trong code**
- `ModelProvider` ở [src/provider/model.ts](../../src/provider/model.ts#L28-L32).
- Implementation hiện tại: [src/provider/anthropic.ts](../../src/provider/anthropic.ts).

**Hiểu sai phổ biến**
- Sai: provider hiện đã gọi API thật.
- Đúng: provider hiện chỉ là stub, luôn trả message cố định và không phát sinh tool call.

### 3.5 Done criteria

**Định nghĩa dễ hiểu**
- Đây là cách runtime diễn giải “thế nào là hoàn thành yêu cầu”.

**Vai trò trong project này**
- Tách khái niệm “provider dừng” khỏi “task thật sự xong”.

**Ví dụ trong code**
- [src/agent/doneCriteria.ts](../../src/agent/doneCriteria.ts).

**Hiểu sai phổ biến**
- Sai: provider không còn tool call nghĩa là xong.
- Đúng: QiClaw còn chạy verify sau đó.

### 3.6 Verification

**Định nghĩa dễ hiểu**
- Verification là bước kiểm tra hậu kỳ xem output của turn có đủ điều kiện chấp nhận không.

**Vai trò trong project này**
- Bảo vệ runtime khỏi việc kết luận quá sớm.

**Ví dụ trong code**
- [src/agent/verifier.ts](../../src/agent/verifier.ts).

**Hiểu sai phổ biến**
- Sai: verification là model tự phản tư.
- Đúng: verification hiện là rule-based, deterministic, không dùng AI thứ hai.

### 3.7 Context budget / history compaction

**Định nghĩa dễ hiểu**
- Khi history quá dài, runtime có thể giữ phần gần đây và nén phần cũ thành summary.

**Vai trò trong project này**
- Chuẩn bị cho bối cảnh prompt lớn hơn trong tương lai.

**Ví dụ trong code**
- [src/context/budgetManager.ts](../../src/context/budgetManager.ts)
- [src/context/historyPruner.ts](../../src/context/historyPruner.ts)
- [src/context/compactor.ts](../../src/context/compactor.ts)

**Hiểu sai phổ biến**
- Sai: summary này do model tự viết lại.
- Đúng: summary hiện là mechanical, deterministic, không phải semantic summarization bằng AI.

### 3.8 Memory

**Định nghĩa dễ hiểu**
- Memory là dữ liệu repo muốn lưu lâu hơn một turn, để dùng lại sau.

**Vai trò trong project này**
- Là nguồn context phụ có thể render thành text và đưa vào system prompt.

**Ví dụ trong code**
- [src/memory/memoryStore.ts](../../src/memory/memoryStore.ts)
- [src/memory/recall.ts](../../src/memory/recall.ts)

**Hiểu sai phổ biến**
- Sai: runtime mặc định đã recall memory tự động.
- Đúng: memory subsystem tồn tại, nhưng chưa thấy default CLI path tự wire recall vào loop.

### 3.9 Skill

**Định nghĩa dễ hiểu**
- Skill là một file markdown có frontmatter + instruction text, đại diện cho một capability/pattern chỉ dẫn.

**Vai trò trong project này**
- Có thể render thành text để đưa vào prompt.

**Ví dụ trong code**
- [src/skills/loader.ts](../../src/skills/loader.ts)
- [src/skills/registry.ts](../../src/skills/registry.ts)
- [src/skills/renderer.ts](../../src/skills/renderer.ts)

**Hiểu sai phổ biến**
- Sai: skill là code plugin chạy động.
- Đúng: skill hiện là instruction text được load từ markdown.

### 3.10 Telemetry

**Định nghĩa dễ hiểu**
- Telemetry là các event giúp runtime quan sát được chính nó.

**Vai trò trong project này**
- Ghi nhận các mốc: bắt đầu turn, gọi provider, gọi tool, verify xong, stop/fail.

**Ví dụ trong code**
- [src/telemetry/observer.ts](../../src/telemetry/observer.ts)
- [src/telemetry/metrics.ts](../../src/telemetry/metrics.ts)
- [src/telemetry/logger.ts](../../src/telemetry/logger.ts)

**Hiểu sai phổ biến**
- Sai: telemetry là logging business logic lẫn lộn trong code.
- Đúng: QiClaw cố tách telemetry bằng observer interface riêng.

---

## 4. Folder / Module Structure

### Cấu trúc cấp cao

```text
src/
  agent/       # orchestration core cho một agent turn
  cli/         # entrypoint và REPL
  context/     # prompt assembly, budget, compaction
  core/        # type nền chung
  memory/      # memory persistence + rendering
  provider/    # model provider contract + implementation
  session/     # checkpoint store, task queue, session id
  skills/      # skill markdown loading/registry/rendering
  telemetry/   # observer, metrics, logger
  tools/       # tool contract + built-in tools

tests/
  agent/
  cli/
  context/
  memory/
  session/
  skills/
```

### Vì sao từng module tồn tại?

#### `src/cli/`
Tồn tại để tách lớp terminal/argument parsing khỏi agent logic. Nếu không tách lớp này, mọi thay đổi ở REPL sẽ chạm vào loop.

#### `src/agent/`
Đây là trái tim orchestration. Nó không nên chứa logic file I/O cụ thể; nó chỉ điều phối.

#### `src/provider/`
Tồn tại để runtime không phụ thuộc cứng vào một model backend cụ thể.

#### `src/tools/`
Tồn tại để chuẩn hóa các capability ngoài model. Đây là lớp “tay chân” của agent.

#### `src/context/`
Tồn tại vì prompt assembly thường phình rất nhanh. Tách riêng giúp kiểm soát budget, pruning, compaction.

#### `src/memory/`
Tồn tại để lưu “điều nên nhớ lâu hơn một turn”, tách khỏi transcript ngắn hạn.

#### `src/skills/`
Tồn tại để lưu reusable instructions dưới dạng markdown thay vì hardcode khắp nơi.

#### `src/session/`
Tồn tại để chuẩn bị cho runtime có durable state: task queue, checkpoint, session identity.

#### `src/telemetry/`
Tồn tại để observability không bị cài cắm rải rác trong loop.

### Entry point bắt đầu từ đâu?

Bắt đầu từ [src/cli/main.ts](../../src/cli/main.ts#L19-L69), cụ thể là `buildCli(...).run()`.

### Người mới nên đọc theo thứ tự nào?

Thứ tự đọc tốt nhất:

1. [src/cli/main.ts](../../src/cli/main.ts)
2. [src/cli/repl.ts](../../src/cli/repl.ts)
3. [src/agent/runtime.ts](../../src/agent/runtime.ts)
4. [src/agent/loop.ts](../../src/agent/loop.ts)
5. [src/agent/doneCriteria.ts](../../src/agent/doneCriteria.ts)
6. [src/agent/verifier.ts](../../src/agent/verifier.ts)
7. [src/provider/model.ts](../../src/provider/model.ts)
8. [src/provider/anthropic.ts](../../src/provider/anthropic.ts)
9. [src/tools/tool.ts](../../src/tools/tool.ts)
10. [src/tools/registry.ts](../../src/tools/registry.ts)
11. Các built-in tools trong [src/tools/](../../src/tools/)
12. [src/context/](../../src/context/)
13. [src/memory/](../../src/memory/), [src/skills/](../../src/skills/), [src/session/](../../src/session/), [src/telemetry/](../../src/telemetry/)
14. Cuối cùng mới đọc `docs/learning/task-01..08` để hiểu evolution và rationale.

### Mức độ chắc chắn

**Confirmed**
- Scripts và build scope được định nghĩa trong [package.json](../../package.json), [tsconfig.json](../../tsconfig.json), [tsconfig.test.json](../../tsconfig.test.json), [vitest.config.ts](../../vitest.config.ts).

**Inferred**
- Cấu trúc thư mục được tối ưu cho incremental architecture growth.

**Needs verification**
- Chưa có bằng chứng về bất kỳ module động nào ngoài những gì hiện có trong `src/`.

---

## 5. Class and Module Relationship

Đây là phần quan trọng nhất nếu bạn muốn lần được flow trong code.

### Dependency map mức cao

```text
buildCli (main.ts)
  -> createAgentRuntime (runtime.ts)
      -> createAnthropicProvider (provider/anthropic.ts)
      -> getBuiltinTools (tools/registry.ts)
      -> createNoopObserver / injected observer
  -> createRepl (repl.ts)
      -> runAgentTurn (loop.ts)
          -> buildDoneCriteria (doneCriteria.ts)
          -> buildPromptWithContext (context/promptBuilder.ts)
          -> provider.generate(...)
          -> dispatchAllowedToolCall(...)  [loop-local]
              -> tool.execute(...)
              -> toToolResultMessage / toToolErrorMessage
          -> verifyAgentTurn (verifier.ts)
          -> observer.record(...)
```

### Quan hệ giữa các module

| Module | Nó làm gì | Nó phụ thuộc vào ai | Nó giữ state không? |
|---|---|---|---|
| `main.ts` | Entrypoint và wiring | `runtime.ts`, `loop.ts`, `repl.ts`, telemetry metrics | Gần như không |
| `repl.ts` | Orchestrate I/O loop | callback `runTurn` | Không giữ state phiên lâu dài |
| `runtime.ts` | Compose dependency mặc định | provider, tools, observer | Có giữ object references |
| `loop.ts` | Điều phối một turn | prompt builder, provider, tools, verifier, telemetry | Có transcript và counters in-memory |
| `provider/model.ts` | Contract model-tool protocol | `Message`, `Tool` | Không |
| `provider/anthropic.ts` | Stub provider | provider contract | Không |
| `tools/registry.ts` | Static registry | built-in tools | Giữ map module-level |
| built-in tools | Thực thi I/O thật | fs, child_process, path helpers | Không giữ state dài hạn |
| `verifier.ts` | Verify output | `DoneCriteria`, history | Không |
| `memoryStore.ts` | Persistence cho memory | SQLite | State nằm trong DB |
| `taskQueue.ts` | FIFO queue primitive | SQLite | State nằm trong DB |
| `checkpointStore.ts` | Latest checkpoint per session | SQLite | State nằm trong DB |
| `telemetry/metrics.ts` | In-memory counters | telemetry events | Có state in-memory |
| `telemetry/logger.ts` | JSONL logging backend | file writer | State nằm ở file output |

### Interface nào được implement bởi class nào?

- `ModelProvider` được implement bởi provider trả từ `createAnthropicProvider(...)` ở [src/provider/anthropic.ts](../../src/provider/anthropic.ts#L7-L20).
- `TelemetryObserver` được implement bởi:
  - no-op observer ở [src/telemetry/observer.ts](../../src/telemetry/observer.ts#L22-L26)
  - metrics observer ở [src/telemetry/metrics.ts](../../src/telemetry/metrics.ts#L15-L57)
  - JSONL logger ở [src/telemetry/logger.ts](../../src/telemetry/logger.ts#L9-L15)
- `Tool<TInput>` được implement bởi các built-in tool objects trong [src/tools/](../../src/tools/).

### Object nào giữ state?

#### Giữ state in-memory
- `history` trong `runAgentTurn(...)` ở [src/agent/loop.ts](../../src/agent/loop.ts#L43-L47)
- metrics counters trong [src/telemetry/metrics.ts](../../src/telemetry/metrics.ts#L16-L21)

#### Giữ state durable
- `MemoryStore` qua SQLite ở [src/memory/memoryStore.ts](../../src/memory/memoryStore.ts)
- `CheckpointStore` qua SQLite ở [src/session/checkpointStore.ts](../../src/session/checkpointStore.ts)
- `TaskQueue` qua SQLite ở [src/session/taskQueue.ts](../../src/session/taskQueue.ts)

#### Chỉ orchestration, gần như không giữ state nghiệp vụ
- `buildCli(...)`
- `createRepl(...)`
- `createAgentRuntime(...)`
- `verifyAgentTurn(...)`

### Adapter / wrapper là những ai?

- `createAnthropicProvider(...)` là provider adapter.
- `createJsonLineLogger(...)` là adapter từ telemetry event sang writer append-line.
- `createFileJsonLineWriter(...)` là adapter từ append-line abstraction sang file system sync append.

### Nơi dễ phát sinh coupling cao

1. **`src/agent/loop.ts`**
   - Đây là điểm trung tâm. Nếu mở rộng quá nhiều logic vào đây, nó sẽ thành “god module”.

2. **Tool dispatch path**
   - Hiện có cả [src/agent/dispatcher.ts](../../src/agent/dispatcher.ts) và dispatch helper nội bộ trong [src/agent/loop.ts](../../src/agent/loop.ts#L176-L199).
   - Đây là dấu hiệu coupling/duplication cần để ý.

3. **Context integration**
   - `budgetManager`, `historyPruner`, `compactor`, `memory`, `skills` đều có sẵn nhưng chưa thấy coordinator mặc định dùng đầy đủ. Khi wire sau này, nguy cơ đẩy logic vào sai chỗ là khá cao.

### Mức độ chắc chắn

**Confirmed**
- Đường gọi chính được xác nhận bởi source và test tại [tests/agent/loop.test.ts](../../tests/agent/loop.test.ts) và [tests/cli/repl.test.ts](../../tests/cli/repl.test.ts).

**Inferred**
- `src/agent/dispatcher.ts` có thể là artifact của một giai đoạn trước hoặc một API dispatch tách riêng chưa được hợp nhất hoàn toàn vào loop.

**Needs verification**
- Nếu repo tương lai có thêm entrypoint ngoài CLI, quan hệ này có thể thay đổi.

---

## 6. End-to-End Execution Flow

Bây giờ ta đi từng bước một request chạy qua hệ thống như thế nào.

### Flow one-shot

#### Bước 1: User gửi input
- Module phụ trách: [src/cli/main.ts](../../src/cli/main.ts)
- Input: `argv`, ví dụ `['--prompt', 'Read note.txt and summarize it.']`
- Output: object parse `{ prompt, model }`
- Lỗi có thể xảy ra:
  - thiếu value cho `--prompt` hoặc `--model`
  - gặp unknown flag
  - gặp positional arg không hợp lệ
- Bằng chứng test: [tests/cli/repl.test.ts:129-159](../../tests/cli/repl.test.ts#L129-L159)

#### Bước 2: CLI tạo runtime
- Module phụ trách: [src/agent/runtime.ts](../../src/agent/runtime.ts)
- Input: `{ model, cwd, observer }`
- Output: `AgentRuntime { provider, availableTools, cwd, observer }`
- State thay đổi: chưa có state nghiệp vụ, chỉ compose object references

#### Bước 3: CLI tạo REPL wrapper
- Module phụ trách: [src/cli/main.ts](../../src/cli/main.ts#L38-L54)
- `runTurn(userInput)` bên trong sẽ gọi `runAgentTurn(...)`

#### Bước 4: REPL chạy `runOnce(...)`
- Module phụ trách: [src/cli/repl.ts](../../src/cli/repl.ts#L28-L35)
- Input: chuỗi người dùng
- Output: `{ finalAnswer, stopReason }`

#### Bước 5: Agent loop khởi tạo transcript
- Module phụ trách: [src/agent/loop.ts](../../src/agent/loop.ts#L41-L47)
- Input: `history?` cũ + `userInput`
- Output: `history` mới bắt đầu bằng user message cuối
- State thay đổi:
  - `doneCriteria` được build
  - `toolRoundsUsed = 0`
  - `finalAnswer = ''`

#### Bước 6: Loop build prompt
- Module phụ trách: [src/context/promptBuilder.ts](../../src/context/promptBuilder.ts)
- Input:
  - `baseSystemPrompt`
  - `memoryText?`
  - `skillsText?`
  - `historySummary?`
  - `history`
- Output:
  - `systemPrompt`
  - `messages = [system, ...history]`

#### Bước 7: Loop gọi provider
- Module phụ trách: [src/agent/loop.ts](../../src/agent/loop.ts#L68-L78)
- Provider contract: [src/provider/model.ts](../../src/provider/model.ts#L18-L32)
- Output: `ProviderResponse { message, toolCalls }`

#### Bước 8: Append assistant message
- Module phụ trách: [src/agent/loop.ts](../../src/agent/loop.ts#L87-L89)
- State thay đổi:
  - `history.push(response.message)`
  - `finalAnswer = response.message.content`

#### Bước 9A: Nếu không còn toolCalls
- Loop dừng với `stopReason = 'completed'`
- Sau đó chạy verification qua `buildResult(...)`

#### Bước 9B: Nếu có toolCalls
- Kiểm tra max rounds
- Tăng `toolRoundsUsed`
- Duyệt từng tool call tuần tự
- Thực thi qua `dispatchAllowedToolCall(...)` trong [src/agent/loop.ts](../../src/agent/loop.ts#L176-L199)
- Append `tool` message vào history
- Quay lại bước build prompt để gọi provider vòng tiếp theo

#### Bước 10: Verify kết quả cuối
- Module phụ trách: [src/agent/verifier.ts](../../src/agent/verifier.ts)
- Input:
  - `DoneCriteria`
  - `finalAnswer`
  - `history`
  - `turnCompleted`
- Output:
  - `AgentTurnVerification`
- Đây là bước quyết định output có “đáng tin” theo rule hiện tại hay không.

#### Bước 11: CLI in kết quả
- Module phụ trách: [src/cli/main.ts](../../src/cli/main.ts#L56-L63)
- Output: in `finalAnswer` ra stdout hoặc in lỗi ra stderr

### Flow interactive mode

Trong interactive mode, thay vì `runOnce(...)`, REPL lặp:

1. `readLine(promptLabel)`
2. trim input
3. nếu `exit` hoặc `/exit` thì in `Goodbye.` và dừng
4. nếu rỗng thì bỏ qua
5. nếu có nội dung thì gọi `runOnce(trimmed)`

Bằng chứng: [src/cli/repl.ts](../../src/cli/repl.ts#L36-L59) và test [tests/cli/repl.test.ts:51-76](../../tests/cli/repl.test.ts#L51-L76)

### Các failure mode theo flow

| Bước | Failure mode |
|---|---|
| parse args | unknown flag, missing value |
| provider.generate | throw exception -> `turn_failed` telemetry và exception bubble lên |
| tool dispatch | tool không được allow hoặc throw error -> normalize thành `tool` message lỗi |
| verification | có thể `isVerified = false` dù `stopReason = completed` |
| loop | có thể dừng vì `max_tool_rounds_reached` |

### Mức độ chắc chắn

**Confirmed**
- Hành vi này được khóa rất rõ trong [tests/agent/loop.test.ts](../../tests/agent/loop.test.ts).

**Inferred**
- Nếu sau này runtime thêm session persistence mặc định, flow REPL có thể trở nên stateful hơn.

**Needs verification**
- Chưa có bằng chứng về bất kỳ asynchronous background worker nào trong default path.

---

## 7. Deep Dive into Important Components

### 7.1 [src/cli/main.ts](../../src/cli/main.ts)

#### Mục đích
Đây là entrypoint thực tế của app. Nó làm ba việc:
- parse CLI args,
- tạo runtime mặc định,
- chọn prompt mode hoặc interactive mode.

#### Public API chính
- `buildCli(options?: BuildCliOptions): Cli`
- `Cli.run(): Promise<number>`

#### Internal logic đáng chú ý
- `parseArgs(...)` chỉ hỗ trợ hai flags: `--prompt`, `--model` tại [src/cli/main.ts:71-113](../../src/cli/main.ts#L71-L113)
- default model là `claude-sonnet-4-20250514` tại [src/cli/main.ts:73](../../src/cli/main.ts#L73)
- `baseSystemPrompt` hiện hardcode là `'You are a minimal single-agent CLI runtime.'` tại [src/cli/main.ts:44](../../src/cli/main.ts#L44)
- `maxToolRounds` hiện hardcode là `3` tại [src/cli/main.ts:47](../../src/cli/main.ts#L47)

#### Vì sao cài đặt như vậy?
- Vì CLI hiện cố tình tối giản để tập trung vào runtime core thay vì CLI UX.
- Thay vì kéo thư viện parse args, code dùng vòng lặp tay rất nhỏ, dễ test.

#### Edge cases
- `--prompt` hoặc `--model` thiếu value -> exit code `1`
- unknown flag -> exit code `1`
- positional argument -> lỗi

### 7.2 [src/cli/repl.ts](../../src/cli/repl.ts)

#### Mục đích
Tách lớp terminal interaction khỏi agent logic.

#### Vì sao đáng chú ý?
- `runTurn` được inject từ ngoài, nên REPL không biết gì về provider/tool/runtime internals.
- Đây là dependency inversion rất hữu ích cho test.

#### Hành vi quan trọng
- `runOnce(input)` chỉ trả `finalAnswer` và `stopReason`
- `runInteractive()` không giữ conversation history riêng
- `exit` và `/exit` đều hợp lệ
- EOF cũng thoát và in `Goodbye.`

#### Điểm người mới hay bỏ sót
- REPL hiện **không** tích lũy state nhiều lượt một cách mặc định. Nó gọi `runOnce(trimmed)` mỗi vòng.

### 7.3 [src/agent/runtime.ts](../../src/agent/runtime.ts)

#### Mục đích
Là composition root của runtime mặc định.

#### Nó ghép gì?
- `provider = createAnthropicProvider({ model })`
- `availableTools = getBuiltinTools()`
- `cwd`
- `observer`

#### Vì sao tách file này?
Nếu để `main.ts` tự build mọi dependency, file CLI sẽ phình rất nhanh. `runtime.ts` giữ wiring ở một chỗ riêng.

### 7.4 [src/agent/loop.ts](../../src/agent/loop.ts)

#### Đây là component quan trọng nhất
Nếu bạn chỉ có thời gian hiểu một file, hãy hiểu file này trước.

#### Trách nhiệm
- tạo transcript ban đầu
- build done criteria
- build prompt
- gọi provider
- append assistant messages
- dispatch tools tuần tự
- append tool messages
- enforce `maxToolRounds`
- verify kết quả cuối
- emit telemetry

#### Vì sao thiết kế như vậy?
Nó hiện thân cho pattern: **transcript-centric orchestration**.

Thay vì lưu nhiều state cấu trúc riêng, loop giữ state chủ yếu qua:
- `history`
- `finalAnswer`
- `toolRoundsUsed`
- `doneCriteria`

Điều này giúp reasoning flow dễ nhìn hơn rất nhiều.

#### Internal details quan trọng
- provider luôn nhận `availableTools` trong request tại [src/agent/loop.ts:75-78](../../src/agent/loop.ts#L75-L78)
- loop không gọi `src/agent/dispatcher.ts`; nó có helper `dispatchAllowedToolCall(...)` riêng tại [src/agent/loop.ts:176-199](../../src/agent/loop.ts#L176-L199)
- tool not allowed được convert thành `tool` message lỗi, không throw

#### Edge cases
- provider liên tục đòi tool -> stop bằng `max_tool_rounds_reached`
- tool error -> vẫn ghi vào transcript nhưng `isError: true`
- inspection goal mà không có successful tool evidence -> `verification.isVerified = false`

### 7.5 [src/provider/model.ts](../../src/provider/model.ts)

#### Mục đích
Chuẩn hóa protocol giữa runtime và provider.

#### Các type quan trọng
- `ToolCallRequest`
- `ToolResultMessage`
- `ProviderRequest`
- `ProviderResponse`
- `ModelProvider`

#### Tại sao quan trọng?
Nó ép toàn hệ thống phải nói cùng một ngôn ngữ dữ liệu. Đây là lớp contract quan trọng nhất sau `Message`.

### 7.6 [src/provider/anthropic.ts](../../src/provider/anthropic.ts)

#### Mục đích
Cung cấp một implementation tối thiểu của `ModelProvider`.

#### Thực tế hiện tại
- Luôn trả:
  - assistant message: `Anthropic provider stub: no live API call configured.`
  - `toolCalls: []`

#### Tại sao điều này quan trọng?
Nó nói rất rõ rằng repo hiện **chưa có live model backend mặc định**.

### 7.7 Tool layer: [src/tools/tool.ts](../../src/tools/tool.ts) + [src/tools/registry.ts](../../src/tools/registry.ts)

#### `tool.ts`
- định nghĩa `JsonSchema`, `ToolContext`, `ToolResult`, `Tool<TInput>`
- có helper `resolveWorkspacePath(...)` để chặn path đi ra ngoài workspace

#### `registry.ts`
- built-in order hiện là cố định:
  1. `read_file`
  2. `edit_file`
  3. `search`
  4. `shell`
- test khóa order này tại [tests/agent/loop.test.ts:20-48](../../tests/agent/loop.test.ts#L20-L48)

#### Built-in tools chi tiết

##### `read_file`
- đọc file UTF-8 trong workspace
- dùng `resolveWorkspacePath(...)`
- không cho path traversal ra ngoài workspace
- source: [src/tools/readFile.ts](../../src/tools/readFile.ts)

##### `edit_file`
- đọc file hiện tại
- replace **chỉ lần xuất hiện đầu tiên** của `oldText`
- nếu không thấy `oldText` thì throw error
- source: [src/tools/editFile.ts](../../src/tools/editFile.ts)

##### `search`
- duyệt đệ quy workspace
- skip `.git`, `node_modules`, `dist`, `.worktrees`
- dùng literal `content.includes(pattern)`
- trả danh sách file khớp, nối bằng newline
- source: [src/tools/search.ts](../../src/tools/search.ts)

##### `shell`
- chạy chương trình bằng `execFile`
- không spawn qua shell string
- nếu lỗi, gói lại message gồm command, exit code, stdout, stderr
- source: [src/tools/shell.ts](../../src/tools/shell.ts)

### 7.8 [src/agent/doneCriteria.ts](../../src/agent/doneCriteria.ts) và [src/agent/verifier.ts](../../src/agent/verifier.ts)

#### Ý tưởng cốt lõi
- `doneCriteria` trả lời: goal này cần gì?
- `verifier` trả lời: output vừa rồi đã đạt chưa?

#### `doneCriteria`
- split checklist bằng `and`, `then`, `,`
- dùng regex để phát hiện goal kiểu inspection cần tool evidence

#### `verifier`
- kiểm tra 3 điều:
  1. turn có completed không
  2. final answer có non-empty không
  3. có successful tool evidence nếu goal yêu cầu không

#### Điều người mới rất hay hiểu nhầm
`completed` không đồng nghĩa `verified`.

### 7.9 Context subsystem: [src/context/](../../src/context/)

#### Thành phần
- `budgetManager.ts`: chia char budget theo bucket
- `compactor.ts`: tóm tắt old history theo cách deterministic
- `historyPruner.ts`: giữ recent messages, compact older messages nếu vượt budget
- `promptBuilder.ts`: ghép `baseSystemPrompt`, `memoryText`, `skillsText`, `historySummary`

#### Điểm rất quan trọng
Các module này **đã tồn tại và có test**, nhưng default CLI path hiện chỉ thấy `loop.ts` dùng trực tiếp `buildPromptWithContext(...)`. Chưa thấy `main.ts` tự gọi budget allocation, prune, compact, recall memory, hoặc load skills.

### 7.10 Memory subsystem: [src/memory/](../../src/memory/)

#### Memory model
`MemoryKind` hiện có 3 giá trị tại [src/memory/memoryTypes.ts](../../src/memory/memoryTypes.ts#L1-L17):
- `fact`
- `procedure`
- `failure`

#### `MemoryStore`
- backed by SQLite
- có cột `searchable_content`
- normalize query bằng lowercase locale `vi-VN`
- dùng `LIKE ... ESCAPE '\\'`
- order deterministic theo `created_at ASC, id ASC`

#### `renderRecalledMemories(...)`
- render thành text bắt đầu bằng `Memory:`
- mỗi dòng có nhãn `Fact/Procedure/Failure`

#### Điều cần hiểu đúng
Memory subsystem ở đây mới là **persistence + recall + rendering**. Nó chưa phải một memory orchestration layer hoàn chỉnh.

### 7.11 Skills subsystem: [src/skills/](../../src/skills/)

#### `loadSkillsFromDirectory(...)`
- đọc các file `.md`
- sort deterministic theo tên file
- parse frontmatter strict, chỉ nhận các dòng dạng `key: value`
- yêu cầu `name` và `description`

#### `SkillRegistry`
- exact lookup theo tên

#### `renderSkillsForPrompt(...)`
- render thành block text bắt đầu bằng `Skills:`

#### Cái skill abstraction đang che giấu là gì?
Nó che giấu chi tiết file system và parsing markdown, để runtime có thể chỉ nghĩ bằng khái niệm “selected skills -> prompt text”.

### 7.12 Session subsystem: [src/session/](../../src/session/)

#### `CheckpointStore`
- lưu latest checkpoint cho mỗi `session_id`
- `session_id` là primary key
- save lần sau sẽ overwrite record cũ của session đó

#### `TaskQueue`
- enqueue task với status `pending`
- `claimNext()` dùng transaction để chuyển atomically từ `pending` sang `running`
- order FIFO theo `created_at ASC, rowid ASC`

#### `createSessionId()`
- hiện chỉ trả `session_${Date.now()}` tại [src/session/session.ts](../../src/session/session.ts)

#### Điều người mới dễ hiểu sai
Sự tồn tại của session/task/checkpoint primitives **không đồng nghĩa** REPL hiện đã có persistent session workflow đầy đủ.

### 7.13 Telemetry subsystem: [src/telemetry/](../../src/telemetry/)

#### Event types hiện có
Tại [src/telemetry/observer.ts](../../src/telemetry/observer.ts#L1-L37):
- `turn_started`
- `provider_called`
- `provider_responded`
- `tool_call_started`
- `tool_call_completed`
- `verification_completed`
- `turn_completed`
- `turn_stopped`
- `turn_failed`

#### Metrics observer
- đếm số turn started/completed/failed
- đếm số tool call completed
- giữ `lastTurnDurationMs`

#### JSONL logger
- serialize mỗi event thành một dòng JSON
- có writer append file đồng bộ

#### Điều cần lưu ý
Default CLI hiện tạo metrics observer, nhưng chưa thấy tự wire file logger mặc định.

---

## 8. Techniques and Patterns Used

Phần này chỉ gọi tên pattern khi có bằng chứng thực sự trong code.

### 8.1 Composition Root

**Nó là gì?**
- Một chỗ tập trung để ghép các dependency mặc định của hệ thống.

**Xuất hiện ở đâu?**
- [src/agent/runtime.ts](../../src/agent/runtime.ts)

**Vì sao dùng?**
- Để `main.ts` không phải tự build provider, tools, observer từng chỗ.

**Lợi ích**
- Wiring rõ ràng.
- Dễ thay provider/tool list/observer trong test.

**Trade-off**
- Nếu hệ thống lớn hơn, một composition root duy nhất có thể cần thêm config object hoặc factory phức tạp hơn.

### 8.2 Registry Pattern

**Nó là gì?**
- Một object/module quản lý tập hợp capability và cho phép lookup theo tên.

**Xuất hiện ở đâu?**
- [src/tools/registry.ts](../../src/tools/registry.ts)
- [src/skills/registry.ts](../../src/skills/registry.ts)

**Vì sao dùng?**
- Vì provider/tool-call thường nói bằng tên chuỗi.

**Lợi ích**
- Lookup đơn giản.
- Order deterministic.

**Trade-off**
- Registry tĩnh rất tiện cho MVP, nhưng chưa hỗ trợ plugin lifecycle hay dynamic injection phong phú.

### 8.3 Adapter Pattern

**Nó là gì?**
- Bọc một API hoặc backend cụ thể sau một interface chung.

**Xuất hiện ở đâu?**
- `createAnthropicProvider(...)` ở [src/provider/anthropic.ts](../../src/provider/anthropic.ts)
- `createJsonLineLogger(...)` ở [src/telemetry/logger.ts](../../src/telemetry/logger.ts)

**Vì sao dùng?**
- Tách runtime khỏi backend cụ thể.

**Trade-off**
- Adapter quá mỏng thì dễ, nhưng nếu backend thật phức tạp hơn nhiều, contract có thể phải nở ra.

### 8.4 Observer Pattern

**Nó là gì?**
- Runtime phát event, observer nhận event và làm việc riêng mà không làm bẩn business flow.

**Xuất hiện ở đâu?**
- [src/telemetry/observer.ts](../../src/telemetry/observer.ts)
- được dùng trong [src/agent/loop.ts](../../src/agent/loop.ts#L49-L56)

**Vì sao dùng?**
- Telemetry là concern chéo; không nên trộn với logic turn.

**Lợi ích**
- Dễ gắn metrics/logger/no-op.

**Trade-off**
- Nếu event schema thay đổi nhiều, observer downstream cũng phải đổi theo.

### 8.5 Transcript-as-State

**Nó là gì?**
- Thay vì giữ nhiều state machine phức tạp, dùng transcript như state chính của turn.

**Xuất hiện ở đâu?**
- [src/agent/loop.ts](../../src/agent/loop.ts)

**Vì sao dùng?**
- Agent loop rất dễ suy luận khi mọi thứ đều được ghi lại dưới dạng messages.

**Lợi ích**
- Dễ debug.
- Dễ verify.
- Dễ tái tạo state.

**Trade-off**
- Khi transcript quá dài, phải có budget/pruning/compaction.

### 8.6 Deterministic Compaction

**Nó là gì?**
- Tóm tắt history theo quy tắc cơ học, không dựa vào mô hình AI thứ hai.

**Xuất hiện ở đâu?**
- [src/context/compactor.ts](../../src/context/compactor.ts)

**Vì sao dùng?**
- Dễ test, dễ kiểm soát, ít surprise.

**Trade-off**
- Summary không “thông minh” bằng semantic summarization.

### 8.7 SQLite-backed Persistence Primitives

**Nó là gì?**
- Dùng SQLite để lưu durable state tối thiểu.

**Xuất hiện ở đâu?**
- [src/memory/memoryStore.ts](../../src/memory/memoryStore.ts)
- [src/session/checkpointStore.ts](../../src/session/checkpointStore.ts)
- [src/session/taskQueue.ts](../../src/session/taskQueue.ts)

**Vì sao dùng?**
- Nhẹ, local, không cần service ngoài.

**Trade-off**
- Hiện mới là primitives, chưa phải distributed/session orchestration hoàn chỉnh.

---

## 9. Data Model / State / Memory

### 9.1 Dữ liệu in-memory trong một turn

Trong `runAgentTurn(...)`, state chính gồm:

- `history: Message[]`
- `finalAnswer: string`
- `toolRoundsUsed: number`
- `doneCriteria: DoneCriteria`

Đây là state tạm thời. Nó chết khi turn kết thúc, trừ khi caller giữ lại `history` và truyền vào turn sau.

### 9.2 Message model

`Message` tại [src/core/types.ts](../../src/core/types.ts#L1-L7):

```ts
{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}
```

Riêng tool message chuẩn hóa mạnh hơn qua `ToolResultMessage` tại [src/provider/model.ts](../../src/provider/model.ts#L10-L16):
- `name`
- `toolCallId`
- `content`
- `isError`

### 9.3 Memory data

Memory record tại [src/memory/memoryTypes.ts](../../src/memory/memoryTypes.ts#L3-L9):
- `id`
- `kind`
- `content`
- `source`
- `createdAt`

Lưu trong SQLite table `memories` ở [src/memory/memoryStore.ts:22-31](../../src/memory/memoryStore.ts#L22-L31).

### 9.4 Session / checkpoint / task data

#### Checkpoint
- `sessionId`
- `taskId`
- `status`
- `checkpointJson`
- `updatedAt?`

#### Task
- `taskId`
- `goal`
- `payloadJson`
- `status`
- `createdAt?`
- `updatedAt?`

Nguồn: [src/core/types.ts](../../src/core/types.ts#L18-L33)

### 9.5 Dữ liệu nào là tạm thời, dữ liệu nào là bền vững?

| Dữ liệu | Tạm thời hay bền vững? | Lưu ở đâu? |
|---|---|---|
| `history` của turn | Tạm thời | memory của process/caller |
| `finalAnswer` | Tạm thời | memory của process |
| metrics counters | Tạm thời | closure trong metrics observer |
| memories | Bền vững | SQLite |
| checkpoints | Bền vững | SQLite |
| tasks | Bền vững | SQLite |
| skills | Bền vững theo file | markdown files |
| telemetry JSONL | Bền vững nếu dùng logger | file system |

### 9.6 Khi nào đọc/ghi?

- `history` được append sau mỗi assistant/tool output.
- `MemoryStore.save(...)` ghi mỗi khi caller yêu cầu lưu memory.
- `MemoryStore.recall(...)` đọc khi caller muốn recall theo query.
- `CheckpointStore.save(...)` ghi latest checkpoint theo session.
- `TaskQueue.enqueue(...)` thêm task mới; `claimNext()` cập nhật status sang `running`.

### 9.7 Nguy cơ inconsistency ở đâu?

1. **Loop-local dispatch vs external dispatcher**
   - Có hai nơi thể hiện dispatch semantics.
   - Nếu sửa một nơi mà quên nơi kia, behavior có thể lệch.

2. **Subsystem tồn tại nhưng chưa wire mặc định**
   - Người đọc dễ tưởng memory/skills/session đã nằm trên runtime path, trong khi thực tế chưa chắc.

3. **Session id generation đơn giản**
   - `createSessionId()` chỉ dùng timestamp string; đủ cho local MVP, chưa chắc đủ cho môi trường đồng thời cao.

4. **Search tool là literal search**
   - Người mới có thể tưởng đây là retrieval thông minh. Thực tế chỉ là `includes(pattern)`.

---

## 10. Error Handling and Failure Modes

### 10.1 Hệ thống có thể fail ở đâu?

#### Provider fail
- `provider.generate(...)` có thể throw.
- Loop sẽ emit `turn_failed` rồi throw tiếp.
- Bằng chứng: [src/agent/loop.ts:124-130](../../src/agent/loop.ts#L124-L130) và test [tests/agent/loop.test.ts:656-698](../../tests/agent/loop.test.ts#L656-L698)

#### Tool fail
- Tool có thể throw vì:
  - file không tồn tại
  - path ra ngoài workspace
  - shell command fail
  - `oldText` không tìm thấy
- Trong loop, lỗi này được normalize thành `tool` message `isError: true`, không crash cả turn.

#### CLI fail
- parse args sai -> in lỗi ra stderr, exit code `1`

### 10.2 Khi model trả sai thì chuyện gì xảy ra?

Ở repo hiện tại provider mặc định là stub, nên chưa có live-model failure mode phong phú. Nhưng kiến trúc đã cho thấy một số tình huống:

- provider có thể yêu cầu tool không được allow,
- provider có thể không tạo tool evidence đủ cho inspection goal,
- provider có thể tiếp tục đòi tool đến khi chạm max rounds,
- provider có thể throw.

### 10.3 Khi tool fail thì flow xử lý sao?

Có hai tầng khác nhau:

#### Dispatcher module độc lập
Ở [src/agent/dispatcher.ts](../../src/agent/dispatcher.ts), missing tool hoặc tool throw đều bị normalize thành `ToolResultMessage` lỗi.

#### Loop-local dispatch
Ở [src/agent/loop.ts:176-199](../../src/agent/loop.ts#L176-L199), runtime còn enforce allow-list theo `availableTools` của turn trước khi execute.

Điểm rất quan trọng:
- `tool not allowed` và `tool not found` là hai loại lỗi khác nhau, vì chúng đi qua hai path khác nhau.

### 10.4 Khi memory thiếu hoặc ngược nhau thì sao?

**Confirmed**
- `MemoryStore` chỉ hỗ trợ save + recall deterministic, chưa có dedupe, update, delete, hay conflict resolution tự động.

**Inferred**
- Nếu sau này runtime dùng memory mặc định, inconsistency có thể phải xử lý ở tầng orchestration cao hơn, không phải ở `MemoryStore`.

### 10.5 Có retry không?

**Confirmed**
- Không thấy retry policy trong `loop.ts`, provider, hay built-in tools.

### 10.6 Có logging, tracing, monitoring không?

**Confirmed**
- Có telemetry event emission.
- Có in-memory metrics observer.
- Có JSONL logger primitive.

**Needs verification**
- Chưa có bằng chứng về tracing hoặc monitoring integration ngoài local telemetry này.

### 10.7 Các tình huống xấu người mới rất hay bỏ sót

1. `stopReason = completed` nhưng `verification.isVerified = false`
2. successful tool evidence mới được tính; tool error không đủ để satisfy inspection requirement
3. interactive REPL hiện stateless theo mặc định
4. provider mặc định không gọi API thật
5. built-in tools có quyền ghi file (`edit_file`) và chạy process (`shell`)
6. `search` không phải regex search hay semantic retrieval

---

## 11. How to Read This Codebase as a Beginner

Nếu bạn mới học agent, đừng đọc repo theo kiểu “mở cây thư mục rồi click ngẫu nhiên”. Hãy đi theo lộ trình dưới đây.

### Bước 1: Hiểu đường chạy thật trước

Đọc theo thứ tự:

1. [src/cli/main.ts](../../src/cli/main.ts)
2. [src/cli/repl.ts](../../src/cli/repl.ts)
3. [src/agent/runtime.ts](../../src/agent/runtime.ts)
4. [src/agent/loop.ts](../../src/agent/loop.ts)

Mục tiêu ở bước này là trả lời được 4 câu hỏi:
- app bắt đầu từ đâu?
- input đi vào bằng đường nào?
- một turn được điều phối ra sao?
- output đi ra ở đâu?

### Bước 2: Hiểu “xong” nghĩa là gì

Đọc tiếp:
- [src/agent/doneCriteria.ts](../../src/agent/doneCriteria.ts)
- [src/agent/verifier.ts](../../src/agent/verifier.ts)
- [tests/agent/doneCriteria.test.ts](../../tests/agent/doneCriteria.test.ts)

Nếu không đọc phần này, bạn rất dễ hiểu sai agent loop.

### Bước 3: Hiểu protocol giữa model và tools

Đọc:
- [src/provider/model.ts](../../src/provider/model.ts)
- [src/provider/anthropic.ts](../../src/provider/anthropic.ts)
- [src/tools/tool.ts](../../src/tools/tool.ts)
- [src/tools/registry.ts](../../src/tools/registry.ts)
- rồi từng built-in tool trong [src/tools/](../../src/tools/)

Mục tiêu là hiểu:
- provider trả cái gì
- tool nhận gì, trả gì
- ai là người execute thật

### Bước 4: Đọc test song song với source

Repo này có test rất hữu ích cho người mới. Nên đọc:
- [tests/agent/loop.test.ts](../../tests/agent/loop.test.ts)
- [tests/cli/repl.test.ts](../../tests/cli/repl.test.ts)

Test ở đây không chỉ để đảm bảo đúng/sai, mà còn là tài liệu hành vi cực tốt.

### Bước 5: Chỉ sau đó mới đọc các subsystem hỗ trợ

Đọc tiếp:
- [src/context/](../../src/context/)
- [src/memory/](../../src/memory/)
- [src/skills/](../../src/skills/)
- [src/session/](../../src/session/)
- [src/telemetry/](../../src/telemetry/)

Mục tiêu là hiểu “repo đã chuẩn bị gì cho tương lai”, nhưng đừng nhầm chúng với default runtime path.

### Chỗ nào nên bỏ qua lúc đầu?

Nếu bạn mới hoàn toàn, tạm thời chưa cần đào quá sâu vào:
- `docs/learning/task-01..08`
- `budgetManager`, `compactor`, `historyPruner`
- `memoryStore`, `taskQueue`, `checkpointStore`

Không phải vì chúng không quan trọng, mà vì nếu đọc quá sớm bạn sẽ lẫn giữa **điều đã chạy mặc định** và **điều đã tồn tại như primitive**.

### Chỗ nào dễ gây ngợp?

- `src/agent/loop.ts`: vì nó là trung tâm của nhiều concern
- `tests/agent/loop.test.ts`: dài, nhưng rất đáng đọc
- các subsystem context/memory/skills/session: vì dễ tưởng đã fully integrated

### Cách map tài liệu này với code thực tế

- Mỗi khi đọc một section, mở file source được link ngay trong section đó.
- Với claim “Confirmed”, hãy tìm đúng line link.
- Với claim “Inferred”, xem mình có đồng ý không sau khi đọc cả source lẫn tests.

---

## 12. How to Extend the System

Phần này không nói “nên làm gì về mặt lý tưởng”, mà nói **nếu muốn mở rộng từ trạng thái repo hiện tại thì nên chạm vào đâu**.

### 12.1 Thêm tool mới

#### Sửa ở đâu?
1. Tạo tool object mới theo contract `Tool<TInput>` trong [src/tools/tool.ts](../../src/tools/tool.ts)
2. Thêm vào built-in registry trong [src/tools/registry.ts](../../src/tools/registry.ts)
3. Thêm test tương ứng, tốt nhất theo pattern trong [tests/agent/loop.test.ts](../../tests/agent/loop.test.ts)

#### Cần chú ý gì?
- Tool input hiện có `inputSchema`, nhưng runtime chưa validate schema ở dispatch path.
- Nếu tool thao tác file/path, nên reuse `resolveWorkspacePath(...)`.
- Nếu tool có side effect mạnh, hãy suy nghĩ kỹ về allow-list và verification semantics.

#### Rủi ro
- Quên thêm vào registry thì provider không bao giờ nhìn thấy tool đó trong `availableTools`.
- Nếu tool throw lỗi mơ hồ, transcript sẽ khó đọc.

### 12.2 Thêm model provider mới

#### Sửa ở đâu?
1. Implement `ModelProvider` ở một file mới trong [src/provider/](../../src/provider/)
2. Thay wiring trong [src/agent/runtime.ts](../../src/agent/runtime.ts)
3. Nếu muốn chọn provider qua CLI, mở rộng [src/cli/main.ts](../../src/cli/main.ts)

#### Cần chú ý gì?
- Provider phải trả đúng `ProviderResponse { message, toolCalls }`.
- Nếu backend mới hỗ trợ streaming, current loop chưa có contract cho streaming.

#### Rủi ro
- Làm provider mạnh hơn contract hiện tại có thể buộc sửa protocol tầng dưới.

### 12.3 Thêm memory backend mới

#### Sửa ở đâu?
- Tách interface store ra trước, vì hiện `MemoryStore` là concrete SQLite implementation.
- Hiện tại repo chưa có abstraction `MemoryBackend` riêng.

#### Cần chú ý gì?
- Đừng chỉ thay storage; phải nghĩ cả recall semantics, ordering, normalization.

#### Rủi ro
- Nếu đổi backend mà đổi luôn ordering behavior, prompt reproducibility có thể lệch.

### 12.4 Thêm agent role mới hoặc planning strategy mới

#### Thực trạng hiện tại
- Repo hiện chưa có planner/executor nhiều lớp theo nghĩa phức tạp.
- “Planning” chủ yếu đang nằm ngoài runtime core, hoặc được suy ra qua `docs/learning` chứ không phải subsystem production-ready.

#### Nếu muốn thêm
- Điểm hợp lý nhất là mở rộng quanh `runAgentTurn(...)` hoặc tạo orchestration layer mới ở trên nó.

#### Cần chú ý
- Đừng đẩy tất cả vào `loop.ts`, nếu không nó sẽ thành god module.

### 12.5 Thay đổi prompt contract

#### Sửa ở đâu?
- [src/context/promptBuilder.ts](../../src/context/promptBuilder.ts)
- có thể kèm [src/context/historyPruner.ts](../../src/context/historyPruner.ts) và [src/context/compactor.ts](../../src/context/compactor.ts)

#### Cần chú ý
- `buildPromptWithContext(...)` hiện là nơi duy nhất assemble final system prompt rõ ràng.
- Nếu thay contract, cần giữ deterministic behavior nếu vẫn muốn test dễ.

### 12.6 Wire memory / skills / context budget vào default runtime

Đây là hướng mở rộng rất tự nhiên, vì primitives đã có sẵn.

#### Có thể phải sửa ở đâu?
- [src/cli/main.ts](../../src/cli/main.ts)
- hoặc [src/agent/runtime.ts](../../src/agent/runtime.ts)
- hoặc tạo một coordinator layer mới trên `runAgentTurn(...)`

#### Cần chú ý gì?
- Phải phân biệt rõ:
  - chọn memory nào để recall
  - chọn skill nào để inject
  - prune/compact history lúc nào
  - budget chia ra sao
- Đây là logic orchestration mới, không nên nhét hết vào `promptBuilder.ts`.

### 12.7 Rủi ro mở rộng lớn nhất

1. biến `loop.ts` thành nơi chứa mọi thứ
2. làm provider contract phình quá nhanh
3. quên giữ deterministic behavior vốn đang là điểm mạnh của repo
4. vô tình mô tả subsystem “exists” như “wired by default” trong code mới

---

## 13. Glossary

| Thuật ngữ | Nghĩa trong QiClaw |
|---|---|
| Agent turn | Một lần runtime xử lý một yêu cầu người dùng, có thể gồm nhiều vòng provider/tool |
| Transcript / History | Danh sách message của turn, là state chính của loop |
| Message | Record có `role`, `content`, và có thể `name` |
| Provider | Adapter nói chuyện với model backend |
| ModelProvider | Interface chuẩn hóa provider |
| Tool | Capability mà runtime có thể execute thay mặt agent |
| Tool call | Yêu cầu từ provider muốn runtime chạy một tool |
| Tool result message | Kết quả tool được chuẩn hóa thành message role `tool` |
| Done criteria | Rule mô tả goal cần gì để được xem là hoàn thành |
| Verification | Bước kiểm tra cuối xem output đã đạt điều kiện chưa |
| Tool evidence | Dấu vết tool thành công trong transcript để chứng minh đã thật sự inspect workspace |
| Context budget | Số ký tự dành cho các phần của prompt |
| History compaction | Tóm tắt history cũ thành summary ngắn |
| Memory | Dữ liệu durable dùng để tái đưa vào prompt |
| Skill | Instruction markdown có frontmatter, có thể render vào prompt |
| Registry | Nơi lookup capability theo tên |
| Composition root | Nơi ghép dependency mặc định của runtime |
| Observer | Interface nhận telemetry events |
| Telemetry | Dòng sự kiện mô tả runtime đang làm gì |
| Checkpoint | Snapshot latest state của một session |
| Task queue | Hàng đợi task FIFO backed by SQLite |
| Allow-list | Danh sách tool được phép chạy trong turn hiện tại |

---

## 14. Final Summary

### Tóm tắt kiến trúc

QiClaw hiện là một **single-agent CLI runtime tối giản nhưng được chia lớp tốt**. Đường chạy chính là:

```text
CLI -> REPL -> Runtime Composition -> Agent Loop -> Provider/Tools -> Verification -> Output
```

Các subsystem hỗ trợ như context shaping, memory, skills, session persistence, telemetry logger đều đã tồn tại, nhưng không phải tất cả đã được wire vào default runtime path.

### Tóm tắt luồng chính

1. CLI nhận input.
2. Runtime ghép provider, tools, cwd, observer.
3. Loop build transcript và prompt.
4. Provider trả assistant message và có thể yêu cầu tool.
5. Runtime thực thi tool và đưa kết quả quay lại transcript.
6. Loop lặp cho đến khi provider dừng hoặc chạm max rounds.
7. Verifier đánh giá xem turn có thật sự hoàn tất không.
8. CLI in `finalAnswer`.

### 5 điều quan trọng nhất người mới phải hiểu

1. **Trung tâm của hệ thống là `runAgentTurn(...)`, không phải REPL.**
   REPL chỉ là lớp nhập/xuất.

2. **Transcript là state chính của turn.**
   Tool output cũng là message, không phải dữ liệu phụ nằm ngoài.

3. **`completed` không đồng nghĩa `verified`.**
   Provider dừng chưa chắc yêu cầu đã được hoàn thành đúng cách.

4. **Repo có nhiều subsystem “đã tồn tại”, nhưng không phải subsystem nào cũng đang nằm trên default runtime path.**
   Đây là chỗ dễ hiểu sai nhất khi đọc code.

5. **Provider mặc định hiện là stub.**
   QiClaw đang là runtime skeleton rất tốt để học kiến trúc agent, nhưng chưa phải live AI assistant hoàn chỉnh.

### Reality check cuối cùng

**Confirmed in default runtime path**
- CLI parsing
- one-shot và interactive REPL
- runtime composition
- transcript-based agent loop
- built-in tool allow-list execution
- done criteria + verification
- telemetry events + metrics observer

**Exists in repo but not clearly wired by default**
- memory recall/injection
- skills selection/injection
- context budget allocation + history pruning pipeline
- session persistence workflow đầy đủ
- JSONL logging mặc định

**Cần cẩn trọng khi mở rộng**
- trùng lặp dispatch semantics giữa [src/agent/dispatcher.ts](../../src/agent/dispatcher.ts) và helper trong [src/agent/loop.ts](../../src/agent/loop.ts#L176-L199)
- nguy cơ biến `loop.ts` thành god module
- nguy cơ hiểu nhầm primitives là full workflow

---

## Appendix: Files worth opening side-by-side

Nếu bạn muốn đọc repo hiệu quả, hãy mở cùng lúc các file sau:

- [src/cli/main.ts](../../src/cli/main.ts)
- [src/cli/repl.ts](../../src/cli/repl.ts)
- [src/agent/runtime.ts](../../src/agent/runtime.ts)
- [src/agent/loop.ts](../../src/agent/loop.ts)
- [tests/agent/loop.test.ts](../../tests/agent/loop.test.ts)
- [tests/cli/repl.test.ts](../../tests/cli/repl.test.ts)

Với bộ 6 file này, bạn sẽ hiểu gần như toàn bộ “spine” của QiClaw trước khi đi sâu vào các subsystem phụ trợ.