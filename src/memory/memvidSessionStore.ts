import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { create, open, type FindResult, type Memvid } from '@memvid/sdk';

import { getSessionMemoryArtifactPaths, type SessionMemoryArtifactPaths } from './sessionPaths.js';
import {
  buildSessionMemoryUri,
  parseSessionMemoryUri,
  type SessionMemoryCandidate,
  type SessionMemoryEntry,
  type SessionMemoryMeta
} from './sessionMemoryTypes.js';
import { isHashPrefixMatch } from './hash.js';

export interface MemvidSessionStoreOptions {
  cwd: string;
  sessionId: string;
}

export interface MemvidSessionFindOptions {
  k: number;
}

const META_VERSION = 1;
const META_ENGINE = 'memvid-session-store';

export class MemvidSessionStore {
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly artifactPaths: SessionMemoryArtifactPaths;
  private memvid?: Memvid;

  constructor(options: MemvidSessionStoreOptions) {
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.artifactPaths = getSessionMemoryArtifactPaths(options.cwd, options.sessionId);
  }

  paths(): SessionMemoryArtifactPaths {
    return this.artifactPaths;
  }

  memvidInstance(): Memvid | undefined {
    return this.memvid;
  }

  async open(): Promise<void> {
    await mkdir(this.artifactPaths.directoryPath, { recursive: true });
    this.memvid = existsSync(this.artifactPaths.memoryPath)
      ? await open(this.artifactPaths.memoryPath, 'basic', { enableLex: true, enableVec: false })
      : await create(this.artifactPaths.memoryPath, 'basic', { enableLex: true, enableVec: false });
    await this.writeMeta(await this.readMeta());
  }

  async readMeta(): Promise<SessionMemoryMeta> {
    if (!existsSync(this.artifactPaths.metaPath)) {
      return buildDefaultMeta(this.sessionId, this.artifactPaths);
    }

    try {
      const parsed = JSON.parse(await readFile(this.artifactPaths.metaPath, 'utf8')) as Partial<SessionMemoryMeta>;
      return mergeMeta(buildDefaultMeta(this.sessionId, this.artifactPaths), parsed);
    } catch {
      return buildDefaultMeta(this.sessionId, this.artifactPaths);
    }
  }

  async writeMeta(meta: SessionMemoryMeta): Promise<void> {
    await writeFile(this.artifactPaths.metaPath, JSON.stringify(meta, null, 2));
  }

  async put(entry: SessionMemoryEntry): Promise<string> {
    const memvid = this.requireMemvid();
    const uri = buildSessionMemoryUri(entry.sessionId, entry.hash);
    const result = await memvid.put({
      title: entry.summaryText,
      text: serializeEntry(entry),
      uri,
      kind: entry.memoryType,
      track: `session:${entry.sessionId}`,
      tags: entry.tags,
      searchText: buildSearchText(entry),
      timestamp: toMemvidTimestamp(entry.createdAt),
      metadata: {
        hash: entry.hash,
        sessionId: entry.sessionId,
        memoryType: entry.memoryType,
        summaryText: entry.summaryText,
        essenceText: entry.essenceText,
        source: entry.source,
        sourceTurnId: entry.sourceTurnId,
        createdAt: entry.createdAt,
        lastAccessed: entry.lastAccessed,
        accessCount: entry.accessCount,
        importance: entry.importance,
        explicitSave: entry.explicitSave
      }
    });
    const meta = await this.readMeta();
    await this.writeMeta({
      ...meta,
      totalEntries: meta.totalEntries + 1
    });
    return result;
  }

  async seal(): Promise<void> {
    await this.requireMemvid().seal();
    const meta = await this.readMeta();
    await this.writeMeta({
      ...meta,
      lastSealedAt: new Date().toISOString()
    });
  }

  async find(query: string, options: MemvidSessionFindOptions): Promise<FindResult> {
    return this.requireMemvid().find(query, {
      k: options.k,
      scope: `mv2://sessions/${this.sessionId}/`,
      mode: 'lex'
    });
  }

  async recall(query: string, options: MemvidSessionFindOptions): Promise<SessionMemoryCandidate[]> {
    const result = await this.find(query, options);
    const meta = await this.readMeta();
    const candidates = result.hits
      .filter((hit) => hit.track === `session:${this.sessionId}`)
      .map((hit) => toSessionMemoryCandidate(hit, this.sessionId, meta));

    return candidates.filter((candidate): candidate is SessionMemoryCandidate => candidate !== undefined);
  }

