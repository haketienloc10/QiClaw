import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BlueprintStore } from '../../src/blueprint/store.js';
import type { BlueprintRecord } from '../../src/blueprint/types.js';

const tempDirs: string[] = [];

function createBlueprint(overrides: Partial<BlueprintRecord> = {}): BlueprintRecord {
  return {
    id: 'bp_deploy_rollback',
    title: 'Deploy rollback investigation',
    goal: 'Handle deploy rollback requests safely.',
    trigger: {
      title: 'Deploy rollback',
      patterns: ['deploy rollback', 'rollback deploy', 'revert deployment'],
      tags: ['deploy', 'rollback']
    },
    preconditions: [
      { description: 'Repository and deployment logs are accessible.', required: true }
    ],
    steps: [
      {
        id: 'inspect_logs',
        title: 'Inspect logs',
        instruction: 'Read deployment logs before taking action.',
        kind: 'inspect',
        expectedEvidence: ['deployment logs reviewed'],
        nextStepId: 'verify_state'
      },
      {
        id: 'verify_state',
        title: 'Verify state',
        instruction: 'Confirm current deployment state before rollback.',
        kind: 'verify',
        expectedEvidence: ['current deployment identified']
      }
    ],
    branches: [],
    expectedEvidence: [
      { description: 'Deployment logs reviewed.', kind: 'tool_result', required: true }
    ],
    failureModes: [
      { title: 'Rollback without evidence', signals: ['no logs checked'], mitigation: 'Inspect logs first.' }
    ],
    tags: ['deploy', 'rollback', 'ops'],
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('BlueprintStore', () => {
  it('persists active blueprints and lists them from the global index', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-store-'));
    tempDirs.push(tempDir);

    const store = new BlueprintStore({ baseDirectory: tempDir });
    await store.open();
    await store.put(createBlueprint());
    await store.seal();

    const active = await store.listActive();
    expect(active).toEqual([
      expect.objectContaining({
        id: 'bp_deploy_rollback',
        status: 'active',
        markdownPath: expect.stringContaining('bp_deploy_rollback.md')
      })
    ]);

    const index = JSON.parse(await readFile(store.paths().indexPath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'bp_deploy_rollback',
        status: 'active'
      })
    ]));
  });

  it('supersedes and retires blueprint records in the global index', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-store-'));
    tempDirs.push(tempDir);

    const store = new BlueprintStore({ baseDirectory: tempDir });
    await store.open();
    await store.put(createBlueprint({ id: 'bp_old', title: 'Old rollback procedure' }));
    await store.put(createBlueprint({ id: 'bp_new', title: 'New rollback procedure', supersedesBlueprintId: 'bp_old' }));

    await store.supersedeBlueprint('bp_old', '2026-04-24T09:00:00.000Z');
    await store.retireBlueprint('bp_new', '2026-04-24T10:00:00.000Z');

    const index = JSON.parse(await readFile(store.paths().indexPath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'bp_old',
        status: 'superseded',
        updatedAt: '2026-04-24T09:00:00.000Z'
      }),
      expect.objectContaining({
        id: 'bp_new',
        status: 'retired',
        updatedAt: '2026-04-24T10:00:00.000Z'
      })
    ]));
  });

  it('ignores malformed persisted blueprint records that are missing fields used by runtime consumers', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-store-'));
    tempDirs.push(tempDir);

    const store = new BlueprintStore({ baseDirectory: tempDir });
    await store.open();
    await writeFile(store.paths().indexPath, JSON.stringify({
      entries: [
        {
          id: 'bp_bad',
          title: 'Broken record',
          goal: 'Missing runtime fields',
          createdAt: '2026-04-23T10:00:00.000Z',
          updatedAt: '2026-04-23T10:00:00.000Z',
          status: 'active',
          markdownPath: '/tmp/broken.md'
        }
      ]
    }, null, 2));

    await expect(store.listActive()).resolves.toEqual([]);
  });

  it('does not rewrite an existing meta file when opening the store', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-store-'));
    tempDirs.push(tempDir);

    const store = new BlueprintStore({ baseDirectory: tempDir });
    await store.open();
    await writeFile(store.paths().metaPath, JSON.stringify({
      version: 1,
      engine: 'custom-blueprint-store',
      indexPath: store.paths().indexPath,
      metaPath: store.paths().metaPath,
      totalEntries: 7,
      lastSealedAt: '2026-04-24T12:00:00.000Z'
    }, null, 2));

    await store.open();

    await expect(readFile(store.paths().metaPath, 'utf8')).resolves.toBe(JSON.stringify({
      version: 1,
      engine: 'custom-blueprint-store',
      indexPath: store.paths().indexPath,
      metaPath: store.paths().metaPath,
      totalEntries: 7,
      lastSealedAt: '2026-04-24T12:00:00.000Z'
    }, null, 2));
  });
});
