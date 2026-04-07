import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { create, OllamaEmbeddings, open, type FindResult, type Memvid } from '@memvid/sdk';

import { getGlobalMemoryArtifactPaths, type SessionMemoryArtifactPaths } from './sessionPaths.js';
import {
  buildSessionMemoryUri,
  parseSessionMemoryUri,
  type SessionMemoryCandidate,
  type SessionMemoryEntry,
  type SessionMemoryMeta
} from './sessionMemoryTypes.js';
import { createMemoryEmbeddingIdentity, type MemoryEmbeddingConfig } from './memoryEmbeddingConfig.js';
import { sanitizeRecallQuery } from './recallQuerySanitizer.js';

export interface GlobalMemoryStoreOptions {
  baseDirectory?: string;
  memoryConfig?: MemoryEmbeddingConfig;
}

export interface GlobalMemoryFindOptions {
  k: number;
}

const GLOBAL_SESSION_ID = 'user-global';
const META_VERSION = 1;
const META_ENGINE = 'memvid-global-memory-store';
const TRACK = 'user-global';
const URI_SCOPE = `mv2://sessions/${GLOBAL_SESSION_ID}/`;
const ENVELOPE_PREFIX = 'QICLAW_GLOBAL_MEMORY::';

export class GlobalMemoryStore {
  private readonly artifactPaths: SessionMemoryArtifactPaths;
  private readonly memoryConfig?: MemoryEmbeddingConfig;
  private memvid?: Memvid;
  private embedder?: OllamaEmbeddings;

  constructor(options: GlobalMemoryStoreOptions = {}) {
    this.memoryConfig = options.memoryConfig;
    this.embedder = options.memoryConfig ? new OllamaEmbeddings({
      model: options.memoryConfig.model,
      baseUrl: options.memoryConfig.baseUrl
    }) : undefined;
    this.artifactPaths = getGlobalMemoryArtifactPaths(options.baseDirectory ? { baseDirectory: options.baseDirectory } : undefined);
  }

  paths(): SessionMemoryArtifactPaths {
    return this.artifactPaths;
  }

  memvidInstance(): Memvid | undefined {
    return this.memvid;
  }

  async open(): Promise<void> {
    await mkdir(this.artifactPaths.directoryPath, { recursive: true });
    const useVector = Boolean(this.embedder);
    const openOptions = {
      enableLex: true,
      enableVec: useVector
    };
    this.memvid = existsSync(this.artifactPaths.memoryPath)
      ? await open(this.artifactPaths.memoryPath, 'basic', openOptions)
      : await create(this.artifactPaths.memoryPath, 'basic', openOptions);
    await this.writeMeta(await this.readMeta());
  }

  async readMeta(): Promise<SessionMemoryMeta> {
    if (!existsSync(this.artifactPaths.metaPath)) {
      return buildDefaultMeta(this.artifactPaths);
    }

    try {
      const parsed = JSON.parse(await readFile(this.artifactPaths.metaPath, 'utf8')) as Partial<SessionMemoryMeta>;
      return mergeMeta(buildDefaultMeta(this.artifactPaths), parsed);
    } catch {
      return buildDefaultMeta(this.artifactPaths);
    }
  }

  async writeMeta(meta: SessionMemoryMeta): Promise<void> {
    await writeFile(this.artifactPaths.metaPath, JSON.stringify(meta, null, 2));
  }

