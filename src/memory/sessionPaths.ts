import { join } from 'node:path';

export interface SessionMemoryArtifactPaths {
  directoryPath: string;
  memoryPath: string;
  metaPath: string;
}

export function getSessionDirectoryPath(cwd: string, sessionId: string): string {
  return join(cwd, '.qiclaw', 'sessions', sessionId);
}

export function getSessionMemoryPath(cwd: string, sessionId: string): string {
  return join(getSessionDirectoryPath(cwd, sessionId), 'memory.mv2');
}

export function getSessionMemoryMetaPath(cwd: string, sessionId: string): string {
  return join(getSessionDirectoryPath(cwd, sessionId), 'memory.meta.json');
}

export function getSessionMemoryArtifactPaths(cwd: string, sessionId: string): SessionMemoryArtifactPaths {
  return {
    directoryPath: getSessionDirectoryPath(cwd, sessionId),
    memoryPath: getSessionMemoryPath(cwd, sessionId),
    metaPath: getSessionMemoryMetaPath(cwd, sessionId)
  };
}
