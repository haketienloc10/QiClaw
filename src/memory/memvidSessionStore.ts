import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { create, open, type FindResult, type Memvid } from '@memvid/sdk';

import { getSessionMemoryArtifactPaths, type SessionMemoryArtifactPaths } from './sessionPaths.js';
import {
  buildSessionMemoryUri,
  parseSessionMemoryUri,
  type SessionMemoryCandidate,
  type SessionMemoryEntry
} from './sessionMemoryTypes.js';

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

  async open(): Promise<void> {
    await mkdir(this.artifactPaths.directoryPath, { recursive: true });
    this.memvid = existsSync(this.artifactPaths.memoryPath)
      ? await open(this.artifactPaths.memoryPath, 'basic', { enableLex: true, enableVec: false })
      : await create(this.artifactPaths.memoryPath, 'basic', { enableLex: true, enableVec: false });
    await this.writeMeta();
  }

  async put(entry: SessionMemoryEntry): Promise<string> {
    const memvid = this.requireMemvid();
    const uri = buildSessionMemoryUri(entry.sessionId, entry.hash);

    return memvid.put({
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
  }

  async seal(): Promise<void> {
    await this.requireMemvid().seal();
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
    const candidates: Array<SessionMemoryCandidate | undefined> = result.hits
      .filter((hit) => hit.track === `session:${this.sessionId}`)
      .map((hit) => {
        const uriParts = parseSessionMemoryUri(hit.uri);

        if (!uriParts || uriParts.sessionId !== this.sessionId) {
          return undefined;
        }

        const hitText = (hit as typeof hit & { text?: string }).text;
        const entry = deserializeEntry(hit.snippet) ?? deserializeEntry(hitText ?? '');

        if (!entry || entry.sessionId !== this.sessionId) {
          return undefined;
        }

        const candidate: SessionMemoryCandidate = {
          ...entry,
          retrievalScore: hit.score,
          finalScore: hit.score,
          fidelity: 'summary'
        };

        return candidate;
      });

    return candidates.filter((candidate): candidate is SessionMemoryCandidate => candidate !== undefined);
  }

  private requireMemvid(): Memvid {
    if (!this.memvid) {
      throw new Error('MemvidSessionStore must be opened before use.');
    }

    return this.memvid;
  }

  private async writeMeta(): Promise<void> {
    await writeFile(
      this.artifactPaths.metaPath,
      JSON.stringify(
        {
          version: META_VERSION,
          engine: META_ENGINE,
          sessionId: this.sessionId,
          lastCompactedAt: null
        },
        null,
        2
      )
    );
  }
}

function buildSearchText(entry: SessionMemoryEntry): string {
  return [entry.summaryText, entry.essenceText, entry.tags.join(' '), entry.fullText].filter(Boolean).join('\n');
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
