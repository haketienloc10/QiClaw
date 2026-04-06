import { homedir } from 'node:os';
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

export function getGlobalMemoryBaseDirectory(): string {
  return process.env.QICLAW_GLOBAL_MEMORY_DIR?.trim() || join(homedir(), '.qiclaw', 'memory', 'global');
}

export function getGlobalMemoryArtifactPaths(options: { baseDirectory?: string } = {}): SessionMemoryArtifactPaths {
  const directoryPath = options.baseDirectory ?? getGlobalMemoryBaseDirectory();
  return {
    directoryPath,
    memoryPath: join(directoryPath, 'memory.mv2'),
    metaPath: join(directoryPath, 'memory.meta.json')
  };
}
