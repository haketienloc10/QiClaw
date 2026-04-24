import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  BlueprintArtifactPaths,
  BlueprintRecord,
  BlueprintStoreMeta,
  PersistedBlueprintRecord
} from './types.js';

interface BlueprintIndex {
  entries: PersistedBlueprintRecord[];
}

export class BlueprintStore {
  private readonly artifactPaths: BlueprintArtifactPaths;

  constructor(options: { baseDirectory?: string } = {}) {
    const configuredDirectory = options.baseDirectory ?? process.env.QICLAW_GLOBAL_BLUEPRINT_DIR?.trim();
    const directoryPath = configuredDirectory && configuredDirectory.length > 0
      ? configuredDirectory
      : join(homedir(), '.qiclaw', 'blueprints', 'global');
    this.artifactPaths = {
      directoryPath,
      indexPath: join(directoryPath, 'index.json'),
      metaPath: join(directoryPath, 'meta.json')
    };
  }

  paths(): BlueprintArtifactPaths {
    return this.artifactPaths;
  }

  async open(): Promise<void> {
    await mkdir(this.artifactPaths.directoryPath, { recursive: true });
    await ensureIndexFile(this.artifactPaths.indexPath);
    await ensureMetaFile(this.artifactPaths.metaPath, buildDefaultMeta(this.artifactPaths));
  }

  async readMeta(): Promise<BlueprintStoreMeta> {
    if (!existsSync(this.artifactPaths.metaPath)) {
      return buildDefaultMeta(this.artifactPaths);
    }

    try {
      const parsed = JSON.parse(await readFile(this.artifactPaths.metaPath, 'utf8')) as Partial<BlueprintStoreMeta>;
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        engine: typeof parsed.engine === 'string' ? parsed.engine : 'file-blueprint-store',
        indexPath: typeof parsed.indexPath === 'string' ? parsed.indexPath : this.artifactPaths.indexPath,
        metaPath: typeof parsed.metaPath === 'string' ? parsed.metaPath : this.artifactPaths.metaPath,
        totalEntries: typeof parsed.totalEntries === 'number' ? parsed.totalEntries : 0,
        lastSealedAt: typeof parsed.lastSealedAt === 'string' || parsed.lastSealedAt === null ? parsed.lastSealedAt : null
      };
    } catch {
      return buildDefaultMeta(this.artifactPaths);
    }
  }

  async writeMeta(meta: BlueprintStoreMeta): Promise<void> {
    await writeFile(this.artifactPaths.metaPath, JSON.stringify(meta, null, 2));
  }

  async put(record: BlueprintRecord): Promise<PersistedBlueprintRecord> {
    const markdownPath = await writeMarkdownArtifact(this.artifactPaths.directoryPath, record);
    const sourceContentHash = await createSourceContentHash(markdownPath);
    const persisted: PersistedBlueprintRecord = {
      ...record,
      markdownPath,
      sourceContentHash
    };

    const index = await this.readIndex();
    index.entries = [
      ...index.entries.filter((entry) => entry.id !== record.id),
      persisted
    ];
    await this.writeIndex(index);

    const meta = await this.readMeta();
    await this.writeMeta({
      ...meta,
      totalEntries: index.entries.length
    });

    return persisted;
  }

  async listActive(): Promise<PersistedBlueprintRecord[]> {
    const index = await this.readIndex();
    return index.entries.filter((entry) => entry.status === 'active');
  }

  async getById(id: string): Promise<PersistedBlueprintRecord | undefined> {
    const index = await this.readIndex();
    return index.entries.find((entry) => entry.id === id);
  }

  async supersedeBlueprint(id: string, now = new Date().toISOString()): Promise<void> {
    await this.updateStatus(id, 'superseded', now);
  }

  async retireBlueprint(id: string, now = new Date().toISOString()): Promise<void> {
    await this.updateStatus(id, 'retired', now);
  }

  async seal(): Promise<void> {
    const meta = await this.readMeta();
    await this.writeMeta({
      ...meta,
      lastSealedAt: new Date().toISOString()
    });
  }

  private async updateStatus(id: string, status: PersistedBlueprintRecord['status'], now: string): Promise<void> {
    const index = await this.readIndex();
    index.entries = index.entries.map((entry) => entry.id === id ? { ...entry, status, updatedAt: now } : entry);
    await this.writeIndex(index);
  }

  private async readIndex(): Promise<BlueprintIndex> {
    await ensureIndexFile(this.artifactPaths.indexPath);

    try {
      const parsed = JSON.parse(await readFile(this.artifactPaths.indexPath, 'utf8')) as Partial<BlueprintIndex>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isPersistedBlueprintRecord) : []
      };
    } catch {
      return { entries: [] };
    }
  }

  private async writeIndex(index: BlueprintIndex): Promise<void> {
    await writeFile(this.artifactPaths.indexPath, JSON.stringify(index, null, 2));
  }
}

function buildDefaultMeta(paths: BlueprintArtifactPaths): BlueprintStoreMeta {
  return {
    version: 1,
    engine: 'file-blueprint-store',
    indexPath: paths.indexPath,
    metaPath: paths.metaPath,
    totalEntries: 0,
    lastSealedAt: null
  };
}

async function ensureIndexFile(indexPath: string): Promise<void> {
  if (existsSync(indexPath)) {
    return;
  }

  await writeFile(indexPath, JSON.stringify({ entries: [] }, null, 2));
}

async function ensureMetaFile(metaPath: string, meta: BlueprintStoreMeta): Promise<void> {
  if (existsSync(metaPath)) {
    return;
  }

  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

function isPersistedBlueprintRecord(value: unknown): value is PersistedBlueprintRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const stats = record.stats as Record<string, unknown> | undefined;
  const trigger = record.trigger as Record<string, unknown> | undefined;

  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.goal === 'string'
    && typeof record.source === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && (record.status === 'active' || record.status === 'superseded' || record.status === 'retired')
    && typeof record.markdownPath === 'string'
    && Array.isArray(record.tags)
    && Array.isArray(record.steps)
    && Array.isArray(record.expectedEvidence)
    && Array.isArray(record.failureModes)
    && Boolean(trigger)
    && typeof trigger?.title === 'string'
    && Array.isArray(trigger?.patterns)
    && Array.isArray(trigger?.tags)
    && Boolean(stats)
    && typeof stats?.useCount === 'number'
    && typeof stats?.successCount === 'number'
    && typeof stats?.failureCount === 'number';
}

async function createSourceContentHash(markdownPath: string): Promise<string> {
  const markdownBytes = await readFile(markdownPath);
  return createHash('sha256').update(markdownBytes).digest('hex');
}

async function writeMarkdownArtifact(baseDirectoryPath: string, record: BlueprintRecord): Promise<string> {
  const dateKey = /^\d{4}-\d{2}-\d{2}/u.test(record.createdAt) ? record.createdAt.slice(0, 10) : 'unknown-date';
  const directoryPath = join(baseDirectoryPath, dateKey, 'blueprint');
  const filePath = join(directoryPath, `${record.id}.md`);

  await mkdir(directoryPath, { recursive: true });
  await writeFile(filePath, renderMarkdownArtifact(record));
  return filePath;
}

function renderMarkdownArtifact(record: BlueprintRecord): string {
  const lines = [
    `# ${record.title}`,
    '',
    record.goal,
    '',
    `- Blueprint ID: ${record.id}`,
    `- Status: ${record.status}`,
    `- Created at: ${record.createdAt}`
  ];

  if (record.tags.length > 0) {
    lines.push(`- Tags: ${record.tags.join(', ')}`);
  }

  return `${lines.join('\n')}\n`;
}
