# Agent + Memory Test Matrix and Benchmark

## Purpose

This document defines a large, high-signal test suite for the QiClaw agent + memory system. It is both:

1. A test case matrix for implementation in Vitest.
2. A training/evaluation benchmark for scoring agent + memory quality.
3. A failure diagnosis guide for identifying which subsystem needs improvement.

The suite focuses on the easy-to-miss failures in memory recall, ranking, prompt injection, compaction, persistence, cross-session behavior, and checkpoint integrity.

Use this document as the source of truth when adding or reviewing tests for the agent + memory system. Each case should remain independently reproducible, should name the subsystem that failed, and should provide enough signal to distinguish a data-loss bug from a lower-severity ranking or formatting weakness.

## Scoring model

Use a 100-point score:

| Area | Weight |
| --- | ---: |
| A. Memory Core Correctness | 30 |
| B. Recall + Context Correctness | 30 |
| C. Agent Loop + Persistence | 25 |
| D. Diagnosis + Regression Quality | 15 |

A test can pass functionally but still reveal benchmark weakness if ranking, diagnosis, or resilience is poor. When implementing this matrix, treat each row's `Score` value as the case-level contribution inside its area, and normalize by area weight for benchmark reporting.

Scoring principles:

- P0 failures should block release because they represent data loss, privacy leaks, or broken turn-to-turn memory behavior.
- P1 failures should block memory-quality claims unless explicitly waived, because they affect determinism, ranking, or resume correctness.
- P2 failures are lower-risk fidelity and language variants; they should still be tracked because they often reveal recall edge cases.
- Diagnosis quality is scored separately: every failure report should include the failure code, first files to inspect, and a proposed improvement target.

## Coverage map

### A. Memory Core Correctness

What it proves:
- Memory capture stores the right information and rejects noise.
- Importance, decay, fidelity, and hash recall preserve useful memories under budget pressure.
- Session and global stores remain isolated unless global recall is explicitly intended.

Easy-to-miss risks:
- Question-style “remember” phrasing is captured as explicit memory.
- Vietnamese remember phrases are missed.
- Old memory downgrades lose the full content permanently.
- Session-local memory leaks into global memory.

### B. Recall + Context Correctness

What it proves:
- Recall returns the most relevant top-K memories for the query.
- Session and global memory merge without duplicate facts.
- Prompt construction injects memory in the correct position and within budget.

Easy-to-miss risks:
- Global memory overrides a fresher session memory.
- Explicit global memory is deduped away by a weaker session duplicate.
- Empty memory text creates a fake prompt block.
- Memory is placed in the wrong prompt position and changes model behavior.

### C. Agent Loop + Persistence

What it proves:
- A full turn flows through recall, prompt build, provider response, tool result, capture, compaction, and checkpoint persistence.
- Memory survives multiple turns and cross-session global recall.
- Checkpoint history remains complete even when prompt history is pruned.

Easy-to-miss risks:
- Capture runs after checkpoint save and loses the latest turn.
- Pruned prompt history overwrites full checkpoint history.
- Tool failure is stored as a successful procedure.
- Global memory cannot be recalled from another repo/session.

### D. Diagnosis + Regression Quality

What it proves:
- Every important failure can be mapped to a subsystem and improvement target.
- The benchmark distinguishes severe architectural regressions from small ranking imperfections.

Easy-to-miss risks:
- Tests fail without explaining root cause.
- All failures are scored equally, hiding high-impact recall or checkpoint bugs.

## Failure diagnosis taxonomy

