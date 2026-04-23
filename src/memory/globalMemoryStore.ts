import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MemoryFindResult as FindResult } from './findResult.js';

import { getGlobalMemoryArtifactPaths, type SessionMemoryArtifactPaths } from './sessionPaths.js';
import {
  buildPersistedMemoryRecord,
  buildRecallCandidate,
  buildSessionMemoryUri,
  parseSessionMemoryUri,
  type PersistedSessionMemoryRecord,
  type SessionMemoryCandidate,
  type SessionMemoryEntry,
  type SessionMemoryMeta,
  type SessionMemoryStatus
} from './sessionMemoryTypes.js';
import type { MemoryEmbeddingConfig } from './memoryEmbeddingConfig.js';
import { sanitizeRecallQuery } from './recallQuerySanitizer.js';

export interface GlobalMemoryStoreOptions {
  baseDirectory?: string;
  memoryConfig?: MemoryEmbeddingConfig;
}

export interface GlobalMemoryFindOptions {
  k: number;
}

type GlobalMemoryIndexRecord = PersistedSessionMemoryRecord;

interface GlobalMemoryIndex {
  entries: GlobalMemoryIndexRecord[];
}

const GLOBAL_SESSION_ID = 'user-global';
const META_VERSION = 1;
const META_ENGINE = 'file-global-memory-store';
const TRACK = 'user-global';

export class GlobalMemoryStore {
  private readonly artifactPaths: SessionMemoryArtifactPaths;
  protected readonly memoryConfig?: MemoryEmbeddingConfig;

  constructor(options: GlobalMemoryStoreOptions = {}) {
    this.memoryConfig = options.memoryConfig;
    this.artifactPaths = getGlobalMemoryArtifactPaths(options.baseDirectory ? { baseDirectory: options.baseDirectory } : undefined);
  }

  paths(): SessionMemoryArtifactPaths {
    return this.artifactPaths;
  }

  storeInstance(): undefined {
    return undefined;
  }

  async open(): Promise<void> {
    await mkdir(this.artifactPaths.directoryPath, { recursive: true });
    await ensureIndexFile(this.artifactPaths.memoryPath);
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
    const globalEntry = { ...entry, sessionId: GLOBAL_SESSION_ID };
    const markdownPath = await writeMarkdownArtifact(this.artifactPaths.directoryPath, globalEntry);
    const sourceContentHash = await createSourceContentHash(markdownPath);
    const index = await this.readIndex();
    index.entries = [
      ...index.entries.filter((candidate) => candidate.hash !== globalEntry.hash),
      toIndexRecord(globalEntry, markdownPath, sourceContentHash)
    ];
    await this.writeIndex(index);

    const meta = await this.readMeta();
    await this.writeMeta({
      ...meta,
      totalEntries: index.entries.length
    });

    return buildSessionMemoryUri(GLOBAL_SESSION_ID, globalEntry.hash);
  }

