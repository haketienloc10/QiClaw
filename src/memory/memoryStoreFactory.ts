import type { MemoryEmbeddingConfig } from './memoryEmbeddingConfig.js';
import { EmbeddingGlobalMemoryStore } from './embeddingGlobalMemoryStore.js';
import { EmbeddingSessionStore } from './embeddingSessionStore.js';
import { FileSessionStore } from './fileSessionStore.js';
import { GlobalMemoryStore } from './globalMemoryStore.js';

export function createSessionMemoryStore(input: {
  cwd: string;
  sessionId: string;
  memoryConfig?: MemoryEmbeddingConfig;
}): FileSessionStore | EmbeddingSessionStore {
  if (input.memoryConfig) {
    return new EmbeddingSessionStore(input);
  }

  return new FileSessionStore(input);
}

export function createGlobalMemoryStore(input: {
  baseDirectory?: string;
  memoryConfig?: MemoryEmbeddingConfig;
} = {}): GlobalMemoryStore | EmbeddingGlobalMemoryStore {
  if (input.memoryConfig) {
    return new EmbeddingGlobalMemoryStore(input);
  }

  return new GlobalMemoryStore(input);
}