| Failure code | Meaning | First files to inspect | Improvement target |
| --- | --- | --- | --- |
| `capture_false_positive` | Stored text that should not become memory | `src/memory/capture.ts`, `tests/memory/sessionMemoryEngine.test.ts` | Tighten capture heuristics |
| `capture_false_negative` | Missed explicit or useful memory | `src/memory/capture.ts`, `src/memory/sessionMemoryEngine.ts` | Expand capture patterns safely |
| `procedure_leak` | Stored procedure from old history or failed tool result | `src/memory/capture.ts` | Restrict procedure capture to current successful turn |
| `recall_ranking_error` | Relevant memory exists but is ranked too low | `src/memory/sessionMemoryEngine.ts`, `src/memory/decay.ts` | Adjust scoring, tie-breaks, or source boosts |
| `dedupe_loss` | Dedupe removed the stronger explicit memory | `src/memory/sessionMemoryEngine.ts` | Preserve explicit/high-score entries during dedupe |
| `budget_overflow` | Prompt memory exceeds budget or downgrades wrong | `src/memory/fidelity.ts`, `src/memory/sessionMemoryEngine.ts` | Fix packing and fidelity thresholds |
| `prompt_placement_regression` | Memory appears in the wrong prompt position | `src/context/promptBuilder.ts`, `tests/context/historyPruner.test.ts` | Keep memory as user message before recent history |
| `empty_memory_injection` | Empty memory creates a fake prompt block | `src/context/promptBuilder.ts` | Skip whitespace-only memory text |
| `history_loss` | Pruning removes data that checkpoint should retain | `src/context/historyPruner.ts`, `src/session/session.ts` | Separate prompt pruning from checkpoint persistence |
| `checkpoint_drift` | Checkpoint misses session/history/memory metadata | `src/session/checkpointStore.ts`, `src/session/session.ts` | Fix checkpoint schema/write order |
| `cross_session_leak` | Session memory appears in unrelated session | `src/memory/sessionPaths.ts`, `src/memory/memvidSessionStore.ts` | Fix path/session namespace isolation |
| `global_recall_miss` | Global memory is not recalled from another session/repo | `src/memory/globalMemoryStore.ts`, `src/memory/sessionMemoryEngine.ts` | Fix global path and merge logic |
| `agent_loop_order_error` | Turn history order is wrong around tool calls/results | `src/agent/loop.ts`, `tests/agent/loop.test.ts` | Fix history append order |

## A. Memory Core Correctness test cases

