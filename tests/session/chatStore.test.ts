import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../../src/session/checkpointStore.js';
import { createInteractiveCheckpointJson } from '../../src/session/session.js';

describe('CheckpointStore chat sessions', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates and lists chat sessions for sidebar rendering', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chat-store-'));
    tempDirs.push(tempDir);

    const store = new CheckpointStore(join(tempDir, 'checkpoint.sqlite'));
    store.createChatSession({
      sessionId: 'chat-1',
      title: 'First chat',
      provider: 'anthropic',
      model: 'claude-opus-4-6'
    });
    store.createChatSession({
      sessionId: 'chat-2',
      title: 'Second chat',
      provider: 'openai',
      model: 'gpt-4.1'
    });

    expect(store.listChatSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'chat-2',
        title: 'Second chat',
        provider: 'openai',
        model: 'gpt-4.1'
      }),
      expect.objectContaining({
        sessionId: 'chat-1',
        title: 'First chat',
        provider: 'anthropic',
        model: 'claude-opus-4-6'
      })
    ]);
  });

  it('renames, updates, and deletes chat sessions', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chat-store-'));
    tempDirs.push(tempDir);

    const store = new CheckpointStore(join(tempDir, 'checkpoint.sqlite'));
    store.createChatSession({
      sessionId: 'chat-1',
      title: 'Old title',
      provider: 'anthropic',
      model: 'claude-opus-4-6'
    });

    store.renameChatSession('chat-1', 'New title');
    store.touchChatSession('chat-1', {
      provider: 'openai',
      model: 'gpt-4.1-mini'
    });

    expect(store.getChatSession('chat-1')).toEqual(expect.objectContaining({
      sessionId: 'chat-1',
      title: 'New title',
      provider: 'openai',
      model: 'gpt-4.1-mini'
    }));

    store.deleteChatSession('chat-1');
    expect(store.getChatSession('chat-1')).toBeUndefined();
  });

  it('imports the latest legacy checkpoint as an initial chat session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'chat-store-'));
    tempDirs.push(tempDir);

    const store = new CheckpointStore(join(tempDir, 'checkpoint.sqlite'));
    store.save({
      sessionId: 'legacy-session',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [{ role: 'user', content: 'Explain the app architecture' }],
        historySummary: 'Architecture discussion'
      }),
      updatedAt: '2026-04-02T10:00:00.000Z'
    });

    const imported = store.importLatestLegacyCheckpointAsChat();

    expect(imported).toEqual(expect.objectContaining({
      sessionId: 'legacy-session',
      title: 'Explain the app architecture',
      provider: 'anthropic'
    }));
    expect(store.listChatSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'legacy-session',
        title: 'Explain the app architecture'
      })
    ]);
  });
});