  async recallByHashPrefix(prefix: string, options: MemvidSessionFindOptions): Promise<SessionMemoryCandidate[]> {
    const normalizedPrefix = prefix.trim().toLowerCase();

    if (normalizedPrefix.length === 0) {
      return [];
    }

    const meta = await this.readMeta();
    const timeline = await this.requireMemvid().timeline({
      limit: Math.max(options.k, meta.totalEntries)
    });
    const matchedHashes = timeline
      .map((entry) => parseSessionMemoryUri(entry.uri))
      .filter((parts): parts is { sessionId: string; hash: string } => parts !== undefined)
      .filter((parts) => parts.sessionId === this.sessionId && isHashPrefixMatch(parts.hash, normalizedPrefix))
      .map((parts) => parts.hash)
      .slice(0, options.k);

    if (matchedHashes.length === 0) {
      return [];
    }

    const candidates: SessionMemoryCandidate[] = [];

    for (const hash of matchedHashes) {
      const result = await this.find(hash, { k: 1 });
      const candidate = result.hits
        .filter((hit) => hit.track === `session:${this.sessionId}`)
        .map((hit) => toSessionMemoryCandidate(hit, this.sessionId, meta))
        .find((match): match is SessionMemoryCandidate => match !== undefined && match.hash === hash);

      if (candidate) {
        candidates.push(candidate);
      }
    }

    return candidates;
  }

  async touchByHashes(hashes: string[], now = new Date().toISOString()): Promise<string[]> {
    const normalized = [...new Set(hashes.map((hash) => hash.trim().toLowerCase()).filter(Boolean))];

    if (normalized.length === 0) {
      return [];
    }

    const meta = await this.readMeta();

    for (const hash of normalized) {
      const current = meta.accessStatsByHash[hash];
      meta.accessStatsByHash[hash] = {
        accessCount: (current?.accessCount ?? 0) + 1,
        lastAccessed: now
      };
    }

    await this.writeMeta(meta);
    return normalized;
  }

  private requireMemvid(): Memvid {
    if (!this.memvid) {
      throw new Error('MemvidSessionStore must be opened before use.');
    }

    return this.memvid;
  }
}

function buildDefaultMeta(sessionId: string, artifactPaths: SessionMemoryArtifactPaths): SessionMemoryMeta {
  return {
    version: META_VERSION,
    engine: META_ENGINE,
    sessionId,
    memoryPath: artifactPaths.memoryPath,
    metaPath: artifactPaths.metaPath,
    totalEntries: 0,
    lastCompactedAt: null,
    lastVerifiedAt: null,
    lastDoctorAt: null,
    lastSealedAt: null,
    accessStatsByHash: {}
  };
}

function mergeMeta(base: SessionMemoryMeta, parsed: Partial<SessionMemoryMeta>): SessionMemoryMeta {
  const accessStatsByHash: SessionMemoryMeta['accessStatsByHash'] = {};

  for (const [hash, stat] of Object.entries(parsed.accessStatsByHash ?? {})) {
    if (!stat || typeof stat !== 'object' || typeof stat.lastAccessed !== 'string') {
      continue;
    }

    accessStatsByHash[hash.toLowerCase()] = {
      accessCount: typeof stat.accessCount === 'number' ? stat.accessCount : 0,
      lastAccessed: stat.lastAccessed
    };
  }

  return {
    version: typeof parsed.version === 'number' ? parsed.version : base.version,
    engine: typeof parsed.engine === 'string' ? parsed.engine : base.engine,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : base.sessionId,
    memoryPath: typeof parsed.memoryPath === 'string' ? parsed.memoryPath : base.memoryPath,
    metaPath: typeof parsed.metaPath === 'string' ? parsed.metaPath : base.metaPath,
    totalEntries: typeof parsed.totalEntries === 'number' ? parsed.totalEntries : base.totalEntries,
    lastCompactedAt: typeof parsed.lastCompactedAt === 'string' || parsed.lastCompactedAt === null ? parsed.lastCompactedAt : base.lastCompactedAt,
    lastVerifiedAt: typeof parsed.lastVerifiedAt === 'string' || parsed.lastVerifiedAt === null ? parsed.lastVerifiedAt : base.lastVerifiedAt,
    lastDoctorAt: typeof parsed.lastDoctorAt === 'string' || parsed.lastDoctorAt === null ? parsed.lastDoctorAt : base.lastDoctorAt,
    lastSealedAt: typeof parsed.lastSealedAt === 'string' || parsed.lastSealedAt === null ? parsed.lastSealedAt : base.lastSealedAt,
    accessStatsByHash
  };
}

function buildSearchText(entry: SessionMemoryEntry): string {
  return [entry.hash, entry.summaryText, entry.essenceText, entry.tags.join(' '), entry.fullText].filter(Boolean).join('\n');
}

const ENVELOPE_PREFIX = 'QICLAW_SESSION_MEMORY::';

