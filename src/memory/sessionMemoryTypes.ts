export type SessionMemoryType = 'fact' | 'workflow' | 'heuristic' | 'episode' | 'decision' | 'uncertainty';
export type SessionMemoryStatus = 'active' | 'superseded' | 'invalidated';
export type SessionMemoryFidelity = 'full' | 'summary' | 'essence' | 'hash';

export interface SessionMemoryEntry {
  hash: string;
  sessionId: string;
  kind: SessionMemoryType;
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

export interface PersistedSessionMemoryRecord extends SessionMemoryEntry {
  updatedAt: string;
  invalidatedAt?: string;
  status: SessionMemoryStatus;
  markdownPath: string;
  sourceContentHash?: string;
}

export interface BuildPersistedMemoryRecordInput extends SessionMemoryEntry {
  updatedAt?: string;
  invalidatedAt?: string;
  status?: SessionMemoryStatus;
  markdownPath: string;
  sourceContentHash?: string;
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

export interface SessionMemoryCandidate extends PersistedSessionMemoryRecord {
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

export function buildPersistedMemoryRecord(
  input: BuildPersistedMemoryRecordInput
): PersistedSessionMemoryRecord {
  return {
    ...input,
    updatedAt: input.updatedAt ?? input.createdAt,
    invalidatedAt: input.invalidatedAt ?? undefined,
    status: input.status ?? 'active'
  };
}

export function buildRecallCandidate(input: {
  record: PersistedSessionMemoryRecord;
  retrievalScore: number;
  finalScore: number;
  fidelity: SessionMemoryFidelity;
}): SessionMemoryCandidate {
  return {
    ...buildPersistedMemoryRecord(input.record),
    retrievalScore: input.retrievalScore,
    finalScore: input.finalScore,
    fidelity: input.fidelity
  };
}