| ID | Priority | Layer | Given | When | Then | Score | Failure signal | Diagnosis | Mapped test file |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| A01 | P0 | Unit | User says `remember that my favorite editor is neovim` | Capture runs after final answer confirms it | Store receives one explicit fact memory without the command prefix | 3 | No entry saved or prefix retained | `capture_false_negative` | `tests/memory/sessionMemoryEngine.test.ts` |
| A02 | P0 | Unit | User asks `do you remember that I prefer concise answers?` | Capture evaluates the turn | Nothing is persisted | 3 | Store `put` is called | `capture_false_positive` | `tests/memory/sessionMemoryEngine.test.ts` |
| A03 | P0 | Unit | User says `hãy nhớ rằng tôi thích trả lời bằng tiếng Việt` | Capture evaluates the turn | Explicit fact is saved with Vietnamese content and tags | 3 | No entry or mangled Vietnamese content | `capture_false_negative` | `tests/memory/sessionMemoryEngine.test.ts` |
| A04 | P1 | Unit | User says `bạn có nhớ tôi thích câu trả lời ngắn gọn không?` | Capture evaluates the turn | No memory is saved | 2 | Question is persisted | `capture_false_positive` | `tests/memory/sessionMemoryEngine.test.ts` |
| A05 | P0 | Unit | Current turn has successful tool result and final answer | Procedure capture runs | Procedure memory includes tool name and final outcome | 3 | Procedure missing | `capture_false_negative` | `tests/memory/sessionMemoryEngine.test.ts` |
| A06 | P0 | Unit | Current turn has no tool result but old history has one | Procedure capture runs | No procedure memory is saved from old history | 3 | Old tool result becomes memory | `procedure_leak` | `tests/memory/sessionMemoryEngine.test.ts` |
| A07 | P0 | Unit | Current tool result has `isError: true` | Capture runs after final answer | No successful procedure memory is saved | 3 | Failed command stored as procedure | `procedure_leak` | `tests/memory/sessionMemoryEngine.test.ts` |
| A08 | P1 | Unit | Candidate importance `0.6`, created 72 hours ago | `scoreSessionMemoryCandidate` runs | Score is lower than equivalent fresh memory | 2 | Old and fresh score are equal | `recall_ranking_error` | `tests/memory/decay.test.ts` |
| A09 | P1 | Unit | Explicit memory and implicit memory have similar retrieval score | Scoring runs | Explicit memory receives boost | 2 | Explicit memory ranks lower | `recall_ranking_error` | `tests/memory/decay.test.ts` |
| A10 | P1 | Unit | Candidate has high access count | Scoring runs | Access count gives bounded boost | 2 | Access boost absent or unbounded | `recall_ranking_error` | `tests/memory/decay.test.ts` |
| A11 | P0 | Unit | Memory budget can only fit compressed entries | Fidelity assignment runs | Low-score entries degrade to essence/hash first | 3 | Important memory degrades before weak memory | `budget_overflow` | `tests/memory/fidelity.test.ts` |
| A12 | P0 | Integration | Store contains hash-only recalled item | Recall by hash prefix is requested | Full content is returned | 3 | Only summary/hash is returned | `budget_overflow` | `tests/memory/memvidSessionStore.test.ts` |
| A13 | P1 | Integration | Session A and B use different session IDs | Both write similar local memory | Paths and recall results remain isolated | 2 | B recalls A session-local memory | `cross_session_leak` | `tests/memory/sessionPaths.test.ts` |
| A14 | P1 | Integration | Global preference should be promoted | Capture runs with global store available | Entry is persisted in global store only when promotion criteria match | 2 | Entry goes to wrong store | `global_recall_miss` | `tests/cli/sessionMemoryFlow.test.ts` |

## B. Recall + Context Correctness test cases

| ID | Priority | Layer | Given | When | Then | Score | Failure signal | Diagnosis | Mapped test file |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| B01 | P0 | Integration | One explicit global memory and three session memories exist | Query is `tạo blueprint cho task login` | Top-K includes the login-related memories and ranks session memory above non-explicit global memory | 4 | Relevant session memory missing or below weak global memory | `recall_ranking_error` | `tests/memory/sessionMemoryEngine.test.ts` |
| B02 | P0 | Integration | Same fact exists in session and global stores | Recall merges candidates | Output contains one deduped fact, keeping the stronger explicit/high-score version | 4 | Duplicate rendered or explicit fact lost | `dedupe_loss` | `tests/memory/sessionMemoryEngine.test.ts` |
| B03 | P0 | Integration | Short-term history has four turns and relevant memory exists | `buildPromptWithContext` runs | Prompt order is system message, memory user message, then recent history | 4 | Memory appears after history or inside system prompt | `prompt_placement_regression` | `tests/context/historyPruner.test.ts` |
| B04 | P0 | Integration | Memory text is whitespace-only | Prompt is built | No memory user message is added | 3 | Empty `<λ-memory>` or blank user message appears | `empty_memory_injection` | `tests/context/historyPruner.test.ts` |
| B05 | P0 | Integration | Memory context budget is small | Recall packing runs | Rendered memory stays within budget and preserves highest-score memory | 4 | Budget exceeded or best memory dropped | `budget_overflow` | `tests/memory/sessionMemoryEngine.test.ts` |
| B06 | P1 | Integration | `historySummary` already exists | Prompt is built after pruning | Summary appears once in system prompt | 2 | Summary duplicated | `history_loss` | `tests/context/historyPruner.test.ts` |
| B07 | P1 | Integration | Old history contains recent tool evidence | Pruning runs | Tool evidence summary remains available without full old transcript | 2 | Tool evidence disappears | `history_loss` | `tests/context/historyPruner.test.ts` |
| B08 | P1 | Unit | Multiple memories have identical final scores | Recall sorts results | Order is deterministic by explicit status, recency, then hash/source | 2 | Test order flakes | `recall_ranking_error` | `tests/memory/sessionMemoryEngine.test.ts` |
| B09 | P1 | Integration | Explicit global memory conflicts with weak session memory | Recall ranks candidates | Explicit global memory can outrank weak/noisy session memory | 2 | Session always wins regardless of quality | `recall_ranking_error` | `tests/memory/sessionMemoryEngine.test.ts` |
| B10 | P2 | Integration | Query has Vietnamese without accents | Recall searches memory saved with accents | Relevant Vietnamese memory is recalled | 1 | Recall misses accent variant | `recall_ranking_error` | `tests/memory/memoryStore.test.ts` |

