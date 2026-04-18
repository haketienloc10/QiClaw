import { describe, expect, it } from 'vitest';

import { EmbeddingSessionStore } from '../../src/memory/embeddingSessionStore.js';
import { FileSessionStore } from '../../src/memory/fileSessionStore.js';
import { createSessionMemoryStore } from '../../src/memory/memoryStoreFactory.js';

describe('createSessionMemoryStore', () => {
  it('returns the lexical file session store when no embedding config is provided', () => {
    const store = createSessionMemoryStore({
      cwd: '/tmp/demo',
      sessionId: 'session_1'
    });

    expect(store).toBeInstanceOf(FileSessionStore);
  });

  it('returns the embedding session store when ollama embedding config is provided', () => {
    const store = createSessionMemoryStore({
      cwd: '/tmp/demo',
      sessionId: 'session_1',
      memoryConfig: {
        provider: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434'
      }
    });

    expect(store).toBeInstanceOf(EmbeddingSessionStore);
  });
});
