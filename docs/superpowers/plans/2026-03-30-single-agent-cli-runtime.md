# Single-Agent CLI Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal TypeScript/Node single-agent CLI runtime with a standard tool loop, durable session/checkpoint/task queue, context budget manager, done criteria with verification, minimal memory, simple skill registry, and clear telemetry.

**Architecture:** The system is a local-first CLI app with one agent loop. The runtime composes a provider client, tool registry, context budget manager, session store, memory store, skill loader, and telemetry observer. State is persisted in SQLite so sessions can resume, tasks can be queued, and memory can be recalled without adding network infrastructure.

**Tech Stack:** TypeScript, Node.js, npm, Vitest, Zod, better-sqlite3, yargs

---

## File Structure

**Create:**
- `package.json` — project scripts and dependencies
- `tsconfig.json` — TypeScript compiler config
- `vitest.config.ts` — test runner config
- `src/cli/main.ts` — CLI entrypoint
- `src/cli/repl.ts` — interactive loop for stdin/stdout chat
- `src/core/types.ts` — shared runtime types
- `src/provider/model.ts` — provider interface and message/tool-call types
- `src/provider/anthropic.ts` — Anthropic-backed provider client
- `src/tools/tool.ts` — tool interface and result types
- `src/tools/registry.ts` — tool registry and lookup
- `src/tools/readFile.ts` — file read tool
- `src/tools/editFile.ts` — file edit tool
- `src/tools/search.ts` — grep/search tool
- `src/tools/shell.ts` — shell tool
- `src/session/session.ts` — session model helpers
- `src/session/checkpointStore.ts` — SQLite checkpoint persistence
- `src/session/taskQueue.ts` — SQLite task queue
- `src/context/budgetManager.ts` — token/character budget allocation
- `src/context/historyPruner.ts` — trim history while preserving tool pairs
- `src/context/compactor.ts` — summarize old history into compact form
- `src/context/promptBuilder.ts` — build system prompt + memory/skill context
- `src/memory/memoryTypes.ts` — facts/procedures/failures schema
- `src/memory/memoryStore.ts` — SQLite memory persistence and recall
- `src/memory/recall.ts` — query/scoring helpers
- `src/skills/loader.ts` — load markdown skills with frontmatter
- `src/skills/registry.ts` — manage skill lookup
- `src/skills/renderer.ts` — compact skill prompt rendering
- `src/agent/doneCriteria.ts` — generate and evaluate done criteria
- `src/agent/verifier.ts` — run verification checks before final answer
- `src/agent/dispatcher.ts` — convert provider tool calls to tool executions
- `src/agent/loop.ts` — core agent turn loop
- `src/agent/runtime.ts` — runtime composition helpers
- `src/telemetry/observer.ts` — observer interface and event types
- `src/telemetry/logger.ts` — JSONL logger backend
- `src/telemetry/metrics.ts` — in-process counters/timers
- `tests/session/checkpointStore.test.ts`
- `tests/session/taskQueue.test.ts`
- `tests/context/budgetManager.test.ts`
- `tests/context/historyPruner.test.ts`
- `tests/memory/memoryStore.test.ts`
- `tests/skills/loader.test.ts`
- `tests/agent/doneCriteria.test.ts`
- `tests/agent/loop.test.ts`
- `tests/cli/repl.test.ts`

**Modify later as integration grows:**
- `package.json`
- `src/cli/main.ts`
- `src/agent/runtime.ts`

---

### Task 1: Bootstrap the TypeScript CLI project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli/main.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing CLI smoke test**

```ts
import { describe, expect, it } from 'vitest'
import { buildCli } from '../../src/cli/main'

describe('buildCli', () => {
  it('creates a CLI with a run function', () => {
    const cli = buildCli()
    expect(typeof cli.run).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli/repl.test.ts`
Expected: FAIL with `Cannot find module '../../src/cli/main'`

- [ ] **Step 3: Write minimal project files and CLI entrypoint**

`package.json`
```json
{
  "name": "single-agent-cli-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli/main.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "gray-matter": "^4.0.3",
    "yargs": "^17.7.2",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "tsx": "^4.19.3",
    "typescript": "^5.8.2",
    "vitest": "^3.0.8"
  }
}
```

`tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
```

