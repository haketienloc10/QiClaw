export type SessionMemoryType = 'fact' | 'procedure' | 'failure';
export type SessionMemoryFidelity = 'full' | 'summary' | 'essence' | 'hash';

export interface SessionMemoryEntry {
  hash: string;
  sessionId: string;
  memoryType: SessionMemoryType;
  fullText: string;
  summaryText: string;
  essenceText: string;
  tags: string[];
  source: string;
  sourceTurnId?: string;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  importance: number;
  explicitSave: boolean;
}

export interface SessionMemoryAccessStat {
  accessCount: number;
  lastAccessed: string;
}

export interface SessionMemoryMeta {
  version: number;
  engine: string;
  sessionId: string;
  memoryPath: string;
  metaPath: string;
  totalEntries: number;
  lastCompactedAt: string | null;
  lastVerifiedAt: string | null;
  lastDoctorAt: string | null;
  lastSealedAt: string | null;
  accessStatsByHash: Record<string, SessionMemoryAccessStat>;
}

export interface SessionMemoryCheckpointMetadata {
  storeSessionId: string;
  engine: string;
  version: number;
  memoryPath: string;
  metaPath: string;
  totalEntries: number;
  lastCompactedAt: string | null;
  latestSummaryText?: string;
}

export interface SessionMemoryCandidate extends SessionMemoryEntry {
  retrievalScore: number;
  finalScore: number;
  fidelity: SessionMemoryFidelity;
}

export interface SessionMemoryUriParts {
  sessionId: string;
  hash: string;
}

const SESSION_MEMORY_URI_PATTERN = /^mv2:\/\/sessions\/([^/]+)\/memory\/([^/]+)$/;

export function buildSessionMemoryUri(sessionId: string, hash: string): string {
  return `mv2://sessions/${sessionId}/memory/${hash}`;
}

export function parseSessionMemoryUri(uri: string): SessionMemoryUriParts | undefined {
  const match = SESSION_MEMORY_URI_PATTERN.exec(uri);

  if (!match) {
    return undefined;
  }

  return {
    sessionId: match[1],
    hash: match[2]
  };
}