  async put(entry: SessionMemoryEntry): Promise<string> {
    const memvid = this.requireMemvid();
    const globalEntry = { ...entry, sessionId: GLOBAL_SESSION_ID };
    const uri = buildSessionMemoryUri(GLOBAL_SESSION_ID, globalEntry.hash);
    const embedding = this.embedder ? await this.embedder.embedQuery(globalEntry.fullText) : undefined;
    const result = await memvid.put({
      title: globalEntry.summaryText,
      text: serializeEntry(globalEntry),
      uri,
      kind: globalEntry.memoryType,
      track: TRACK,
      tags: globalEntry.tags,
      searchText: buildSearchText(globalEntry),
      timestamp: toMemvidTimestamp(globalEntry.createdAt),
      enableEmbedding: Boolean(embedding),
      ...(embedding ? {
        embedding,
        embeddingIdentity: createMemoryEmbeddingIdentity(this.memoryConfig!, embedding.length)
      } : {}),
      metadata: {
        hash: globalEntry.hash,
        sessionId: GLOBAL_SESSION_ID,
        memoryType: globalEntry.memoryType,
        summaryText: globalEntry.summaryText,
        essenceText: globalEntry.essenceText,
        source: globalEntry.source,
        sourceTurnId: globalEntry.sourceTurnId,
        createdAt: globalEntry.createdAt,
        lastAccessed: globalEntry.lastAccessed,
        accessCount: globalEntry.accessCount,
        importance: globalEntry.importance,
        explicitSave: globalEntry.explicitSave
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

  async find(query: string, options: GlobalMemoryFindOptions): Promise<FindResult> {
    const safeQuery = sanitizeRecallQuery(query);

    if (!safeQuery) {
      return {
        query: safeQuery,
        engine: 'memvid-global-memory-store',
        hits: [],
        total_hits: 0,
        context: '',
        next_cursor: null,
        took_ms: 0
      } satisfies FindResult;
    }

    return this.requireMemvid().find(safeQuery, {
      k: options.k,
      scope: URI_SCOPE,
      mode: this.embedder ? 'auto' : 'lex',
      ...(this.embedder ? { embedder: this.embedder } : {})
    });
  }

  async recall(query: string, options: GlobalMemoryFindOptions): Promise<SessionMemoryCandidate[]> {
    const result = await this.find(query, options);
    const meta = await this.readMeta();
    const candidates = result.hits
      .filter((hit) => hit.track === TRACK)
      .map((hit) => toGlobalMemoryCandidate(hit, meta));

    return candidates.filter((candidate): candidate is SessionMemoryCandidate => candidate !== undefined);
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
      throw new Error('GlobalMemoryStore must be opened before use.');
    }

    return this.memvid;
  }
}

function buildDefaultMeta(artifactPaths: SessionMemoryArtifactPaths): SessionMemoryMeta {
  return {
    version: META_VERSION,
    engine: META_ENGINE,
    sessionId: GLOBAL_SESSION_ID,
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
    sessionId: GLOBAL_SESSION_ID,
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

function serializeEntry(entry: SessionMemoryEntry): string {
  return `${ENVELOPE_PREFIX}${JSON.stringify(entry)}`;
}

function deserializeEntry(value: string): SessionMemoryEntry | undefined {
  const payload = value.startsWith(ENVELOPE_PREFIX) ? value.slice(ENVELOPE_PREFIX.length) : undefined;

  if (!payload) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<SessionMemoryEntry>;

    if (
      typeof parsed.hash === 'string' &&
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
        sessionId: GLOBAL_SESSION_ID,
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
    return undefined;
  }

  return undefined;
}

function readMemoryType(value: unknown): SessionMemoryEntry['memoryType'] {
  return value === 'procedure' || value === 'failure' ? value : 'fact';
}

function toMemvidTimestamp(value: string): number | string {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return value;
  }

  return Math.floor(timestamp / 1000);
}

function toGlobalMemoryCandidate(hit: FindResult['hits'][number], meta: SessionMemoryMeta): SessionMemoryCandidate | undefined {
  const uriParts = typeof hit.uri === 'string' ? parseSessionMemoryUri(hit.uri) : undefined;

  if (!uriParts || uriParts.sessionId !== GLOBAL_SESSION_ID) {
    return undefined;
  }

  const rawText = 'text' in hit && typeof hit.text === 'string' && hit.text.length > 0
    ? hit.text
    : hit.snippet;
  const parsed = deserializeEntry(rawText);

  if (!parsed || parsed.hash !== uriParts.hash) {
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
