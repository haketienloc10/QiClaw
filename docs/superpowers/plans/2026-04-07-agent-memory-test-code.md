# Agent Memory Test Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the approved agent + memory benchmark matrix into concrete Vitest coverage in the existing QiClaw test suite.

**Architecture:** Extend the current test files that already own each behavior domain instead of building a new harness. Add only the missing P0/P1 cases from the matrix first, using existing helper patterns, temp directories, and mocked store/provider boundaries so coverage grows without destabilizing the suite.

**Tech Stack:** TypeScript, Vitest, existing QiClaw agent/memory/session test utilities

---

## File structure

- Modify: `tests/memory/sessionMemoryEngine.test.ts`
  - Add missing capture, recall ranking, dedupe, empty/budget, and deterministic ordering cases.
- Modify: `tests/context/historyPruner.test.ts`
  - Add prompt placement and empty-memory injection regression coverage.
- Modify: `tests/cli/sessionMemoryFlow.test.ts`
  - Add global-vs-session isolation, failed-tool non-procedure capture, and checkpoint/full-history regression coverage.
- Modify: `tests/agent/loop.test.ts`
  - Add agent loop ordering and max-tool-rounds non-success memory-related regression coverage where possible at loop level.
- Modify: `tests/session/checkpointStore.test.ts`
  - Add deterministic latest-checkpoint tie-break coverage if missing edge conditions remain.
- Modify: `tests/session/session.test.ts`
  - Add resume/session-memory metadata assertions if missing.
- Verify against:
  - `docs/research/agent-memory-test-matrix.md`

## Task 1: Add missing Memory Core coverage in session memory engine tests

**Files:**
- Modify: `tests/memory/sessionMemoryEngine.test.ts`
- Test: `tests/memory/sessionMemoryEngine.test.ts`

- [ ] **Step 1: Write the failing tests for missing matrix cases**

Append tests covering:

```ts
it('does not persist a successful procedure memory when the current tool result is an error', async () => {
  const put = vi.fn(async () => undefined);
  const seal = vi.fn(async () => undefined);

  const result = await captureInteractiveTurnMemory({
    store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory.mv2' }) } as never,
    sessionId: 'session_1',
    userInput: 'read the package file',
    finalAnswer: 'Try again with the correct path.',
    history: [
      { role: 'user', content: 'read the package file' },
      {
        role: 'assistant',
        content: 'I will inspect the package file.',
        toolCalls: [{ id: 'tool_err_1', name: 'Read', input: { file_path: '/tmp/missing-package.json' } }]
      },
      {
        role: 'tool',
        name: 'Read',
        toolCallId: 'tool_err_1',
        content: 'ENOENT: no such file or directory',
        isError: true
      },
      { role: 'assistant', content: 'Try again with the correct path.' }
    ]
  });

  expect(result.saved).toBe(true);
  expect(result.entry).toMatchObject({
    kind: 'failure',
    explicitSave: false
  });
  expect(result.entry?.summaryText.toLowerCase()).toContain('try again');
});

it('dedupes session and global recall by keeping the stronger explicit candidate', () => {
  const sessionCandidate = createCandidate({
    hash: 'session123',
    sessionId: 'session_1',
    summaryText: 'Use login blueprint with audit logging.',
    essenceText: 'login blueprint with audit logging',
    retrievalScore: 0.88,
    importance: 0.55,
    explicitSave: false
  });
  const globalCandidate = createCandidate({
    hash: 'global123',
    sessionId: 'user-global',
    summaryText: 'Use login blueprint with audit logging.',
    essenceText: 'login blueprint with audit logging',
    retrievalScore: 0.86,
    importance: 0.62,
    explicitSave: true
  });

  const result = recallSessionMemories({
    candidates: [sessionCandidate, globalCandidate],
    budgetChars: 4000,
    now: '2026-04-07T00:00:00.000Z'
  });

  expect(result.recalled).toHaveLength(2);
  expect(result.memoryText).toContain('Use login blueprint with audit logging.');
});

it('returns deterministic order when candidates have identical scores', () => {
  const first = createCandidate({
    hash: 'aaa111',
    summaryText: 'First memory',
    essenceText: 'First memory',
    retrievalScore: 0.5,
    importance: 0.5,
    explicitSave: false,
    createdAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z'
  });
  const second = createCandidate({
    hash: 'bbb222',
    summaryText: 'Second memory',
    essenceText: 'Second memory',
    retrievalScore: 0.5,
    importance: 0.5,
    explicitSave: false,
    createdAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z'
  });

  const firstRun = recallSessionMemories({ candidates: [first, second], budgetChars: 4000, now: '2026-04-07T00:00:00.000Z' });
  const secondRun = recallSessionMemories({ candidates: [first, second], budgetChars: 4000, now: '2026-04-07T00:00:00.000Z' });

  expect(firstRun.recalled.map((entry) => entry.hash)).toEqual(secondRun.recalled.map((entry) => entry.hash));
});
```

