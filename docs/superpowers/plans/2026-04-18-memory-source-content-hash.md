# Memory Source Content Hash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sourceContentHash` to persisted memory index records so each record stores the SHA-256 hash of the exact markdown artifact bytes written at `markdownPath`.

**Architecture:** Keep `index.json` as the canonical persisted record store, but extend each persisted record with `sourceContentHash`. Compute the hash only after the markdown artifact is written to disk, then persist the index record with both `markdownPath` and `sourceContentHash`. Maintain backward compatibility by allowing older index records without this field to continue loading.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Node.js `crypto`, Vitest

---

## File map

- Modify: `src/memory/sessionMemoryTypes.ts` — extend persisted record types and builders with optional/required `sourceContentHash` support appropriate for writes vs reads.
- Modify: `src/memory/fileSessionStore.ts` — compute the markdown artifact hash after writing the file, store it in `index.json`, and keep old index files readable.
- Modify: `src/memory/globalMemoryStore.ts` — mirror the session-store `sourceContentHash` behavior for global memory.
- Modify: `tests/memory/fileSessionStore.test.ts` — add TDD coverage for session/global `sourceContentHash` writes and backward compatibility.

### Task 1: Extend persisted record types

**Files:**
- Modify: `src/memory/sessionMemoryTypes.ts:22-34`
- Test: `tests/memory/fileSessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

Add expectations to `tests/memory/fileSessionStore.test.ts` so at least one session record and one global record must include `sourceContentHash` after `put()`.

```ts
const index = JSON.parse(await readFile(paths.memoryPath, 'utf8')) as {
  entries: Array<Record<string, unknown>>;
};

expect(index.entries[0]?.sourceContentHash).toEqual(expect.any(String));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: FAIL because `sourceContentHash` is missing from serialized index records.

- [ ] **Step 3: Write minimal implementation**

Update `src/memory/sessionMemoryTypes.ts` so persisted records can carry the field and the builder can accept it when writing new records.

```ts
export interface PersistedSessionMemoryRecord extends SessionMemoryEntry {
  updatedAt: string;
  invalidatedAt?: string;
  status: SessionMemoryStatus;
  markdownPath: string;
  sourceContentHash?: string;
}

export interface BuildPersistedMemoryRecordInput extends SessionMemoryEntry {
  updatedAt?: string;
  invalidatedAt?: string;
  status?: SessionMemoryStatus;
  markdownPath: string;
  sourceContentHash?: string;
}
```

- [ ] **Step 4: Run test to verify it still fails for the expected next reason**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: FAIL because stores still do not populate `sourceContentHash` when writing index records.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sessionMemoryTypes.ts tests/memory/fileSessionStore.test.ts
git commit -m "refactor: extend persisted memory record shape for source content hashes"
```

### Task 2: Persist `sourceContentHash` for session memory records

**Files:**
- Modify: `src/memory/fileSessionStore.ts:84-92`
- Modify: `src/memory/fileSessionStore.ts:310-349`
- Test: `tests/memory/fileSessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

Add a session-store test that reads the markdown artifact bytes and asserts the stored hash matches the file contents exactly.

```ts
import { createHash } from 'node:crypto';

const index = JSON.parse(await readFile(store.paths().memoryPath, 'utf8')) as {
  entries: Array<{ hash: string; markdownPath: string; sourceContentHash?: string }>;
};
const record = index.entries.find((entry) => entry.hash === 'markdown123456');
const markdownBytes = await readFile(String(record?.markdownPath));
const expectedHash = createHash('sha256').update(markdownBytes).digest('hex');

expect(record?.sourceContentHash).toBe(expectedHash);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: FAIL because the session store writes `markdownPath` only.

- [ ] **Step 3: Write minimal implementation**

Update `src/memory/fileSessionStore.ts` to hash the markdown file bytes after writing the artifact, then include the hash in the index record.

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

async function createSourceContentHash(markdownPath: string): Promise<string> {
  const markdownBytes = await readFile(markdownPath);
  return createHash('sha256').update(markdownBytes).digest('hex');
}

async put(entry: SessionMemoryEntry): Promise<string> {
  const markdownPath = await writeMarkdownArtifact(this.artifactPaths.directoryPath, entry);
  const sourceContentHash = await createSourceContentHash(markdownPath);
  const index = await this.readIndex();
  index.entries = [
    ...index.entries.filter((candidate) => candidate.hash !== entry.hash),
    toIndexRecord(entry, markdownPath, sourceContentHash)
  ];
  await this.writeIndex(index);
  // existing meta update stays unchanged
}

function toIndexRecord(
  entry: SessionMemoryEntry,
  markdownPath: string,
  sourceContentHash: string
): SessionMemoryIndexRecord {
  return buildPersistedMemoryRecord({
    ...entry,
    tags: [...entry.tags],
    markdownPath,
    sourceContentHash
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: PASS for the session `sourceContentHash` test.

- [ ] **Step 5: Commit**

```bash
git add src/memory/fileSessionStore.ts tests/memory/fileSessionStore.test.ts
git commit -m "feat: persist session markdown content hashes"
```

### Task 3: Persist `sourceContentHash` for global memory records

**Files:**
- Modify: `src/memory/globalMemoryStore.ts:82-90`
- Modify: `src/memory/globalMemoryStore.ts:292-332`
- Test: `tests/memory/fileSessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

Add a global-store test mirroring the session test, asserting the global index record stores the SHA-256 of the actual markdown file bytes.

