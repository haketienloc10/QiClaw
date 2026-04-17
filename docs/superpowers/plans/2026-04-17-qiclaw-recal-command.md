# /recal Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/recal <input>` to the TUI so it runs the same recall candidate selection logic as interactive memory recall, but only renders the results for inspection and does not affect prompt assembly or session state.

**Architecture:** Add a small shared memory recall helper in the session memory engine that returns recall candidates and a human-readable debug rendering. Wire `/recal` into the slash command catalog and TUI controller so it opens memory stores, computes recall from the provided input, and appends transcript/status output without mutating conversation history beyond the visible slash command cell.

**Tech Stack:** TypeScript, Vitest, existing TUI controller, file/global memory stores.

---

### Task 1: Add failing slash-command tests

**Files:**
- Modify: `tests/cli/slashCommands.test.ts`
- Modify: `tests/cli/tuiController.test.ts`

- [ ] **Step 1: Write the failing catalog test**

```ts
expect(names).toContain('/recal');
expect(resolveSlashCommand('/recal')?.kind).toBe('direct');
```

- [ ] **Step 2: Write the failing controller test**

```ts
await controller.handleAction({ type: 'run_slash_command', command: '/recal', argsText: 'deploy memory' });
expect(appendEvents).toContainEqual(expect.objectContaining({
  cells: expect.arrayContaining([
    expect.objectContaining({ kind: 'status', title: 'Memory recall', text: expect.stringContaining('deploy memory') })
  ])
}));
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npm test -- tests/cli/slashCommands.test.ts tests/cli/tuiController.test.ts`
Expected: FAIL because `/recal` is not registered or handled.

### Task 2: Add shared recall debug helper and minimal implementation

**Files:**
- Modify: `src/memory/sessionMemoryEngine.ts`
- Modify: `src/cli/slashCommands.ts`
- Modify: `src/cli/tuiController.ts`

- [ ] **Step 1: Add a shared helper returning recall candidates and rendered text**

```ts
export interface InspectInteractiveRecallResult {
  renderedText: string;
  recalled: SessionMemoryCandidate[];
}
```

- [ ] **Step 2: Implement the helper with existing recall candidate logic**

```ts
const candidates = await recallInteractiveCandidates({ ... });
return {
  recalled: candidates,
  renderedText: renderInteractiveRecallInspection(input.userInput, candidates)
};
```

- [ ] **Step 3: Register `/recal` in slash commands**

```ts
{ name: '/recal', description: 'Inspect recalled memories for an input', usage: '/recal <input>', kind: 'direct' }
```

- [ ] **Step 4: Handle `/recal` in the TUI controller**

```ts
if (command.name === '/recal') {
  // guard empty input
  // call shared helper
  // append a status transcript cell titled 'Memory recall'
}
```

- [ ] **Step 5: Run targeted tests to verify they pass**

Run: `npm test -- tests/cli/slashCommands.test.ts tests/cli/tuiController.test.ts`
Expected: PASS

### Task 3: Verify memory helper behavior and finish

**Files:**
- Modify: `tests/memory/sessionMemoryEngine.test.ts`

- [ ] **Step 1: Add a focused helper test**

```ts
const result = await inspectInteractiveRecall({ ... });
expect(result.recalled).toHaveLength(2);
expect(result.renderedText).toContain('deployment');
```

- [ ] **Step 2: Run helper and CLI tests**

Run: `npm test -- tests/memory/sessionMemoryEngine.test.ts tests/cli/slashCommands.test.ts tests/cli/tuiController.test.ts`
Expected: PASS

- [ ] **Step 3: Run broader verification**

Run: `npm test -- tests/cli/sessionMemoryFlow.test.ts`
Expected: PASS