- [ ] **Step 2: Run the focused test file to verify at least one new case fails if coverage is missing**

Run:

```bash
npm test -- tests/memory/sessionMemoryEngine.test.ts
```

Expected: either FAIL on the newly added cases or PASS immediately if current implementation already satisfies them.

- [ ] **Step 3: Make the minimal test-only adjustments needed**

If any case fails because the test assumption is wrong, adjust only the test expectations to match the real contract already implemented in:

```ts
captureInteractiveTurnMemory()
recallSessionMemories()
prepareInteractiveSessionMemory()
```

Do not change runtime code unless a real bug is proven.

- [ ] **Step 4: Re-run the focused file until all cases pass**

Run:

```bash
npm test -- tests/memory/sessionMemoryEngine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the memory-core test additions**

```bash
git add tests/memory/sessionMemoryEngine.test.ts
git commit -m "test: expand session memory engine coverage"
```

## Task 2: Add Recall + Context prompt regressions

**Files:**
- Modify: `tests/context/historyPruner.test.ts`
- Test: `tests/context/historyPruner.test.ts`

- [ ] **Step 1: Write the failing tests for prompt placement and empty memory injection**

Append:

```ts
it('does not inject a blank memory user message when memory text is empty or whitespace only', () => {
  const result = buildPromptWithContext({
    baseSystemPrompt: 'Base system prompt',
    memoryText: '   \n\n  ',
    history: [
      message('user', 'Current question'),
      message('assistant', 'Current answer')
    ]
  });

  expect(result.messages).toEqual([
    message('system', 'Base system prompt'),
    message('user', 'Current question'),
    message('assistant', 'Current answer')
  ]);
});

it('places memory immediately after the system prompt and before all recent history', () => {
  const result = buildPromptWithContext({
    baseSystemPrompt: 'Base system prompt',
    memoryText: 'Memory:\n- Login blueprint uses audit logging.',
    history: [
      message('user', 'Turn 1 question'),
      message('assistant', 'Turn 1 answer'),
      message('user', 'Turn 2 question')
    ]
  });

  expect(result.messages[0]).toEqual(message('system', 'Base system prompt'));
  expect(result.messages[1]).toEqual(message('user', 'Memory:\n- Login blueprint uses audit logging.'));
  expect(result.messages.slice(2)).toEqual([
    message('user', 'Turn 1 question'),
    message('assistant', 'Turn 1 answer'),
    message('user', 'Turn 2 question')
  ]);
});
```

- [ ] **Step 2: Run the focused context tests**

Run:

```bash
npm test -- tests/context/historyPruner.test.ts
```

Expected: PASS if prompt builder already honors the contract; otherwise FAIL and reveal a regression.

- [ ] **Step 3: Fix only proven regression or wrong expectation**

If failing, update only the narrow test assumption or the minimal prompt-builder behavior required by the matrix.

- [ ] **Step 4: Re-run the focused file**

Run:

```bash
npm test -- tests/context/historyPruner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the context regression tests**

```bash
git add tests/context/historyPruner.test.ts
git commit -m "test: add prompt memory regression coverage"
```

## Task 3: Add CLI session/global persistence regressions

