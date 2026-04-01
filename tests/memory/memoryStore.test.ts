import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryStore } from '../../src/memory/memoryStore.js';
import { renderRecalledMemories } from '../../src/memory/recall.js';

describe('MemoryStore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('saves memories and recalls LIKE matches in deterministic order', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memory-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'memory.sqlite');
    const store = new MemoryStore(filename);

    store.save({
      kind: 'procedure',
      content: 'Always run npm test before build.',
      source: 'task-06',
      createdAt: '2026-03-30T10:00:00.000Z'
    });
    store.save({
      kind: 'fact',
      content: 'User prefers Vietnamese responses.',
      source: 'profile',
      createdAt: '2026-03-30T10:01:00.000Z'
    });
    store.save({
      kind: 'failure',
      content: 'Build failed when tests were skipped.',
      source: 'postmortem',
      createdAt: '2026-03-30T10:02:00.000Z'
    });

    const recalled = store.recall('test build', 5);

    expect(recalled).toEqual([
      {
        id: 1,
        kind: 'procedure',
        content: 'Always run npm test before build.',
        source: 'task-06',
        createdAt: '2026-03-30T10:00:00.000Z'
      },
      {
        id: 3,
        kind: 'failure',
        content: 'Build failed when tests were skipped.',
        source: 'postmortem',
        createdAt: '2026-03-30T10:02:00.000Z'
      }
    ]);
  });

  it('persists saved memories across store instances and respects the recall limit', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memory-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'memory.sqlite');
    const store = new MemoryStore(filename);

    store.save({
      kind: 'fact',
      content: 'Node runtime uses ESM imports.',
      source: 'codebase',
      createdAt: '2026-03-30T11:00:00.000Z'
    });
    store.save({
      kind: 'procedure',
      content: 'Runtime commands should keep ESM .js suffixes.',
      source: 'codebase',
      createdAt: '2026-03-30T11:01:00.000Z'
    });

    const reloadedStore = new MemoryStore(filename);

    expect(reloadedStore.recall('runtime', 1)).toEqual([
      {
        id: 1,
        kind: 'fact',
        content: 'Node runtime uses ESM imports.',
        source: 'codebase',
        createdAt: '2026-03-30T11:00:00.000Z'
      }
    ]);
  });

  it('recalls using a deterministic normalized form for non-ASCII text', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memory-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'memory.sqlite');
    const store = new MemoryStore(filename);

    store.save({
      kind: 'fact',
      content: 'Người dùng thích trả lời bằng tiếng Việt.',
      source: 'profile',
      createdAt: '2026-03-30T12:00:00.000Z'
    });

    expect(store.recall('VIỆT', 5)).toEqual([
      {
        id: 1,
        kind: 'fact',
        content: 'Người dùng thích trả lời bằng tiếng Việt.',
        source: 'profile',
        createdAt: '2026-03-30T12:00:00.000Z'
      }
    ]);
  });

  it('treats underscores in recall queries as literal characters', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memory-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'memory.sqlite');
    const store = new MemoryStore(filename);

    store.save({
      kind: 'procedure',
      content: 'Use config_value for the persisted key.',
      source: 'config',
      createdAt: '2026-03-30T12:10:00.000Z'
    });
    store.save({
      kind: 'procedure',
      content: 'Use config-value for CLI flags only.',
      source: 'config',
      createdAt: '2026-03-30T12:11:00.000Z'
    });

    expect(store.recall('config_value', 5)).toEqual([
      {
        id: 1,
        kind: 'procedure',
        content: 'Use config_value for the persisted key.',
        source: 'config',
        createdAt: '2026-03-30T12:10:00.000Z'
      }
    ]);
  });
});

describe('renderRecalledMemories', () => {
  it('renders recalled memories into deterministic prompt text grouped by kind labels', () => {
    expect(renderRecalledMemories([
      {
        id: 2,
        kind: 'fact',
        content: 'User prefers Vietnamese responses.',
        source: 'profile',
        createdAt: '2026-03-30T10:01:00.000Z'
      },
      {
        id: 3,
        kind: 'procedure',
        content: 'Use TDD for new runtime features.',
        source: 'process',
        createdAt: '2026-03-30T10:02:00.000Z'
      },
      {
        id: 4,
        kind: 'failure',
        content: 'Skipping typecheck caused avoidable regressions.',
        source: 'postmortem',
        createdAt: '2026-03-30T10:03:00.000Z'
      }
    ])).toBe([
      'Memory:',
      '- Fact: User prefers Vietnamese responses. (source: profile)',
      '- Procedure: Use TDD for new runtime features. (source: process)',
      '- Failure: Skipping typecheck caused avoidable regressions. (source: postmortem)'
    ].join('\n'));
  });

  it('returns an empty string when nothing was recalled', () => {
    expect(renderRecalledMemories([])).toBe('');
  });
});