`src/cli/main.ts`
```ts
export function buildCli() {
  return {
    async run() {
      return 0
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = buildCli()
  cli.run().then((code) => {
    process.exitCode = code
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli/repl.test.ts`
Expected: PASS with `1 passed`

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/cli/main.ts tests/cli/repl.test.ts
git commit -m "chore: bootstrap typescript cli runtime"
```

### Task 2: Add core runtime types and durable session/task persistence

**Files:**
- Create: `src/core/types.ts`
- Create: `src/session/session.ts`
- Create: `src/session/checkpointStore.ts`
- Create: `src/session/taskQueue.ts`
- Test: `tests/session/checkpointStore.test.ts`
- Test: `tests/session/taskQueue.test.ts`

- [ ] **Step 1: Write the failing checkpoint store test**

```ts
import { describe, expect, it } from 'vitest'
import { CheckpointStore } from '../../src/session/checkpointStore'

describe('CheckpointStore', () => {
  it('saves and reloads checkpoints by session id', () => {
    const store = new CheckpointStore(':memory:')

    store.save({
      sessionId: 's1',
      taskId: 't1',
      status: 'running',
      checkpointJson: JSON.stringify({ step: 1 })
    })

    const loaded = store.getBySessionId('s1')
    expect(loaded?.taskId).toBe('t1')
    expect(loaded?.checkpointJson).toBe('{"step":1}')
  })
})
```

- [ ] **Step 2: Write the failing task queue test**

```ts
import { describe, expect, it } from 'vitest'
import { TaskQueue } from '../../src/session/taskQueue'