**Files:**
- Modify: `tests/cli/sessionMemoryFlow.test.ts`
- Test: `tests/cli/sessionMemoryFlow.test.ts`

- [ ] **Step 1: Write the failing E2E-style tests for missing matrix cases**

Append tests covering:

```ts
it('does not recall a successful procedure after a turn whose tool result ended with isError true', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
  tempDirs.push(tempDir);

  const interactiveInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
  const interactiveCli = buildCli({
    argv: [],
    cwd: tempDir,
    stdout: { write() { return true; } },
    createRuntime: (runtimeOptions) => ({
      provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
      availableTools: [],
      cwd: tempDir,
      observer: runtimeOptions.observer ?? { record() {} },
      agentSpec: defaultAgentSpec,
      systemPrompt: 'Test prompt',
      maxToolRounds: 3
    }),
    createSessionId: () => 'session-memory-failed-procedure',
    readLine: (() => {
      const inputs = ['read the missing package file', 'how should you do that next time?', '/exit'];
      return async () => inputs.shift();
    })(),
    runTurn: async (input) => {
      interactiveInputs.push({ userInput: input.userInput, sessionId: input.sessionId, memoryText: input.memoryText });
      const firstTurn = input.userInput === 'read the missing package file';
      return {
        stopReason: 'completed' as const,
        finalAnswer: firstTurn ? 'Try again with the correct path.' : 'I should not claim a successful package.json procedure from the failed turn.',
        history: firstTurn
          ? [
              ...(input.history ?? []),
              { role: 'user' as const, content: input.userInput },
              {
                role: 'assistant' as const,
                content: 'I will inspect the package metadata.',
                toolCalls: [{ id: 'tool_failed_read', name: 'Read', input: { file_path: '/tmp/missing-package.json' } }]
              },
              {
                role: 'tool' as const,
                name: 'Read',
                toolCallId: 'tool_failed_read',
                content: 'ENOENT: no such file or directory',
                isError: true
              },
              { role: 'assistant' as const, content: 'Try again with the correct path.' }
            ]
          : [
              ...(input.history ?? []),
              { role: 'user' as const, content: input.userInput },
              { role: 'assistant' as const, content: 'I should not claim a successful package.json procedure from the failed turn.' }
            ],
        historySummary: firstTurn ? 'failed package read' : 'checked failed procedure recall',
        toolRoundsUsed: firstTurn ? 1 : 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
          requiresNonEmptyFinalAnswer: true,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: true,
          finalAnswerIsNonEmpty: true,
          finalAnswerIsSubstantive: true,
          toolEvidenceSatisfied: true,
          noUnresolvedToolErrors: true,
          toolMessagesCount: firstTurn ? 1 : 0,
          checks: []
        }
      };
    }
  });

  await expect(interactiveCli.run()).resolves.toBe(0);
  expect(interactiveInputs).toHaveLength(2);
  expect(interactiveInputs[1].memoryText ?? '').not.toContain('package.json');
  expect(interactiveInputs[1].memoryText ?? '').not.toContain('successful');
});
```

- [ ] **Step 2: Run the focused CLI memory flow tests**

Run:

```bash
npm test -- tests/cli/sessionMemoryFlow.test.ts
```

Expected: PASS if failure memory is already handled correctly; otherwise FAIL and show the exact regression.

- [ ] **Step 3: Fix only the proven issue or expectation mismatch**

If failing, prefer adjusting the test fixture first. Only patch runtime if the matrix reveals a real bug in capture or checkpoint behavior.

- [ ] **Step 4: Re-run the focused CLI file**

Run:

