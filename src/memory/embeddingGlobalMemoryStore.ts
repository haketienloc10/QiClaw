import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { buildRecallCandidate, buildSessionMemoryUri, parseSessionMemoryUri, type PersistedSessionMemoryRecord, type SessionMemoryCandidate } from './sessionMemoryTypes.js';
import { GlobalMemoryStore, type GlobalMemoryStoreOptions } from './globalMemoryStore.js';
import { embedTexts, cosineSimilarity } from './ollamaEmbeddingClient.js';

interface EmbeddingIndexRecord {
  hash: string;
  vector: number[];
}

interface EmbeddingIndex {
  entries: EmbeddingIndexRecord[];
}

const GLOBAL_SESSION_ID = 'user-global';

export class EmbeddingGlobalMemoryStore extends GlobalMemoryStore {
  constructor(options: GlobalMemoryStoreOptions = {}) {
    super(options);
    if (!options.memoryConfig) {
      throw new Error('EmbeddingGlobalMemoryStore requires memoryConfig');
    }
  }

  override async open(): Promise<void> {
    await super.open();
    await this.ensureEmbeddingIndex();
  }

  override async put(entry: Parameters<GlobalMemoryStore['put']>[0]): Promise<string> {
    const uri = await super.put(entry);
    const [vector] = await embedTexts(this.memoryConfig!, buildEmbeddingInput(entry));
    const index = await this.readEmbeddingIndex();
    index.entries = [
      ...index.entries.filter((candidate) => candidate.hash !== entry.hash),
      { hash: entry.hash, vector }
    ];
    await this.writeEmbeddingIndex(index);
    return uri;
  }

  override async recall(query: string, options: { k: number }): Promise<SessionMemoryCandidate[]> {
    const [queryVector] = await embedTexts(this.memoryConfig!, query);
    const records = await this.readMemoryRecords();
    const meta = await this.readMeta();
    const vectorByHash = new Map((await this.readEmbeddingIndex()).entries.map((entry) => [entry.hash, entry.vector]));

    return records
      .filter((entry) => entry.sessionId === GLOBAL_SESSION_ID && entry.status === 'active')
      .map((record) => ({ record, score: cosineSimilarity(queryVector, vectorByHash.get(record.hash) ?? []) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.record.importance - left.record.importance)
      .slice(0, options.k)
      .map(({ record, score }) => toGlobalMemoryCandidate(record, meta.accessStatsByHash[record.hash.toLowerCase()], score))
      .filter((candidate): candidate is SessionMemoryCandidate => candidate !== undefined);
  }

  private embeddingIndexPath(): string {
    return this.paths().memoryPath.replace(/index\.json$/u, 'embeddings.json');
  }

  private async ensureEmbeddingIndex(): Promise<void> {
    await this.writeEmbeddingIndex(await this.readEmbeddingIndex());
  }

  private async readEmbeddingIndex(): Promise<EmbeddingIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.embeddingIndexPath(), 'utf8')) as Partial<EmbeddingIndex>;
      return {
        entries: Array.isArray(parsed.entries)
          ? parsed.entries.filter((entry): entry is EmbeddingIndexRecord => Boolean(entry) && typeof entry === 'object' && typeof entry.hash === 'string' && Array.isArray(entry.vector) && entry.vector.every((value) => typeof value === 'number'))
          : []
      };
    } catch {
      return { entries: [] };
    }
  }

  private async writeEmbeddingIndex(index: EmbeddingIndex): Promise<void> {
    await mkdir(this.paths().directoryPath, { recursive: true });
    await writeFile(this.embeddingIndexPath(), JSON.stringify(index, null, 2));
  }

  private async readMemoryRecords(): Promise<PersistedSessionMemoryRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.paths().memoryPath, 'utf8')) as { entries?: unknown[] };
      return Array.isArray(parsed.entries)
        ? parsed.entries.filter((entry): entry is PersistedSessionMemoryRecord => Boolean(entry) && typeof entry === 'object' && typeof (entry as PersistedSessionMemoryRecord).hash === 'string')
        : [];
    } catch {
      return [];
    }
  }
}

function buildEmbeddingInput(entry: Pick<PersistedSessionMemoryRecord, 'summaryText' | 'essenceText' | 'fullText'>): string {
  return [entry.summaryText, entry.essenceText, entry.fullText].join(' ').trim();
}

function toGlobalMemoryCandidate(
  record: PersistedSessionMemoryRecord,
  stat: { accessCount: number; lastAccessed: string } | undefined,
  retrievalScore: number
): SessionMemoryCandidate | undefined {
  const uriParts = parseSessionMemoryUri(buildSessionMemoryUri(GLOBAL_SESSION_ID, record.hash));
  if (!uriParts || uriParts.sessionId !== GLOBAL_SESSION_ID) {
    return undefined;
  }

  return buildRecallCandidate({
    record: {
      ...record,
      lastAccessed: stat?.lastAccessed ?? record.lastAccessed,
      accessCount: stat?.accessCount ?? record.accessCount
    },
    retrievalScore,
    finalScore: 0,
    fidelity: 'summary'
  });
}
