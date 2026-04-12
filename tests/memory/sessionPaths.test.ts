import { describe, expect, it } from 'vitest';

import {
  getGlobalMemoryArtifactPaths,
  getSessionDirectoryPath,
  getSessionMemoryArtifactPaths,
  getSessionMemoryMetaPath,
  getSessionMemoryPath
} from '../../src/memory/sessionPaths.js';

describe('session memory paths', () => {
  it('derives all session-scoped memory artifact paths under .qiclaw/sessions/<sessionId>', () => {
    const cwd = '/workspace/qiclaw';
    const sessionId = 'session_123';

    expect(getSessionDirectoryPath(cwd, sessionId)).toBe('/workspace/qiclaw/.qiclaw/sessions/session_123');
    expect(getSessionMemoryPath(cwd, sessionId)).toBe('/workspace/qiclaw/.qiclaw/sessions/session_123/memory/index.json');
    expect(getSessionMemoryMetaPath(cwd, sessionId)).toBe('/workspace/qiclaw/.qiclaw/sessions/session_123/memory/meta.json');
    expect(getSessionMemoryArtifactPaths(cwd, sessionId)).toEqual({
      directoryPath: '/workspace/qiclaw/.qiclaw/sessions/session_123/memory',
      memoryPath: '/workspace/qiclaw/.qiclaw/sessions/session_123/memory/index.json',
      metaPath: '/workspace/qiclaw/.qiclaw/sessions/session_123/memory/meta.json'
    });
  });

  it('derives user-global memory artifact paths outside the repo', () => {
    expect(getGlobalMemoryArtifactPaths({ baseDirectory: '/home/alice/.qiclaw/memory/global' })).toEqual({
      directoryPath: '/home/alice/.qiclaw/memory/global',
      memoryPath: '/home/alice/.qiclaw/memory/global/index.json',
      metaPath: '/home/alice/.qiclaw/memory/global/meta.json'
    });
  });
});
