import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../../src/session/checkpointStore.js';
import { createInteractiveCheckpointJson } from '../../src/session/session.js';

describe('CheckpointStore', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('saves and reloads the latest checkpoint for a session id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'checkpoint.sqlite');
    const store = new CheckpointStore(filename);

    store.save({
      sessionId: 's1',
      taskId: 't1',
      status: 'running',
      checkpointJson: '{"step":1}'
    });

    const reloadedStore = new CheckpointStore(filename);
    const checkpoint = reloadedStore.getBySessionId('s1');

    expect(checkpoint).toMatchObject({
      sessionId: 's1',
      taskId: 't1',
      status: 'running',
      checkpointJson: '{"step":1}'
    });
    expect(checkpoint?.updatedAt).toBeTypeOf('string');
  });

  it('overwrites the stored checkpoint when the same session id is saved again', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'checkpoint.sqlite');
    const store = new CheckpointStore(filename);

    store.save({
      sessionId: 's1',
      taskId: 't1',
      status: 'running',
      checkpointJson: '{"step":1}'
    });

    store.save({
      sessionId: 's1',
      taskId: 't2',
      status: 'completed',
      checkpointJson: '{"step":2}'
    });

    const reloadedStore = new CheckpointStore(filename);
    const checkpoint = reloadedStore.getBySessionId('s1');

    expect(checkpoint).toMatchObject({
      sessionId: 's1',
      taskId: 't2',
      status: 'completed',
      checkpointJson: '{"step":2}'
    });
  });

  it('returns the latest checkpoint across sessions ordered by updatedAt', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'checkpoint.sqlite');
    const store = new CheckpointStore(filename);

    store.save({
      sessionId: 'older-session',
      taskId: 't1',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [],
        historySummary: 'older summary'
      }),
      updatedAt: '2026-03-30T10:00:00.000Z'
    });

    store.save({
      sessionId: 'newer-session',
      taskId: 't2',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [],
        historySummary: 'newer summary'
      }),
      updatedAt: '2026-03-30T11:00:00.000Z'
    });

    const checkpoint = store.getLatest();

    expect(checkpoint).toMatchObject({
      sessionId: 'newer-session',
      taskId: 't2',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [],
        historySummary: 'newer summary'
      }),
      updatedAt: '2026-03-30T11:00:00.000Z'
    });
  });

  it('returns the same latest checkpoint when updatedAt ties by using session id as a secondary sort key', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'checkpoint.sqlite');
    const store = new CheckpointStore(filename);

    store.save({
      sessionId: 'alpha-session',
      taskId: 't1',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [],
        historySummary: 'alpha summary'
      }),
      updatedAt: '2026-03-30T11:00:00.000Z'
    });

    store.save({
      sessionId: 'omega-session',
      taskId: 't2',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [],
        historySummary: 'omega summary'
      }),
      updatedAt: '2026-03-30T11:00:00.000Z'
    });

    expect(store.getLatest()).toMatchObject({
      sessionId: 'omega-session',
      taskId: 't2',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [],
        historySummary: 'omega summary'
      }),
      updatedAt: '2026-03-30T11:00:00.000Z'
    });
  });

  it('returns undefined when the session id does not exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'checkpoint-store-'));
    tempDirs.push(tempDir);

    const store = new CheckpointStore(join(tempDir, 'checkpoint.sqlite'));

    expect(store.getBySessionId('missing-session')).toBeUndefined();
  });
});
