import { describe, expect, it } from 'vitest';

import {
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
    expect(getSessionMemoryPath(cwd, sessionId)).toBe('/workspace/qiclaw/.qiclaw/sessions/session_123/memory.mv2');
    expect(getSessionMemoryMetaPath(cwd, sessionId)).toBe('/workspace/qiclaw/.qiclaw/sessions/session_123/memory.meta.json');
    expect(getSessionMemoryArtifactPaths(cwd, sessionId)).toEqual({
      directoryPath: '/workspace/qiclaw/.qiclaw/sessions/session_123',
      memoryPath: '/workspace/qiclaw/.qiclaw/sessions/session_123/memory.mv2',
      metaPath: '/workspace/qiclaw/.qiclaw/sessions/session_123/memory.meta.json'
    });
  });
});