```bash
npm test -- tests/cli/sessionMemoryFlow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the CLI persistence regression tests**

```bash
git add tests/cli/sessionMemoryFlow.test.ts
git commit -m "test: cover session memory persistence regressions"
```

## Task 4: Add agent loop and checkpoint edge coverage

**Files:**
- Modify: `tests/agent/loop.test.ts`
- Modify: `tests/session/checkpointStore.test.ts`
- Modify: `tests/session/session.test.ts`
- Test: `tests/agent/loop.test.ts`
- Test: `tests/session/checkpointStore.test.ts`
- Test: `tests/session/session.test.ts`

- [ ] **Step 1: Add the failing agent loop order regression test**

In `tests/agent/loop.test.ts`, add a case shaped like:

```ts
it('preserves user -> assistant tool call -> tool result -> assistant final answer order', async () => {
  const result = await runAgentTurn({
    provider: createScriptedProvider([
      {
        message: {
          role: 'assistant',
          content: 'I will inspect package.json.',
          toolCalls: [{ id: 'tool_read_1', name: 'Read', input: { file_path: '/tmp/package.json' } }]
        }
      },
      {
        message: {
          role: 'assistant',
          content: 'package.json shows version 1.2.3.'
        },
        stopReason: 'completed'
      }
    ]),
    availableTools: [
      {
        name: 'Read',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        async execute() {
          return { content: '{"version":"1.2.3"}' };
        }
      }
    ],
    baseSystemPrompt: 'Base system prompt',
    userInput: 'show me the package version',
    cwd: '/tmp',
    maxToolRounds: 2
  });

  expect(result.history.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
});
```

- [ ] **Step 2: Add deterministic checkpoint and resume assertions if still missing**

Append cases to `tests/session/checkpointStore.test.ts` and `tests/session/session.test.ts` that assert:

```ts
expect(latest.sessionId).toBe('session_b');
expect(parsed.sessionMemory?.storeSessionId).toBe('session-memory-1');
expect(parsed.sessionMemory?.memoryPath).toContain('.qiclaw');
```

Use the real helper APIs already imported in those files.

- [ ] **Step 3: Run the focused edge-coverage files**

Run:

```bash
npm test -- tests/agent/loop.test.ts tests/session/checkpointStore.test.ts tests/session/session.test.ts
```

Expected: PASS or a small number of focused failures.

- [ ] **Step 4: Apply the minimal fix and re-run**

If a real bug is exposed, fix the smallest production surface necessary. Otherwise adjust only the test assertions to match the actual contract.

- [ ] **Step 5: Commit the edge coverage additions**

```bash
git add tests/agent/loop.test.ts tests/session/checkpointStore.test.ts tests/session/session.test.ts
git commit -m "test: add agent loop and checkpoint edge coverage"
```

## Task 5: Run the full relevant benchmark-backed suite

**Files:**
- Test: `tests/memory/sessionMemoryEngine.test.ts`
- Test: `tests/context/historyPruner.test.ts`
- Test: `tests/cli/sessionMemoryFlow.test.ts`
- Test: `tests/agent/loop.test.ts`
- Test: `tests/session/checkpointStore.test.ts`
- Test: `tests/session/session.test.ts`

- [ ] **Step 1: Run the relevant suite**

Run:

```bash
npm test -- tests/memory/sessionMemoryEngine.test.ts tests/context/historyPruner.test.ts tests/cli/sessionMemoryFlow.test.ts tests/agent/loop.test.ts tests/session/checkpointStore.test.ts tests/session/session.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the broader baseline used earlier**

Run:

```bash
npm test -- tests/memory tests/context tests/agent tests/cli tests/session
```

Expected: PASS.

- [ ] **Step 3: Commit the final benchmark-backed test suite changes**

```bash
git add tests/memory/sessionMemoryEngine.test.ts tests/context/historyPruner.test.ts tests/cli/sessionMemoryFlow.test.ts tests/agent/loop.test.ts tests/session/checkpointStore.test.ts tests/session/session.test.ts
git commit -m "test: implement agent memory benchmark coverage"
```

## Self-review

- Spec coverage: This plan converts the approved matrix into concrete coverage across memory core, recall/context, agent loop/persistence, and checkpoint edges.
- Placeholder scan: Every task names exact files, exact test commands, and concrete code snippets to add.
- Type consistency: All APIs and file paths referenced here already exist in the current QiClaw worktree and match the explored tests.
- Scope control: Prefer test-only changes first. Only change runtime code if a newly added test proves a real product bug.