function serializeEntry(entry: SessionMemoryEntry): string {
  return `${ENVELOPE_PREFIX}${JSON.stringify(entry)}`;
}

function deserializeEntry(value: string): SessionMemoryEntry | undefined {
  const payload = value.startsWith(ENVELOPE_PREFIX) ? value.slice(ENVELOPE_PREFIX.length) : undefined;

  if (payload) {
    try {
      const parsed = JSON.parse(payload) as Partial<SessionMemoryEntry>;

      if (
        typeof parsed.hash === 'string' &&
        typeof parsed.sessionId === 'string' &&
        typeof parsed.fullText === 'string' &&
        typeof parsed.summaryText === 'string' &&
        typeof parsed.essenceText === 'string' &&
        typeof parsed.source === 'string' &&
        typeof parsed.createdAt === 'string' &&
        typeof parsed.lastAccessed === 'string' &&
        typeof parsed.accessCount === 'number' &&
        typeof parsed.importance === 'number' &&
        typeof parsed.explicitSave === 'boolean' &&
        Array.isArray(parsed.tags)
      ) {
        return {
          hash: parsed.hash,
          sessionId: parsed.sessionId,
          memoryType: readMemoryType(parsed.memoryType),
          fullText: parsed.fullText,
          summaryText: parsed.summaryText,
          essenceText: parsed.essenceText,
          tags: parsed.tags.filter((tag): tag is string => typeof tag === 'string'),
          source: parsed.source,
          sourceTurnId: typeof parsed.sourceTurnId === 'string' ? parsed.sourceTurnId : undefined,
          createdAt: parsed.createdAt,
          lastAccessed: parsed.lastAccessed,
          accessCount: parsed.accessCount,
          importance: parsed.importance,
          explicitSave: parsed.explicitSave
        };
      }
    } catch {
      // Fall through to text parsing.
    }
  }

  const metadata = extractMetadataLines(value);
  const hash = metadata.hash;
  const sessionId = metadata.sessionId;
  const summaryText = metadata.summaryText;
  const essenceText = metadata.essenceText;
  const source = metadata.source;
  const createdAt = metadata.createdAt;
  const lastAccessed = metadata.lastAccessed;

  if (!hash || !sessionId || !summaryText || !essenceText || !source || !createdAt || !lastAccessed) {
    return undefined;
  }

  return {
    hash,
    sessionId,
    memoryType: readMemoryType(metadata.memoryType),
    fullText: summaryText,
    summaryText,
    essenceText,
    tags: metadata.tags ? metadata.tags.split(/\s+/).filter(Boolean) : [],
    source,
    sourceTurnId: metadata.sourceTurnId,
    createdAt,
    lastAccessed,
    accessCount: metadata.accessCount ? Number(metadata.accessCount) || 0 : 0,
    importance: metadata.importance ? Number(metadata.importance) || 0 : 0,
    explicitSave: metadata.explicitSave === 'true'
  };
}

function readMemoryType(value: unknown): SessionMemoryEntry['memoryType'] {
  return value === 'procedure' || value === 'failure' ? value : 'fact';
}

function extractMetadataLines(value: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const pattern = /([A-Za-z][A-Za-z0-9_]*):\s*("[^"]*"|\{[^}]*\}|[^:]+?)(?=\s+[A-Za-z][A-Za-z0-9_]*:\s*|$)/g;

  for (const match of value.matchAll(pattern)) {
    metadata[match[1]] = stripQuoted(match[2].trim());
  }

  return metadata;
}

function stripQuoted(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function toMemvidTimestamp(value: string): number | string {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return value;
  }

  return Math.floor(timestamp / 1000);
}

function toSessionMemoryCandidate(
  hit: FindResult['hits'][number],
  sessionId: string,
  meta: SessionMemoryMeta
): SessionMemoryCandidate | undefined {
  const uriParts = typeof hit.uri === 'string' ? parseSessionMemoryUri(hit.uri) : undefined;

  if (!uriParts || uriParts.sessionId !== sessionId) {
    return undefined;
  }

  const rawText = 'text' in hit && typeof hit.text === 'string' && hit.text.length > 0
    ? hit.text
    : hit.snippet;
  const parsed = deserializeEntry(rawText);

  if (!parsed || parsed.sessionId !== sessionId || parsed.hash !== uriParts.hash) {
    return undefined;
  }

  const stat = meta.accessStatsByHash[parsed.hash.toLowerCase()];

  return {
    ...parsed,
    lastAccessed: stat?.lastAccessed ?? parsed.lastAccessed,
    accessCount: stat?.accessCount ?? parsed.accessCount,
    retrievalScore: typeof hit.score === 'number' ? hit.score : 0,
    finalScore: 0,
    fidelity: 'summary'
  };
}
