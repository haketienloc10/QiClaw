import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { importBlueprintJson } from '../../src/blueprint/importer.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('importBlueprintJson', () => {
  it('imports a blueprint authoring JSON file into the global blueprint store format', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-import-'));
    tempDirs.push(tempDir);

    const inputPath = join(tempDir, 'review.json');
    await writeFile(inputPath, JSON.stringify({
      version: 1,
      blueprints: [
        {
          id: 'bp_review_backend_diff',
          title: 'Review backend diff',
          goal: 'Review backend code changes before merging.',
          trigger: {
            title: 'Review backend diff',
            patterns: ['review diff', 'review backend diff'],
            tags: ['review', 'backend']
          },
          preconditions: [
            { description: 'A git diff is available.', required: true }
          ],
          steps: [
            {
              id: 'scan_scope',
              title: 'Scan scope',
              instruction: 'Read git diff --stat and identify changed files.',
              kind: 'inspect',
              expectedEvidence: ['changed files identified'],
              nextStepId: 'report_findings'
            },
            {
              id: 'report_findings',
              title: 'Report findings',
              instruction: 'Summarize the review verdict.',
              kind: 'communicate',
              expectedEvidence: ['review verdict reported']
            }
          ],
          branches: [],
          expectedEvidence: [
            { description: 'Diff inspected.', kind: 'tool_result', required: true },
            { description: 'Verdict reported.', kind: 'final_answer', required: true }
          ],
          failureModes: [
            { title: 'Review too shallow', signals: ['only diff stat inspected'], mitigation: 'Read the changed files.' }
          ],
          tags: ['review', 'backend']
        }
      ]
    }, null, 2));

    const result = await importBlueprintJson({
      inputPath,
      storeDirectory: join(tempDir, 'store'),
      sourceLabel: 'manual:json-import'
    });

    expect(result).toEqual({
      importedCount: 1,
      supersededCount: 0,
      importedIds: ['bp_review_backend_diff']
    });

    const index = JSON.parse(await readFile(join(tempDir, 'store', 'index.json'), 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(index.entries).toEqual([
      expect.objectContaining({
        id: 'bp_review_backend_diff',
        title: 'Review backend diff',
        source: 'manual:json-import',
        status: 'active',
        stats: {
          useCount: 0,
          successCount: 0,
          failureCount: 0
        },
        markdownPath: expect.stringContaining('bp_review_backend_diff.md')
      })
    ]);
  });

  it('rejects authoring JSON that includes runtime-only fields', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-import-'));
    tempDirs.push(tempDir);

    const inputPath = join(tempDir, 'invalid.json');
    await writeFile(inputPath, JSON.stringify({
      version: 1,
      blueprints: [
        {
          id: 'bp_invalid',
          title: 'Invalid blueprint',
          goal: 'Should fail.',
          trigger: {
            title: 'Invalid blueprint',
            patterns: ['invalid'],
            tags: []
          },
          preconditions: [],
          steps: [
            {
              id: 'step_1',
              title: 'Step 1',
              instruction: 'Do something.',
              kind: 'inspect'
            }
          ],
          branches: [],
          expectedEvidence: [],
          failureModes: [],
          tags: [],
          stats: {
            useCount: 10,
            successCount: 5,
            failureCount: 5
          }
        }
      ]
    }, null, 2));

    await expect(importBlueprintJson({
      inputPath,
      storeDirectory: join(tempDir, 'store')
    })).rejects.toThrow('must not include runtime-only field "stats"');
  });

  it('rejects blueprints whose step references point to missing steps', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-import-'));
    tempDirs.push(tempDir);

    const inputPath = join(tempDir, 'broken-ref.json');
    await writeFile(inputPath, JSON.stringify({
      version: 1,
      blueprints: [
        {
          id: 'bp_broken_ref',
          title: 'Broken step ref',
          goal: 'Should fail.',
          trigger: {
            title: 'Broken step ref',
            patterns: ['broken ref'],
            tags: []
          },
          preconditions: [],
          steps: [
            {
              id: 'step_1',
              title: 'Step 1',
              instruction: 'Do something.',
              kind: 'inspect',
              nextStepId: 'missing_step'
            }
          ],
          branches: [],
          expectedEvidence: [],
          failureModes: [],
          tags: []
        }
      ]
    }, null, 2));

    await expect(importBlueprintJson({
      inputPath,
      storeDirectory: join(tempDir, 'store')
    })).rejects.toThrow('nextStepId "missing_step" does not exist');
  });

  it('supersedes an older blueprint when supersedesBlueprintId is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'blueprint-import-'));
    tempDirs.push(tempDir);

    const baseInputPath = join(tempDir, 'base.json');
    await writeFile(baseInputPath, JSON.stringify({
      version: 1,
      blueprints: [
        {
          id: 'bp_old',
          title: 'Old review blueprint',
          goal: 'Old flow.',
          trigger: {
            title: 'Old review blueprint',
            patterns: ['old review'],
            tags: ['review']
          },
          preconditions: [],
          steps: [
            {
              id: 'step_1',
              title: 'Step 1',
              instruction: 'Inspect the diff.',
              kind: 'inspect'
            }
          ],
          branches: [],
          expectedEvidence: [],
          failureModes: [],
          tags: ['review']
        }
      ]
    }, null, 2));

    await importBlueprintJson({
      inputPath: baseInputPath,
      storeDirectory: join(tempDir, 'store')
    });

    const nextInputPath = join(tempDir, 'next.json');
    await writeFile(nextInputPath, JSON.stringify({
      version: 1,
      blueprints: [
        {
          id: 'bp_new',
          title: 'New review blueprint',
          goal: 'New flow.',
          supersedesBlueprintId: 'bp_old',
          trigger: {
            title: 'New review blueprint',
            patterns: ['new review'],
            tags: ['review']
          },
          preconditions: [],
          steps: [
            {
              id: 'step_1',
              title: 'Step 1',
              instruction: 'Inspect the diff carefully.',
              kind: 'inspect'
            }
          ],
          branches: [],
          expectedEvidence: [],
          failureModes: [],
          tags: ['review']
        }
      ]
    }, null, 2));

    const result = await importBlueprintJson({
      inputPath: nextInputPath,
      storeDirectory: join(tempDir, 'store')
    });

    expect(result).toEqual({
      importedCount: 1,
      supersededCount: 1,
      importedIds: ['bp_new']
    });

    const index = JSON.parse(await readFile(join(tempDir, 'store', 'index.json'), 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bp_old', status: 'superseded' }),
      expect.objectContaining({ id: 'bp_new', status: 'active', supersedesBlueprintId: 'bp_old' })
    ]));
  });
});