  async seal(): Promise<void> {
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
        engine: META_ENGINE,
        hits: [],
        total_hits: 0,
        context: '',
        next_cursor: null,
        took_ms: 0
      } satisfies FindResult;
    }

    const startedAt = Date.now();
    const index = await this.readIndex();
    const tokens = tokenize(safeQuery);
    const hits = index.entries
      .filter((entry) => entry.status === 'active')
      .map((entry) => ({ entry, score: scoreIndexRecord(entry, tokens) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.importance - left.entry.importance)
      .slice(0, options.k)
      .map(({ entry, score }) => toFindHit(entry, score));

    return {
      query: safeQuery,
      engine: META_ENGINE,
      hits,
      total_hits: hits.length,
      context: '',
      next_cursor: null,
      took_ms: Date.now() - startedAt
    } satisfies FindResult;
  }

  async recall(query: string, options: GlobalMemoryFindOptions): Promise<SessionMemoryCandidate[]> {
    const result = await this.find(query, options);
    const meta = await this.readMeta();

    return result.hits
      .filter((hit) => hit.track === TRACK)
      .map((hit) => toGlobalMemoryCandidate(hit, meta))
      .filter((candidate): candidate is SessionMemoryCandidate => candidate !== undefined);
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

  async supersedeByHashes(hashes: string[], now = new Date().toISOString()): Promise<string[]> {
    return this.updateStatusesByHashes(hashes, 'superseded', now);
  }

  async invalidateByHashes(hashes: string[], now = new Date().toISOString()): Promise<string[]> {
    return this.updateStatusesByHashes(hashes, 'invalidated', now);
  }

  private async updateStatusesByHashes(
    hashes: string[],
    status: Exclude<SessionMemoryStatus, 'active'>,
    now: string
  ): Promise<string[]> {
    const normalized = [...new Set(hashes.map((hash) => hash.trim().toLowerCase()).filter(Boolean))];

    if (normalized.length === 0) {
      return [];
    }

    const index = await this.readIndex();
    let changed = false;
    index.entries = index.entries.map((entry) => {
      if (!normalized.includes(entry.hash.toLowerCase())) {
        return entry;
      }

      changed = true;
      return {
        ...entry,
        status,
        updatedAt: now,
        invalidatedAt: status === 'invalidated' ? now : entry.invalidatedAt
      };
    });

    if (changed) {
      await this.writeIndex(index);
    }

    return normalized;
  }

  private async readIndex(): Promise<GlobalMemoryIndex> {
    await ensureIndexFile(this.artifactPaths.memoryPath);

    try {
      const parsed = JSON.parse(await readFile(this.artifactPaths.memoryPath, 'utf8')) as Partial<GlobalMemoryIndex>;
      return {
        entries: Array.isArray(parsed.entries)
          ? parsed.entries.filter(isIndexRecord)
          : []
      };
    } catch {
      return { entries: [] };
    }
  }

  private async writeIndex(index: GlobalMemoryIndex): Promise<void> {
    await writeFile(this.artifactPaths.memoryPath, JSON.stringify(index, null, 2));
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

async function ensureIndexFile(memoryPath: string): Promise<void> {
  if (existsSync(memoryPath)) {
    return;
  }

  await writeFile(memoryPath, JSON.stringify({ entries: [] }, null, 2));
}

function toIndexRecord(
  entry: SessionMemoryEntry,
  markdownPath: string,
  sourceContentHash: string
): GlobalMemoryIndexRecord {
  return buildPersistedMemoryRecord({
    ...entry,
    sessionId: GLOBAL_SESSION_ID,
    tags: [...entry.tags],
    markdownPath,
    sourceContentHash
  });
}

function isIndexRecord(value: unknown): value is GlobalMemoryIndexRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.hash === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.kind === 'string'
    && typeof record.summaryText === 'string'
    && typeof record.essenceText === 'string'
    && typeof record.fullText === 'string'
    && Array.isArray(record.tags)
    && typeof record.source === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && (record.status === 'active' || record.status === 'superseded' || record.status === 'invalidated')
    && typeof record.lastAccessed === 'string'
    && typeof record.accessCount === 'number'
    && typeof record.importance === 'number'
    && typeof record.explicitSave === 'boolean'
    && typeof record.markdownPath === 'string'
    && (record.sourceContentHash === undefined || typeof record.sourceContentHash === 'string');
}

async function createSourceContentHash(markdownPath: string): Promise<string> {
  const markdownBytes = await readFile(markdownPath);
  return createHash('sha256').update(markdownBytes).digest('hex');
}

async function writeMarkdownArtifact(baseDirectoryPath: string, entry: SessionMemoryEntry): Promise<string> {
  const dateKey = toDateDirectory(entry.createdAt);
  const directoryPath = join(baseDirectoryPath, dateKey, entry.kind);
  const filePath = join(directoryPath, `${entry.hash}.md`);

  await mkdir(directoryPath, { recursive: true });
  await writeFile(filePath, renderMarkdownArtifact(entry));
  return filePath;
}

function toDateDirectory(createdAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/u.test(createdAt) ? createdAt.slice(0, 10) : 'unknown-date';
}

function renderMarkdownArtifact(entry: SessionMemoryEntry): string {
  const lines = [
    `# ${entry.summaryText}`,
    '',
    entry.fullText,
    '',
    `- Hash: ${entry.hash}`,
    `- Session: ${entry.sessionId}`,
    `- Type: ${entry.kind}`,
    `- Created at: ${entry.createdAt}`
  ];

  if (entry.tags.length > 0) {
    lines.push(`- Tags: ${entry.tags.join(', ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/\s+/u).map((token) => token.trim()).filter(Boolean);
}

function scoreIndexRecord(entry: GlobalMemoryIndexRecord, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  const haystack = [entry.summaryText, entry.essenceText, entry.fullText, entry.tags.join(' ')].join(' ').toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (!haystack.includes(token)) {
      continue;
    }

    score += 1;
    if (entry.summaryText.toLowerCase().includes(token)) {
      score += 1.5;
    }
    if (entry.essenceText.toLowerCase().includes(token)) {
      score += 1;
    }
    if (entry.tags.some((tag) => tag.toLowerCase().includes(token))) {
      score += 2;
    }
  }

  return score + entry.importance + Math.min(entry.accessCount * 0.1, 1);
}

function toFindHit(entry: GlobalMemoryIndexRecord, score: number): FindResult['hits'][number] {
  return {
    id: entry.hash,
    doc_id: entry.hash,
    score,
    uri: buildSessionMemoryUri(GLOBAL_SESSION_ID, entry.hash),
    title: entry.summaryText,
    text: JSON.stringify(entry),
    snippet: entry.fullText,
    track: TRACK,
    kind: entry.kind,
    tags: entry.tags,
    timestamp: entry.createdAt
  } as FindResult['hits'][number];
}

function toGlobalMemoryCandidate(hit: FindResult['hits'][number], meta: SessionMemoryMeta): SessionMemoryCandidate | undefined {
  const uriParts = typeof hit.uri === 'string' ? parseSessionMemoryUri(hit.uri) : undefined;

  if (!uriParts || uriParts.sessionId !== GLOBAL_SESSION_ID) {
    return undefined;
  }

  const rawText = 'text' in hit && typeof hit.text === 'string' && hit.text.length > 0
    ? hit.text
    : hit.snippet;

  try {
    const parsed = JSON.parse(rawText) as GlobalMemoryIndexRecord;
    if (!isIndexRecord(parsed) || parsed.hash !== uriParts.hash) {
      return undefined;
    }

    const stat = meta.accessStatsByHash[parsed.hash.toLowerCase()];
    return buildRecallCandidate({
      record: {
        ...parsed,
        lastAccessed: stat?.lastAccessed ?? parsed.lastAccessed,
        accessCount: stat?.accessCount ?? parsed.accessCount
      },
      retrievalScore: typeof hit.score === 'number' ? hit.score : 0,
      finalScore: 0,
      fidelity: 'summary'
    });
  } catch {
    return undefined;
  }
}