## C. Agent Loop + Persistence test cases

| ID | Priority | Layer | Given | When | Then | Score | Failure signal | Diagnosis | Mapped test file |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| C01 | P0 | E2E | First turn has no stored memory | Interactive CLI runs first user input | `memoryText` passed to turn is empty | 3 | First turn gets stale/fake memory | `prompt_placement_regression` | `tests/cli/sessionMemoryFlow.test.ts` |
| C02 | P0 | E2E | First turn explicitly saves editor preference | Second turn asks about editor | Memory is recalled in same session | 4 | Second turn has empty memory | `capture_false_negative` | `tests/cli/sessionMemoryFlow.test.ts` |
| C03 | P0 | E2E | First turn has successful tool result for package version | Second turn asks how to check version | Procedure memory recalls package.json and version | 4 | Procedure missing | `procedure_leak` | `tests/cli/sessionMemoryFlow.test.ts` |
| C04 | P0 | E2E | Tool result is an error | Next turn asks about learned procedure | No successful procedure memory is recalled | 3 | Error result stored as success | `procedure_leak` | `tests/cli/sessionMemoryFlow.test.ts` |
| C05 | P0 | E2E | Session A captures global preference | Session B in another repo asks related question | B recalls global memory | 4 | B cannot see global memory | `global_recall_miss` | `tests/cli/sessionMemoryFlow.test.ts` |
| C06 | P0 | E2E | Session A stores session-local fact | Session B asks related question | B does not recall A's session-local memory | 4 | Session-local memory leaks | `cross_session_leak` | `tests/cli/sessionMemoryFlow.test.ts` |
| C07 | P0 | Regression | Prompt history is pruned for context | Checkpoint is saved after the turn | Checkpoint `history` still contains full unpruned history | 4 | Checkpoint history equals pruned prompt history | `history_loss` | `tests/cli/sessionMemoryFlow.test.ts` |
| C08 | P1 | Integration | Provider emits assistant tool call and tool result | `runAgentTurn` completes | History order is user, assistant tool call, tool result, assistant final answer | 2 | Tool result or final answer is out of order | `agent_loop_order_error` | `tests/agent/loop.test.ts` |
| C09 | P1 | Integration | Provider keeps emitting tool calls until limit | `runAgentTurn` reaches max rounds | Stop reason is max rounds and memory capture does not mark success procedure | 2 | Failed/incomplete loop captured as success | `agent_loop_order_error` | `tests/agent/loop.test.ts` |
| C10 | P1 | Regression | Two checkpoints share same `updatedAt` | Latest checkpoint is requested | Tie-break is deterministic | 2 | Latest checkpoint changes nondeterministically | `checkpoint_drift` | `tests/session/checkpointStore.test.ts` |
| C11 | P1 | Regression | Checkpoint contains session memory metadata | Session resumes | Same session ID and memory paths are used | 2 | Resume creates unrelated memory namespace | `checkpoint_drift` | `tests/session/session.test.ts` |
| C12 | P1 | E2E | Memory has degraded to hash rendering | User supplies hash prefix later | Full content can be recovered | 2 | Hash recall cannot restore full memory | `budget_overflow` | `tests/memory/memvidSessionStore.test.ts` |