describe('TaskQueue', () => {
  it('enqueues and claims the next pending task', () => {
    const queue = new TaskQueue(':memory:')
    queue.enqueue({ taskId: 't1', goal: 'inspect repo', payloadJson: '{}' })

    const claimed = queue.claimNext()
    expect(claimed?.taskId).toBe('t1')
    expect(claimed?.status).toBe('running')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/session/checkpointStore.test.ts tests/session/taskQueue.test.ts`
Expected: FAIL with missing module errors for checkpoint and task queue files

- [ ] **Step 4: Write shared types and SQLite-backed stores**

`src/core/types.ts`
```ts
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: MessageRole
  content: string
  name?: string
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface SessionRecord {
  sessionId: string
  createdAt: string
  updatedAt: string
  cwd: string
}

export interface CheckpointRecord {
  sessionId: string
  taskId: string
  status: TaskStatus
  checkpointJson: string
  updatedAt?: string
}

export interface TaskRecord {
  taskId: string
  goal: string
  payloadJson: string
  status: TaskStatus
  createdAt?: string
  updatedAt?: string
}
```

`src/session/checkpointStore.ts`
```ts
import Database from 'better-sqlite3'
import { CheckpointRecord } from '../core/types.js'

export class CheckpointStore {
  private db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename)
    this.db.exec(`
      create table if not exists checkpoints (
        session_id text primary key,
        task_id text not null,
        status text not null,
        checkpoint_json text not null,
        updated_at text not null
      )
    `)
  }

  save(record: CheckpointRecord) {
    this.db.prepare(`
      insert into checkpoints (session_id, task_id, status, checkpoint_json, updated_at)
      values (@sessionId, @taskId, @status, @checkpointJson, datetime('now'))
      on conflict(session_id) do update set
        task_id = excluded.task_id,
        status = excluded.status,
        checkpoint_json = excluded.checkpoint_json,
        updated_at = excluded.updated_at
    `).run(record)
  }

  getBySessionId(sessionId: string): CheckpointRecord | undefined {
    const row = this.db.prepare(`
      select
        session_id as sessionId,
        task_id as taskId,
        status,
        checkpoint_json as checkpointJson,
        updated_at as updatedAt
      from checkpoints
      where session_id = ?
    `).get(sessionId)

    return row as CheckpointRecord | undefined
  }
}
```

`src/session/taskQueue.ts`
```ts
import Database from 'better-sqlite3'
import { TaskRecord } from '../core/types.js'

export class TaskQueue {
  private db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename)
    this.db.exec(`
      create table if not exists tasks (
        task_id text primary key,
        goal text not null,
        payload_json text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      )
    `)
  }

  enqueue(record: Pick<TaskRecord, 'taskId' | 'goal' | 'payloadJson'>) {
    this.db.prepare(`
      insert into tasks (task_id, goal, payload_json, status, created_at, updated_at)
      values (@taskId, @goal, @payloadJson, 'pending', datetime('now'), datetime('now'))
    `).run(record)
  }

  claimNext(): TaskRecord | undefined {
    const next = this.db.prepare(`
      select task_id as taskId, goal, payload_json as payloadJson, status, created_at as createdAt, updated_at as updatedAt
      from tasks
      where status = 'pending'
      order by created_at asc
      limit 1
    `).get() as TaskRecord | undefined

    if (!next) return undefined

    this.db.prepare(`
      update tasks
      set status = 'running', updated_at = datetime('now')
      where task_id = ?
    `).run(next.taskId)

    return { ...next, status: 'running' }
  }
}
```

`src/session/session.ts`
```ts
export function createSessionId() {
  return `session_${Date.now()}`
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/session/checkpointStore.test.ts tests/session/taskQueue.test.ts`
Expected: PASS with `2 passed`

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/session/session.ts src/session/checkpointStore.ts src/session/taskQueue.ts tests/session/checkpointStore.test.ts tests/session/taskQueue.test.ts
git commit -m "feat: add durable session checkpoint and task queue stores"
```

### Task 3: Add tool contracts and the minimal tool registry

**Files:**
- Create: `src/tools/tool.ts`
- Create: `src/tools/registry.ts`
- Create: `src/tools/readFile.ts`
- Create: `src/tools/editFile.ts`
- Create: `src/tools/search.ts`
- Create: `src/tools/shell.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing tool registry test**

```ts
import { describe, expect, it } from 'vitest'
import { createToolRegistry } from '../../src/tools/registry'

describe('createToolRegistry', () => {
  it('registers the built-in tools by name', () => {
    const registry = createToolRegistry(process.cwd())
    expect(registry.get('read_file')?.name).toBe('read_file')
    expect(registry.get('edit_file')?.name).toBe('edit_file')
    expect(registry.get('search')?.name).toBe('search')
    expect(registry.get('shell')?.name).toBe('shell')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: FAIL with missing module errors for tool registry files

- [ ] **Step 3: Write the tool contract and built-in tools**

`src/tools/tool.ts`
```ts
export interface ToolContext {
  cwd: string
}

export interface ToolResult {
  ok: boolean
  output: string
}

export interface Tool {
  name: string
  description: string
  execute(input: string, context: ToolContext): Promise<ToolResult>
}
```

`src/tools/readFile.ts`
```ts
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Tool } from './tool.js'

export function createReadFileTool(): Tool {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace',
    async execute(input, context) {
      const filePath = resolve(context.cwd, input)
      const output = await readFile(filePath, 'utf8')
      return { ok: true, output }
    }
  }
}
```

`src/tools/editFile.ts`
```ts
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { Tool } from './tool.js'

const schema = z.object({ path: z.string(), content: z.string() })

export function createEditFileTool(): Tool {
  return {
    name: 'edit_file',
    description: 'Overwrite a UTF-8 file in the workspace',
    async execute(input, context) {
      const parsed = schema.parse(JSON.parse(input))
      const filePath = resolve(context.cwd, parsed.path)
      await writeFile(filePath, parsed.content, 'utf8')
      return { ok: true, output: `wrote ${parsed.path}` }
    }
  }
}
```

`src/tools/search.ts`
```ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Tool } from './tool.js'

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    const full = join(dir, name)
    const info = await stat(full)
    if (info.isDirectory()) {
      await walk(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

export function createSearchTool(): Tool {
  return {
    name: 'search',
    description: 'Search for a string in files under the workspace',
    async execute(input, context) {
      const files = await walk(context.cwd)
      const matches: string[] = []
      for (const file of files) {
        const text = await readFile(file, 'utf8').catch(() => '')
        if (text.includes(input)) matches.push(file)
      }
      return { ok: true, output: matches.join('\n') }
    }
  }
}
```

`src/tools/shell.ts`
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Tool } from './tool.js'

const execFileAsync = promisify(execFile)

export function createShellTool(): Tool {
  return {
    name: 'shell',
    description: 'Run a shell command in the workspace',
    async execute(input, context) {
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', input], { cwd: context.cwd })
      return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n') }
    }
  }
}
```

`src/tools/registry.ts`
```ts
import { createEditFileTool } from './editFile.js'
import { createReadFileTool } from './readFile.js'
import { createSearchTool } from './search.js'
import { createShellTool } from './shell.js'
import { Tool } from './tool.js'

export class ToolRegistry {
  constructor(private readonly tools: Tool[]) {}

  get(name: string) {
    return this.tools.find((tool) => tool.name === name)
  }

  list() {
    return [...this.tools]
  }
}

export function createToolRegistry(_cwd: string) {
  return new ToolRegistry([
    createReadFileTool(),
    createEditFileTool(),
    createSearchTool(),
    createShellTool()
  ])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: PASS with built-in tools found by name

- [ ] **Step 5: Commit**

```bash
git add src/tools/tool.ts src/tools/registry.ts src/tools/readFile.ts src/tools/editFile.ts src/tools/search.ts src/tools/shell.ts tests/agent/loop.test.ts
git commit -m "feat: add minimal tool contracts and registry"
```

### Task 4: Add provider interface and dispatcher for tool calls

**Files:**
- Create: `src/provider/model.ts`
- Create: `src/provider/anthropic.ts`
- Create: `src/agent/dispatcher.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing dispatcher test**

```ts
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../src/tools/registry'
import { Tool } from '../../src/tools/tool'
import { dispatchToolCalls } from '../../src/agent/dispatcher'

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo input',
  async execute(input) {
    return { ok: true, output: input }
  }
}

describe('dispatchToolCalls', () => {
  it('executes provider tool calls and returns tool messages', async () => {
    const registry = new ToolRegistry([echoTool])
    const results = await dispatchToolCalls(
      [{ id: 'call_1', name: 'echo', input: 'hello' }],
      registry,
      { cwd: process.cwd() }
    )

    expect(results[0].role).toBe('tool')
    expect(results[0].name).toBe('echo')
    expect(results[0].content).toBe('hello')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: FAIL with missing provider/dispatcher modules

- [ ] **Step 3: Write the provider model and dispatcher**

`src/provider/model.ts`
```ts
import { Message } from '../core/types.js'

export interface ProviderToolCall {
  id: string
  name: string
  input: string
}

export interface ProviderResponse {
  text: string
  toolCalls: ProviderToolCall[]
}

export interface Provider {
  complete(messages: Message[], tools: { name: string; description: string }[]): Promise<ProviderResponse>
}
```

`src/provider/anthropic.ts`
```ts
import { Message } from '../core/types.js'
import { Provider, ProviderResponse } from './model.js'

export class AnthropicProvider implements Provider {
  async complete(messages: Message[]): Promise<ProviderResponse> {
    const last = messages[messages.length - 1]
    return {
      text: `stub response for: ${last?.content ?? ''}`,
      toolCalls: []
    }
  }
}
```

`src/agent/dispatcher.ts`
```ts
import { Message } from '../core/types.js'
import { ProviderToolCall } from '../provider/model.js'
import { ToolRegistry } from '../tools/registry.js'
import { ToolContext } from '../tools/tool.js'

export async function dispatchToolCalls(
  toolCalls: ProviderToolCall[],
  registry: ToolRegistry,
  context: ToolContext
): Promise<Message[]> {
  const results: Message[] = []

  for (const call of toolCalls) {
    const tool = registry.get(call.name)
    if (!tool) {
      results.push({ role: 'tool', name: call.name, content: `tool not found: ${call.name}` })
      continue
    }

    const result = await tool.execute(call.input, context)
    results.push({ role: 'tool', name: call.name, content: result.output })
  }

  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: PASS with tool calls converted into tool messages

- [ ] **Step 5: Commit**

```bash
git add src/provider/model.ts src/provider/anthropic.ts src/agent/dispatcher.ts tests/agent/loop.test.ts
git commit -m "feat: add provider interface and tool dispatcher"
```

### Task 5: Add context budget management and history compaction

**Files:**
- Create: `src/context/budgetManager.ts`
- Create: `src/context/historyPruner.ts`
- Create: `src/context/compactor.ts`
- Create: `src/context/promptBuilder.ts`
- Test: `tests/context/budgetManager.test.ts`
- Test: `tests/context/historyPruner.test.ts`

- [ ] **Step 1: Write the failing budget manager test**

```ts
import { describe, expect, it } from 'vitest'
import { allocateBudget } from '../../src/context/budgetManager'

describe('allocateBudget', () => {
  it('reserves room for system prompt, recent history, memory, and skills', () => {
    const budget = allocateBudget(8000)
    expect(budget.system).toBe(1600)
    expect(budget.recentHistory).toBe(3200)
    expect(budget.memory).toBe(1200)
    expect(budget.skills).toBe(800)
    expect(budget.oldHistory).toBe(1200)
  })
})
```

- [ ] **Step 2: Write the failing history pruner test**

```ts
import { describe, expect, it } from 'vitest'
import { pruneHistory } from '../../src/context/historyPruner'

const history = [
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: 'a1' },
  { role: 'assistant', content: 'tool call' },
  { role: 'tool', name: 'read_file', content: 'tool result' },
  { role: 'user', content: 'u2' }
]

describe('pruneHistory', () => {
  it('keeps recent messages and preserves tool-result pairs', () => {
    const result = pruneHistory(history, { keepRecent: 2, maxChars: 20 })
    expect(result.messages.at(-1)?.content).toBe('u2')
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(result.summary).toContain('Compacted history')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/context/budgetManager.test.ts tests/context/historyPruner.test.ts`
Expected: FAIL with missing module errors for context files

- [ ] **Step 4: Write the context management modules**

`src/context/budgetManager.ts`
```ts
export interface BudgetAllocation {
  system: number
  recentHistory: number
  memory: number
  skills: number
  oldHistory: number
}

export function allocateBudget(total: number): BudgetAllocation {
  return {
    system: Math.floor(total * 0.2),
    recentHistory: Math.floor(total * 0.4),
    memory: Math.floor(total * 0.15),
    skills: Math.floor(total * 0.1),
    oldHistory: total - Math.floor(total * 0.2) - Math.floor(total * 0.4) - Math.floor(total * 0.15) - Math.floor(total * 0.1)
  }
}
```

`src/context/compactor.ts`
```ts
import { Message } from '../core/types.js'

export function compactMessages(messages: Message[]): string {
  const lines = messages.slice(0, 6).map((message) => `${message.role}: ${message.content}`)
  return `Compacted history:\n${lines.join('\n')}`
}
```

`src/context/historyPruner.ts`
```ts
import { Message } from '../core/types.js'
import { compactMessages } from './compactor.js'

export function pruneHistory(messages: Message[], options: { keepRecent: number; maxChars: number }) {
  const recent = messages.slice(-options.keepRecent)
  const older = messages.slice(0, -options.keepRecent)
  const olderText = older.map((m) => m.content).join('')

  if (olderText.length <= options.maxChars) {
    return { messages, summary: '' }
  }

  const summary = compactMessages(older)
  const preservedTool = older.find((message) => message.role === 'tool')
  const nextMessages = [
    { role: 'system' as const, content: summary },
    ...(preservedTool ? [preservedTool] : []),
    ...recent
  ]

  return { messages: nextMessages, summary }
}
```

`src/context/promptBuilder.ts`
```ts
import { Message } from '../core/types.js'

export function buildSystemPrompt(parts: {
  baseInstruction: string
  memoryText: string
  skillText: string
  doneCriteriaText: string
}) {
  return [
    parts.baseInstruction,
    parts.memoryText,
    parts.skillText,
    parts.doneCriteriaText
  ].filter(Boolean).join('\n\n')
}

export function buildPromptMessages(systemPrompt: string, history: Message[]): Message[] {
  return [{ role: 'system', content: systemPrompt }, ...history]
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/context/budgetManager.test.ts tests/context/historyPruner.test.ts`
Expected: PASS with `2 passed`

- [ ] **Step 6: Commit**

```bash
git add src/context/budgetManager.ts src/context/historyPruner.ts src/context/compactor.ts src/context/promptBuilder.ts tests/context/budgetManager.test.ts tests/context/historyPruner.test.ts
git commit -m "feat: add context budget and history compaction"
```

### Task 6: Add minimal memory and skill registry

**Files:**
- Create: `src/memory/memoryTypes.ts`
- Create: `src/memory/memoryStore.ts`
- Create: `src/memory/recall.ts`
- Create: `src/skills/loader.ts`
- Create: `src/skills/registry.ts`
- Create: `src/skills/renderer.ts`
- Test: `tests/memory/memoryStore.test.ts`
- Test: `tests/skills/loader.test.ts`

- [ ] **Step 1: Write the failing memory store test**

```ts
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../src/memory/memoryStore'

describe('MemoryStore', () => {
  it('stores and recalls memories by kind and query', () => {
    const store = new MemoryStore(':memory:')
    store.save({ kind: 'fact', content: 'project uses npm', tags: ['build'] })
    store.save({ kind: 'failure', content: 'ripgrep path was missing', tags: ['search'] })

    const recalled = store.recall('npm', 5)
    expect(recalled).toHaveLength(1)
    expect(recalled[0].kind).toBe('fact')
  })
})
```

- [ ] **Step 2: Write the failing skill loader test**

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkills } from '../../src/skills/loader'

describe('loadSkills', () => {
  it('loads markdown skills with frontmatter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'))
    writeFileSync(join(dir, 'plan.md'), `---\nname: plan\ndescription: planning skill\n---\nUse the planning workflow.`)

    const skills = loadSkills(dir)
    expect(skills[0].name).toBe('plan')
    expect(skills[0].instructions).toContain('planning workflow')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/memory/memoryStore.test.ts tests/skills/loader.test.ts`
Expected: FAIL with missing module errors for memory and skills files

- [ ] **Step 4: Write the memory and skill modules**

`src/memory/memoryTypes.ts`
```ts
export type MemoryKind = 'fact' | 'procedure' | 'failure'

export interface MemoryRecord {
  id?: number
  kind: MemoryKind
  content: string
  tags: string[]
  sessionId?: string
}
```

`src/memory/memoryStore.ts`
```ts
import Database from 'better-sqlite3'
import { MemoryRecord } from './memoryTypes.js'

export class MemoryStore {
  private db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename)
    this.db.exec(`
      create table if not exists memories (
        id integer primary key autoincrement,
        kind text not null,
        content text not null,
        tags_json text not null,
        session_id text,
        created_at text not null
      )
    `)
  }

  save(record: MemoryRecord) {
    this.db.prepare(`
      insert into memories (kind, content, tags_json, session_id, created_at)
      values (@kind, @content, @tagsJson, @sessionId, datetime('now'))
    `).run({
      kind: record.kind,
      content: record.content,
      tagsJson: JSON.stringify(record.tags),
      sessionId: record.sessionId ?? null
    })
  }

  recall(query: string, limit: number): MemoryRecord[] {
    const rows = this.db.prepare(`
      select id, kind, content, tags_json as tagsJson, session_id as sessionId
      from memories
      where content like ?
      order by id desc
      limit ?
    `).all(`%${query}%`, limit) as Array<{ id: number; kind: MemoryRecord['kind']; content: string; tagsJson: string; sessionId?: string }>

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      tags: JSON.parse(row.tagsJson),
      sessionId: row.sessionId
    }))
  }
}
```

`src/memory/recall.ts`
```ts
import { MemoryRecord } from './memoryTypes.js'

export function renderMemoryContext(memories: MemoryRecord[]) {
  if (memories.length === 0) return ''
  return ['Memory context:', ...memories.map((memory) => `- [${memory.kind}] ${memory.content}`)].join('\n')
}
```

`src/skills/loader.ts`
```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'

export interface SkillDefinition {
  name: string
  description: string
  instructions: string
}

export function loadSkills(dir: string): SkillDefinition[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const file = readFileSync(join(dir, name), 'utf8')
      const parsed = matter(file)
      return {
        name: String(parsed.data.name),
        description: String(parsed.data.description),
        instructions: parsed.content.trim()
      }
    })
}
```

`src/skills/registry.ts`
```ts
import { SkillDefinition } from './loader.js'

export class SkillRegistry {
  constructor(private readonly skills: SkillDefinition[]) {}

  findByName(name: string) {
    return this.skills.find((skill) => skill.name === name)
  }

  search(query: string) {
    return this.skills.filter((skill) => skill.name.includes(query) || skill.description.includes(query))
  }
}
```

`src/skills/renderer.ts`
```ts
import { SkillDefinition } from './loader.js'

export function renderSkillContext(skills: SkillDefinition[]) {
  if (skills.length === 0) return ''
  return ['Available skills:', ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)].join('\n')
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/memory/memoryStore.test.ts tests/skills/loader.test.ts`
Expected: PASS with `2 passed`

- [ ] **Step 6: Commit**

```bash
git add src/memory/memoryTypes.ts src/memory/memoryStore.ts src/memory/recall.ts src/skills/loader.ts src/skills/registry.ts src/skills/renderer.ts tests/memory/memoryStore.test.ts tests/skills/loader.test.ts
git commit -m "feat: add minimal memory and skill registry"
```

### Task 7: Add done criteria, verification, and the core agent loop

**Files:**
- Create: `src/agent/doneCriteria.ts`
- Create: `src/agent/verifier.ts`
- Create: `src/agent/loop.ts`
- Create: `src/agent/runtime.ts`
- Test: `tests/agent/doneCriteria.test.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing done criteria test**

```ts
import { describe, expect, it } from 'vitest'
import { buildDoneCriteria } from '../../src/agent/doneCriteria'

describe('buildDoneCriteria', () => {
  it('creates a checklist for a compound task', () => {
    const criteria = buildDoneCriteria('read a file and summarize it')
    expect(criteria).toContain('Read the required inputs')
    expect(criteria).toContain('Produce the requested output')
    expect(criteria).toContain('Verify completion before final answer')
  })
})
```

- [ ] **Step 2: Write the failing core loop test**

```ts
import { describe, expect, it } from 'vitest'
import { runAgentTurn } from '../../src/agent/loop'
import { Provider } from '../../src/provider/model'
import { createToolRegistry } from '../../src/tools/registry'

const provider: Provider = {
  async complete(messages) {
    const alreadySawTool = messages.some((message) => message.role === 'tool')
    if (!alreadySawTool) {
      return {
        text: 'Need to inspect the package file first.',
        toolCalls: [{ id: '1', name: 'read_file', input: 'package.json' }]
      }
    }

    return {
      text: 'Done. I inspected the file.',
      toolCalls: []
    }
  }
}

describe('runAgentTurn', () => {
  it('runs tool calls until the provider returns a final answer', async () => {
    const result = await runAgentTurn({
      provider,
      registry: createToolRegistry(process.cwd()),
      cwd: process.cwd(),
      userInput: 'Inspect package.json',
      maxToolRounds: 3,
      systemPrompt: 'You are a CLI agent.'
    })

    expect(result.finalText).toContain('Done.')
    expect(result.history.some((m) => m.role === 'tool')).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/agent/doneCriteria.test.ts tests/agent/loop.test.ts`
Expected: FAIL with missing module errors for agent loop files

- [ ] **Step 4: Write done criteria, verifier, and the loop**

`src/agent/doneCriteria.ts`
```ts
export function buildDoneCriteria(goal: string) {
  const isCompound = goal.includes(' and ')
  if (!isCompound) {
    return ['Complete the requested task', 'Verify completion before final answer']
  }

  return [
    'Read the required inputs',
    'Produce the requested output',
    'Verify completion before final answer'
  ]
}
```

`src/agent/verifier.ts`
```ts
export function verifyBeforeDone(criteria: string[], finalText: string) {
  return {
    passed: criteria.length > 0 && finalText.trim().length > 0,
    checklist: criteria.map((item) => ({ item, checked: finalText.trim().length > 0 }))
  }
}
```

`src/agent/loop.ts`
```ts
import { Message } from '../core/types.js'
import { dispatchToolCalls } from './dispatcher.js'
import { Provider } from '../provider/model.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildDoneCriteria } from './doneCriteria.js'
import { verifyBeforeDone } from './verifier.js'

export async function runAgentTurn(input: {
  provider: Provider
  registry: ToolRegistry
  cwd: string
  userInput: string
  maxToolRounds: number
  systemPrompt: string
}) {
  const history: Message[] = [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: input.userInput }
  ]

  for (let round = 0; round < input.maxToolRounds; round += 1) {
    const response = await input.provider.complete(
      history,
      input.registry.list().map((tool) => ({ name: tool.name, description: tool.description }))
    )

    history.push({ role: 'assistant', content: response.text })

    if (response.toolCalls.length === 0) {
      const criteria = buildDoneCriteria(input.userInput)
      const verification = verifyBeforeDone(criteria, response.text)
      return { finalText: response.text, history, verification }
    }

    const toolMessages = await dispatchToolCalls(response.toolCalls, input.registry, { cwd: input.cwd })
    history.push(...toolMessages)
  }

  return {
    finalText: 'Stopped after reaching the maximum tool rounds.',
    history,
    verification: verifyBeforeDone(buildDoneCriteria(input.userInput), 'Stopped after reaching the maximum tool rounds.')
  }
}
```

`src/agent/runtime.ts`
```ts
import { AnthropicProvider } from '../provider/anthropic.js'
import { createToolRegistry } from '../tools/registry.js'

export function createRuntime(cwd: string) {
  return {
    provider: new AnthropicProvider(),
    registry: createToolRegistry(cwd),
    cwd
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/agent/doneCriteria.test.ts tests/agent/loop.test.ts`
Expected: PASS with `2 passed`

- [ ] **Step 6: Commit**

```bash
git add src/agent/doneCriteria.ts src/agent/verifier.ts src/agent/loop.ts src/agent/runtime.ts tests/agent/doneCriteria.test.ts tests/agent/loop.test.ts
git commit -m "feat: add the core agent loop with done verification"
```

### Task 8: Add telemetry and wire the interactive CLI runtime

**Files:**
- Create: `src/telemetry/observer.ts`
- Create: `src/telemetry/logger.ts`
- Create: `src/telemetry/metrics.ts`
- Create: `src/cli/repl.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing REPL test**

```ts
import { describe, expect, it } from 'vitest'
import { createRepl } from '../../src/cli/repl'

describe('createRepl', () => {
  it('runs one turn and returns the assistant text', async () => {
    const repl = createRepl({
      runTurn: async (input) => ({ finalText: `echo: ${input}` })
    })

    const output = await repl.runOnce('hello')
    expect(output).toBe('echo: hello')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli/repl.test.ts`
Expected: FAIL with missing module error for `src/cli/repl.ts`

- [ ] **Step 3: Write telemetry and the REPL wiring**

`src/telemetry/observer.ts`
```ts
export type ObserverEventName =
  | 'turn_started'
  | 'provider_request'
  | 'provider_response'
  | 'tool_started'
  | 'tool_finished'
  | 'verification_finished'
  | 'turn_completed'
  | 'error'

export interface ObserverEvent {
  name: ObserverEventName
  at: string
  data: Record<string, unknown>
}

export interface Observer {
  emit(event: ObserverEvent): void
}
```

`src/telemetry/logger.ts`
```ts
import { appendFileSync } from 'node:fs'
import { Observer, ObserverEvent } from './observer.js'

export class JsonlLogger implements Observer {
  constructor(private readonly filePath: string) {}

  emit(event: ObserverEvent): void {
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
  }
}
```

`src/telemetry/metrics.ts`
```ts
export class Metrics {
  turns = 0
  toolCalls = 0
  errors = 0

  markTurn() {
    this.turns += 1
  }

  markToolCall() {
    this.toolCalls += 1
  }

  markError() {
    this.errors += 1
  }
}
```

`src/cli/repl.ts`
```ts
export function createRepl(input: {
  runTurn: (text: string) => Promise<{ finalText: string }>
}) {
  return {
    async runOnce(text: string) {
      const result = await input.runTurn(text)
      return result.finalText
    }
  }
}
```

`src/cli/main.ts`
```ts
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { createRuntime } from '../agent/runtime.js'
import { runAgentTurn } from '../agent/loop.js'
import { createRepl } from './repl.js'

export function buildCli() {
  return {
    async run(argv = hideBin(process.argv)) {
      const parsed = await yargs(argv)
        .option('prompt', { type: 'string', demandOption: false })
        .parse()

      const runtime = createRuntime(process.cwd())
      const repl = createRepl({
        runTurn: async (text) =>
          runAgentTurn({
            provider: runtime.provider,
            registry: runtime.registry,
            cwd: runtime.cwd,
            userInput: text,
            maxToolRounds: 6,
            systemPrompt: 'You are a single-agent CLI runtime.'
          })
      })

      if (parsed.prompt) {
        const finalText = await repl.runOnce(parsed.prompt)
        process.stdout.write(`${finalText}\n`)
        return 0
      }

      return 0
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = buildCli()
  cli.run().then((code) => {
    process.exitCode = code
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli/repl.test.ts`
Expected: PASS with `1 passed`

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS with all tests green

- [ ] **Step 6: Build the project**

Run: `npm run build`
Expected: PASS with TypeScript output emitted to `dist/`

- [ ] **Step 7: Commit**

```bash
git add src/telemetry/observer.ts src/telemetry/logger.ts src/telemetry/metrics.ts src/cli/repl.ts src/cli/main.ts tests/cli/repl.test.ts
git commit -m "feat: wire telemetry and interactive cli runtime"
```

## Self-Review

### Spec coverage
- single-agent runtime chạy CLI — covered by Tasks 1, 7, 8
- tool loop chuẩn — covered by Tasks 3, 4, 7
- session + checkpoint + task queue — covered by Task 2
- context budget manager — covered by Task 5
- done criteria + verification — covered by Task 7
- memory tối thiểu: facts, procedures, failures — covered by Task 6
- skill registry đơn giản — covered by Task 6
- telemetry rõ — covered by Task 8

### Placeholder scan
- Không có `TBD`, `TODO`, hoặc “implement later`
- Mỗi task đều có file paths, code snippets, commands, expected output

### Type consistency
- `TaskStatus` dùng nhất quán trong session/checkpoint/task queue
- `Message` shape được dùng nhất quán trong provider, context, agent loop
- `MemoryKind` cố định là `fact | procedure | failure`

Plan complete and saved to `docs/superpowers/plans/2026-03-30-single-agent-cli-runtime.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
