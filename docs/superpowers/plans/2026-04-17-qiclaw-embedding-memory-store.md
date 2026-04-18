# Embedding Memory Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interactive memory recall and capture use an embedding-backed store when `QICLAW_MEMORY_PROVIDER=ollama` is configured, with automatic fallback to lexical stores and visible fallback telemetry when embedding operations fail.

**Architecture:** Add source-level embedding session/global stores plus a factory that selects embedding or lexical backends. Keep `sessionMemoryEngine` backend-agnostic by routing store creation through the factory, and surface runtime fallback through the existing interactive memory fallback telemetry path.

**Tech Stack:** TypeScript, Vitest, existing session/global memory stores, Ollama-backed embeddings config.

---

### Task 1: Add failing tests for backend selection and fallback

**Files:**
- Create: `tests/memory/memoryStoreFactory.test.ts`
- Modify: `tests/memory/sessionMemoryEngine.test.ts`
- Modify: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing factory selection test**

```ts
const sessionStore = createSessionMemoryStore({ cwd: '/tmp/demo', sessionId: 'session_1' });
expect(sessionStore).toBeInstanceOf(FileSessionStore);

const embeddingStore = createSessionMemoryStore({
  cwd: '/tmp/demo',
  sessionId: 'session_1',
  memoryConfig: { provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://localhost:11434' }
});
expect(embeddingStore).toBeInstanceOf(EmbeddingSessionStore);
```

- [ ] **Step 2: Write the failing engine fallback test**

```ts
vi.spyOn(EmbeddingSessionStore.prototype, 'recall').mockRejectedValueOnce(new Error('ollama offline'));
const result = await prepareInteractiveSessionMemory({ ...memoryConfig });
expect(result.recalled).toEqual([expect.objectContaining({ hash: 'lexical-hit-1' })]);
expect(onBackendFallback).toHaveBeenCalledWith(expect.objectContaining({ phase: 'recall', scope: 'session' }));
```

- [ ] **Step 3: Write the failing CLI telemetry test**

```ts
expect(fallbackEvents).toContainEqual(expect.objectContaining({
  type: 'interactive_memory_fallback',
  phase: 'prepare',
  message: expect.stringContaining('embedding')
}));
```

- [ ] **Step 4: Run tests to verify failure**

Run: `npm test -- tests/memory/memoryStoreFactory.test.ts tests/memory/sessionMemoryEngine.test.ts tests/cli/repl.test.ts`
Expected: FAIL because the factory and embedding stores do not exist yet.

### Task 2: Implement embedding-backed stores and factory

**Files:**
- Create: `src/memory/embeddingSessionStore.ts`
- Create: `src/memory/embeddingGlobalMemoryStore.ts`
- Create: `src/memory/memoryStoreFactory.ts`
- Modify: `src/memory/sessionMemoryMaintenance.ts`

- [ ] **Step 1: Create the embedding session store**

```ts
export class EmbeddingSessionStore {
  constructor(options: { cwd: string; sessionId: string; memoryConfig: MemoryEmbeddingConfig }) {}
}
```

- [ ] **Step 2: Create the embedding global store**

```ts
export class EmbeddingGlobalMemoryStore {
  constructor(options: { baseDirectory?: string; memoryConfig: MemoryEmbeddingConfig }) {}
}
```

- [ ] **Step 3: Add store factory helpers**

```ts
export function createSessionMemoryStore(input: { cwd: string; sessionId: string; memoryConfig?: MemoryEmbeddingConfig }) {
  return input.memoryConfig
    ? new EmbeddingSessionStore({ cwd: input.cwd, sessionId: input.sessionId, memoryConfig: input.memoryConfig })
    : new FileSessionStore({ cwd: input.cwd, sessionId: input.sessionId, memoryConfig: input.memoryConfig });
}
```

- [ ] **Step 4: Extend maintenance typing to accept both store families**

```ts
type SessionMemoryStoreLike = FileSessionStore | GlobalMemoryStore | EmbeddingSessionStore | EmbeddingGlobalMemoryStore;
```

- [ ] **Step 5: Run tests to verify the new store and factory surface passes**

Run: `npm test -- tests/memory/memoryStoreFactory.test.ts`
Expected: PASS

### Task 3: Wire sessionMemoryEngine to the factory with runtime fallback

**Files:**
- Modify: `src/memory/sessionMemoryEngine.ts`
- Modify: `tests/memory/sessionMemoryEngine.test.ts`

- [ ] **Step 1: Replace direct store construction with factory calls**

```ts
const store = createSessionMemoryStore({ cwd: input.cwd, sessionId: input.sessionId, memoryConfig: input.memoryConfig });
const globalStore = createGlobalMemoryStore({ memoryConfig: input.memoryConfig });
```

- [ ] **Step 2: Add a fallback callback contract for embedding failures**

```ts
onBackendFallback?: (event: { phase: string; scope: 'session' | 'global'; backend: 'embedding'; fallback: 'lexical'; message: string }) => void;
```

- [ ] **Step 3: Wrap embedding-sensitive operations and retry with lexical stores on failure**

```ts
try {
  return await store.recall(query, { k });
} catch (error) {
  input.onBackendFallback?.({ phase: 'recall', scope: 'session', backend: 'embedding', fallback: 'lexical', message: String(error) });
  const lexicalStore = new FileSessionStore({ cwd: input.cwd, sessionId: input.sessionId });
  await lexicalStore.open();
  return lexicalStore.recall(query, { k });
}
```

- [ ] **Step 4: Run engine tests to verify recall and capture paths**

Run: `npm test -- tests/memory/sessionMemoryEngine.test.ts`
Expected: PASS

### Task 4: Surface fallback in interactive CLI and verify regressions

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/tuiController.ts`
- Modify: `tests/cli/repl.test.ts`
- Modify: `tests/cli/sessionMemoryFlow.test.ts`
- Modify: `tests/cli/tuiController.test.ts`

- [ ] **Step 1: Forward backend fallback events into existing interactive memory fallback telemetry**

```ts
onBackendFallback(event) {
  recordInteractiveMemoryFallback(cliObserver.observer, {
    sessionId,
    kind: 'prepare',
    message: `embedding ${event.scope} ${event.phase} failed; falling back to lexical: ${event.message}`
  });
}
```

- [ ] **Step 2: Pass the same fallback callback into /recal and interactive prepare paths**

```ts
const inspection = await inspectInteractiveRecall({ ..., onBackendFallback });
```

- [ ] **Step 3: Run the focused CLI regression suite**

Run: `npm test -- tests/cli/repl.test.ts tests/cli/sessionMemoryFlow.test.ts tests/cli/tuiController.test.ts tests/cli/slashCommands.test.ts`
Expected: PASS

- [ ] **Step 4: Run the final verification suite**

Run: `npm test -- tests/memory/memoryStoreFactory.test.ts tests/memory/sessionMemoryEngine.test.ts tests/cli/repl.test.ts tests/cli/sessionMemoryFlow.test.ts tests/cli/tuiController.test.ts tests/cli/slashCommands.test.ts`
Expected: PASS
