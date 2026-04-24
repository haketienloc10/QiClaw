import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureInteractiveBlueprintOutcome, prepareInteractiveBlueprintContext } from '../../src/blueprint/engine.js';
import { BlueprintStore } from '../../src/blueprint/store.js';
import type { BlueprintRecord } from '../../src/blueprint/types.js';
import type { RunAgentTurnResult } from '../../src/agent/loop.js';

const tempDirs: string[] = [];
const originalBlueprintDir = process.env.QICLAW_GLOBAL_BLUEPRINT_DIR;

function createBlueprint(overrides: Partial<BlueprintRecord> = {}): BlueprintRecord {
  return {
    id: 'bp_deploy_rollback',
    title: 'Deploy rollback investigation',
    goal: 'Handle deploy rollback requests safely.',
    trigger: {
      title: 'Deploy rollback',
      patterns: ['deploy rollback', 'rollback deploy'],
      tags: ['deploy', 'rollback']
    },
    preconditions: [],
    steps: [
      {
        id: 'inspect_logs',
        title: 'Inspect logs',
        instruction: 'Read deployment logs before taking action.',
        kind: 'inspect'
      }
    ],
    branches: [],
    expectedEvidence: [
      { description: 'Deployment logs reviewed.', kind: 'tool_result', required: true }
    ],
    failureModes: [],
    tags: ['deploy', 'rollback'],
    source: 'fixture:test',
    createdAt: '2026-04-23T10:00:00.000Z',
    updatedAt: '2026-04-23T10:00:00.000Z',
    status: 'active',
    stats: {
      useCount: 0,
      successCount: 0,
      failureCount: 0
    },
    ...overrides
  };
}

function createTurnResult(overrides: Partial<RunAgentTurnResult> = {}): RunAgentTurnResult {
  return {
    stopReason: 'completed',
    finalAnswer: 'Done.',
    history: [],
    memoryCandidates: [],
    structuredOutputParsed: false,
    toolRoundsUsed: 1,
    doneCriteria: {
      goal: 'Handle deploy rollback safely.',
      checklist: ['Handle deploy rollback safely.'],
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
      toolMessagesCount: 1,
      checks: []
    },
    ...overrides
  };
}

afterEach(async () => {
  if (originalBlueprintDir === undefined) {
    delete process.env.QICLAW_GLOBAL_BLUEPRINT_DIR;
  } else {
    process.env.QICLAW_GLOBAL_BLUEPRINT_DIR = originalBlueprintDir;
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('blueprint engine', () => {
  it('prepares blueprint context without requiring cwd', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-engine-'));
    tempDirs.push(tempDir);
    process.env.QICLAW_GLOBAL_BLUEPRINT_DIR = tempDir;

    const store = new BlueprintStore();
    await store.open();
    await store.put(createBlueprint());

    const prepared = await prepareInteractiveBlueprintContext({
      userInput: 'deploy rollback now',
      historySummary: 'recent deploy issue'
    });

    expect(prepared.blueprintText).toContain('Blueprint:');
    expect(prepared.matchedBlueprint).toEqual(expect.objectContaining({ id: 'bp_deploy_rollback' }));
  });

  it('does not recreate a missing persisted blueprint from stale matched input during outcome capture', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-engine-'));
    tempDirs.push(tempDir);
    process.env.QICLAW_GLOBAL_BLUEPRINT_DIR = tempDir;

    const store = new BlueprintStore();
    await store.open();
    const persisted = await store.put(createBlueprint());
    const indexPath = store.paths().indexPath;
    await readFile(indexPath, 'utf8');
    await store.retireBlueprint(persisted.id);

    await writeFile(indexPath, JSON.stringify({ entries: [] }, null, 2));

    await captureInteractiveBlueprintOutcome({
      matchedBlueprint: persisted,
      result: createTurnResult(),
      now: '2026-04-24T08:00:00.000Z'
    });

    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { entries: unknown[] };
    expect(index.entries).toEqual([]);
  });
});