```ts
const index = JSON.parse(await readFile(store.paths().memoryPath, 'utf8')) as {
  entries: Array<{ hash: string; markdownPath: string; sourceContentHash?: string }>;
};
const record = index.entries.find((entry) => entry.hash === 'global123456');
const markdownBytes = await readFile(String(record?.markdownPath));
const expectedHash = createHash('sha256').update(markdownBytes).digest('hex');

expect(record?.sourceContentHash).toBe(expectedHash);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: FAIL because the global store still writes only `markdownPath`.

- [ ] **Step 3: Write minimal implementation**

Mirror the session-store hashing flow in `src/memory/globalMemoryStore.ts`.

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

async function createSourceContentHash(markdownPath: string): Promise<string> {
  const markdownBytes = await readFile(markdownPath);
  return createHash('sha256').update(markdownBytes).digest('hex');
}

async put(entry: SessionMemoryEntry): Promise<string> {
  const globalEntry = { ...entry, sessionId: GLOBAL_SESSION_ID };
  const markdownPath = await writeMarkdownArtifact(this.artifactPaths.directoryPath, globalEntry);
  const sourceContentHash = await createSourceContentHash(markdownPath);
  const index = await this.readIndex();
  index.entries = [
    ...index.entries.filter((candidate) => candidate.hash !== globalEntry.hash),
    toIndexRecord(globalEntry, markdownPath, sourceContentHash)
  ];
  await this.writeIndex(index);
  // existing meta update stays unchanged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: PASS for both session and global `sourceContentHash` tests.

- [ ] **Step 5: Commit**

```bash
git add src/memory/globalMemoryStore.ts tests/memory/fileSessionStore.test.ts
git commit -m "feat: persist global markdown content hashes"
```

### Task 4: Keep older index files readable

**Files:**
- Modify: `src/memory/fileSessionStore.ts:318-340`
- Modify: `src/memory/globalMemoryStore.ts:301-323`
- Test: `tests/memory/fileSessionStore.test.ts`

- [ ] **Step 1: Write the failing test**

Add a backward-compatibility test that writes an old-style index record without `sourceContentHash`, then reopens the store and verifies recall still works.

```ts
await writeFile(store.paths().memoryPath, JSON.stringify({
  entries: [
    {
      hash: 'legacy123456',
      sessionId: 'session_legacy',
      kind: 'fact',
      fullText: 'Legacy memory text.',
      summaryText: 'Legacy memory.',
      essenceText: 'Legacy essence.',
      tags: ['legacy'],
      source: 'turn-legacy',
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z',
      accessCount: 0,
      importance: 0.8,
      explicitSave: true,
      markdownPath: '/tmp/legacy.md',
      updatedAt: '2026-04-05T10:00:00.000Z',
      status: 'active'
    }
  ]
}, null, 2));

const recalled = await store.recall('legacy', { k: 5 });
expect(recalled).toEqual(expect.arrayContaining([
  expect.objectContaining({ hash: 'legacy123456' })
]));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: FAIL because `isIndexRecord()` currently requires the old exact shape and will need to accept missing `sourceContentHash` while preserving type guards.

- [ ] **Step 3: Write minimal implementation**

Relax the index record guards so `sourceContentHash` is optional on read, while still validating it as a string when present.

```ts
return typeof record.hash === 'string'
  && typeof record.sessionId === 'string'
  && typeof record.kind === 'string'
  && typeof record.summaryText === 'string'
  && typeof record.essenceText === 'string'
  && typeof record.fullText === 'string'
  && Array.isArray(record.tags)
  && typeof record.source === 'string'
  && typeof record.createdAt === 'string'
  && typeof record.updatedAt === 'string'
  && (record.status === 'active' || record.status === 'superseded' || record.status === 'invalidated')
  && typeof record.lastAccessed === 'string'
  && typeof record.accessCount === 'number'
  && typeof record.importance === 'number'
  && typeof record.explicitSave === 'boolean'
  && typeof record.markdownPath === 'string'
  && (record.sourceContentHash === undefined || typeof record.sourceContentHash === 'string');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/memory/fileSessionStore.test.ts`
Expected: PASS with legacy index files still readable.

- [ ] **Step 5: Commit**

```bash
git add src/memory/fileSessionStore.ts src/memory/globalMemoryStore.ts tests/memory/fileSessionStore.test.ts
git commit -m "fix: keep legacy memory index records readable"
```

### Task 5: Final regression

**Files:**
- Modify: `tests/memory/fileSessionStore.test.ts`
- Test: `tests/memory/fileSessionStore.test.ts`
- Test: `tests/memory/sessionMemoryEngine.test.ts`
- Test: `tests/memory/memoryStoreFactory.test.ts`

- [ ] **Step 1: Run the focused memory regression suite**

Run: `npm test -- tests/memory/fileSessionStore.test.ts tests/memory/sessionMemoryEngine.test.ts tests/memory/memoryStoreFactory.test.ts`
Expected: PASS with no failures.

- [ ] **Step 2: If any regression fails, make the smallest code or test correction needed and rerun the same command**

```bash
npm test -- tests/memory/fileSessionStore.test.ts tests/memory/sessionMemoryEngine.test.ts tests/memory/memoryStoreFactory.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/memory/sessionMemoryTypes.ts src/memory/fileSessionStore.ts src/memory/globalMemoryStore.ts tests/memory/fileSessionStore.test.ts tests/memory/sessionMemoryEngine.test.ts tests/memory/memoryStoreFactory.test.ts
git commit -m "feat: track markdown source content hashes in memory indexes"
```

## Self-review

- **Spec coverage:** The plan covers bytes-on-disk hashing, session/global write paths, backward compatibility for old index files, and focused regression for embedding-backed stores that rely on `super.put()`.
- **Placeholder scan:** No `TODO`, `TBD`, or implicit “write tests” placeholders remain; each step has exact files, code, and commands.
- **Type consistency:** `sourceContentHash` is introduced consistently in persisted record types, session/global index record guards, and file-store tests.