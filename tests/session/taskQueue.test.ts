import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { TaskQueue } from '../../src/session/taskQueue.js';

describe('TaskQueue', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('enqueues and claims the next pending task', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'task-queue-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'tasks.sqlite');
    const queue = new TaskQueue(filename);

    queue.enqueue({
      taskId: 't1',
      goal: 'inspect repo',
      payloadJson: '{}'
    });

    const claimedTask = queue.claimNext();

    expect(claimedTask).toMatchObject({
      taskId: 't1',
      goal: 'inspect repo',
      payloadJson: '{}',
      status: 'running'
    });
    expect(claimedTask?.createdAt).toBeTypeOf('string');
    expect(claimedTask?.updatedAt).toBeTypeOf('string');
  });

  it('claims pending tasks in FIFO order across reopen', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'task-queue-'));
    tempDirs.push(tempDir);

    const filename = join(tempDir, 'tasks.sqlite');
    const queue = new TaskQueue(filename);

    queue.enqueue({
      taskId: 't1',
      goal: 'inspect repo',
      payloadJson: '{"position":1}'
    });
    queue.enqueue({
      taskId: 't2',
      goal: 'summarize repo',
      payloadJson: '{"position":2}'
    });
    queue.enqueue({
      taskId: 't3',
      goal: 'write report',
      payloadJson: '{"position":3}'
    });

    const reopenedQueue = new TaskQueue(filename);

    expect(reopenedQueue.claimNext()).toMatchObject({
      taskId: 't1',
      status: 'running'
    });
    expect(reopenedQueue.claimNext()).toMatchObject({
      taskId: 't2',
      status: 'running'
    });
    expect(reopenedQueue.claimNext()).toMatchObject({
      taskId: 't3',
      status: 'running'
    });
    expect(reopenedQueue.claimNext()).toBeUndefined();
  });

  it('returns undefined when there is no pending task', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'task-queue-'));
    tempDirs.push(tempDir);

    const queue = new TaskQueue(join(tempDir, 'tasks.sqlite'));

    expect(queue.claimNext()).toBeUndefined();
  });
});