## D. Benchmark Scoring + Diagnosis coverage

The D area is not a separate runtime layer; it is the scoring and triage discipline applied to every A, B, and C case. A benchmark run should produce a diagnosis record for each failed case with:

- Case ID and priority.
- Raw assertion failure or observed behavior.
- Failure code from the taxonomy.
- First files to inspect.
- Whether the failure is data loss, privacy/session leakage, ranking weakness, prompt construction error, or checkpoint drift.
- Suggested owner action: capture heuristic change, ranking/scoring adjustment, prompt builder fix, checkpoint write-order fix, or test fixture correction.

D scoring should reward failures that are easy to act on. A red test without a diagnosis code is incomplete benchmark output even when the assertion itself is correct.

## Benchmark rubric

| Dimension | Weight | Full score | Partial score | Zero score |
| --- | ---: | --- | --- | --- |
| Recall Accuracy | 15 | Relevant memories are consistently included in top-K | Relevant memory exists but ranks low | Relevant memory is absent |
| Ranking Quality | 12 | Session/global/explicit/freshness priorities behave as intended | Correct memory appears but order is weak | Weak/noisy memory outranks important memory |
| Prompt Injection Correctness | 12 | Memory block position, format, and budget are correct | Minor formatting issue without behavior impact | Memory is missing, misplaced, or over budget |
| Capture Quality | 12 | Explicit/procedure/failure capture is precise | Captures right class but content is noisy | Captures wrong thing or misses explicit memory |
| Persistence Integrity | 12 | Memory survives turns, resume, and intended global sharing | Works in same session only | Memory is lost or leaks across sessions |
| Compaction Correctness | 10 | Downgrade preserves recall and hash recovery | Downgrade works but loses detail too early | Downgrade destroys useful memory |
| Checkpoint Integrity | 12 | Full history and metadata remain intact | Metadata mostly intact but incomplete | Pruning/checkpoint write loses data |
| Diagnosis Quality | 15 | Failure maps to code area and improvement target | Failure has only a broad category | Failure gives no actionable signal |

## Priority guide

Implement P0 first. A release should not be considered safe if any P0 test fails.

- P0: architectural correctness and data-loss/leak prevention.
- P1: ranking quality, determinism, and important regressions.
- P2: long-tail linguistic or budget variants that improve benchmark fidelity.

Suggested implementation order:

1. Add P0 A cases that validate capture precision, procedure capture, fidelity, hash recovery, and namespace isolation.
2. Add P0 B cases that validate recall merge/dedupe, memory prompt placement, empty-memory handling, and budget packing.
3. Add P0 C cases that validate same-session recall, cross-session/global behavior, tool failure handling, and full checkpoint history.
4. Add P1 deterministic ranking, resume/checkpoint, and agent-loop ordering regressions.
5. Add P2 linguistic variants after the benchmark harness can report per-case diagnosis.

## Implementation mapping summary

| Area | Primary files |
| --- | --- |
| Memory capture/store/scoring | `tests/memory/sessionMemoryEngine.test.ts`, `tests/memory/decay.test.ts`, `tests/memory/fidelity.test.ts`, `tests/memory/memvidSessionStore.test.ts` |
| Prompt and history context | `tests/context/historyPruner.test.ts` |
| CLI multi-turn flow | `tests/cli/sessionMemoryFlow.test.ts` |
| Agent provider/tool loop | `tests/agent/loop.test.ts` |
| Checkpoint and resume | `tests/session/checkpointStore.test.ts`, `tests/session/session.test.ts` |

Use the mapped files as implementation anchors, not as a requirement to create new files immediately. Prefer extending the existing tests listed above unless a case needs a focused fixture that would make the current file noisy.
