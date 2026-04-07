import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemvidSessionStore } from '../../src/memory/memvidSessionStore.js';
import type { SessionMemoryEntry } from '../../src/memory/sessionMemoryTypes.js';

const tempDirs: string[] = [];

function createEntry(overrides: Partial<SessionMemoryEntry> = {}): SessionMemoryEntry {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    memoryType: 'fact',
    fullText: 'User prefers concise Vietnamese responses in this session.',
    summaryText: 'Use concise Vietnamese.',
    essenceText: 'Vietnamese + concise.',
    tags: ['language', 'style'],
    source: 'turn-1',
    sourceTurnId: 'turn-1',
    createdAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z',
    accessCount: 0,
    importance: 0.8,
    explicitSave: true,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('MemvidSessionStore', () => {
  it('creates session-scoped artifacts, persists an entry, and recalls only the matching session uri namespace', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_1'
    });

    await store.open();
    await store.put(createEntry());
    await store.seal();

    const paths = store.paths();
    const meta = JSON.parse(await readFile(paths.metaPath, 'utf8')) as Record<string, unknown>;

    expect(meta).toMatchObject({
      version: 1,
      engine: 'memvid-session-store',
      sessionId: 'session_1',
      memoryPath: paths.memoryPath,
      metaPath: paths.metaPath,
      totalEntries: 1,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      accessStatsByHash: {}
    });
    expect(meta.lastSealedAt).toEqual(expect.any(String));

    const hits = await store.find('Vietnamese', { k: 5 });
    expect(hits.total_hits).toBe(1);
    expect(hits.hits[0]?.uri).toBe('mv2://sessions/session_1/memory/abc123def456');
    expect(hits.hits[0]?.track).toBe('session:session_1');
  });

  it('reopens persisted stores and maps find hits back into session memory candidates', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const writer = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_9'
    });

    await writer.open();
    await writer.put(createEntry({ sessionId: 'session_9', hash: 'reopen123456', source: 'turn-9' }));
    await writer.seal();

    const reader = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_9'
    });

    await reader.open();
    const recalled = await reader.recall('concise', { k: 5 });

    expect(recalled).toEqual([
      expect.objectContaining({
        sessionId: 'session_9',
        hash: 'reopen123456',
        source: 'turn-9',
        retrievalScore: expect.any(Number),
        fidelity: 'summary'
      })
    ]);
  });

  it('recalls by hash prefix only within the current session and updates touch metadata', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_hash'
    });

    await store.open();
    await store.put(createEntry({ sessionId: 'session_hash', hash: 'abc123def456' }));
    await store.put(createEntry({ sessionId: 'session_hash', hash: 'def789abc000', summaryText: 'Different memory.' }));
    await store.seal();

    const matched = await store.recallByHashPrefix('abc123', { k: 5 });
    expect(matched).toEqual([
      expect.objectContaining({
        sessionId: 'session_hash',
        hash: 'abc123def456'
      })
    ]);

    const touched = await store.touchByHashes(['abc123def456'], '2026-04-06T01:00:00.000Z');
    expect(touched).toEqual(['abc123def456']);

    const meta = await store.readMeta();
    expect(meta.accessStatsByHash).toEqual({
      abc123def456: {
        accessCount: 1,
        lastAccessed: '2026-04-06T01:00:00.000Z'
      }
    });
  });

  it('uses auto recall and vector embedding metadata when memoryConfig is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_ollama',
      memoryConfig: {
        provider: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434'
      }
    });

    await store.open();

    const memvid = store.memvidInstance();
    expect(memvid).toBeDefined();

    const putSpy = vi.spyOn(memvid!, 'put');
    const findSpy = vi.spyOn(memvid!, 'find');
    const embedder = (store as { embedder?: { embedQuery(text: string): Promise<number[]> } }).embedder!;
    const embedQuerySpy = vi.spyOn(embedder, 'embedQuery').mockImplementation(async () => new Array(768).fill(0.1));

    await store.put(createEntry({ sessionId: 'session_ollama' }));
    await store.find('Vietnamese', { k: 5 });

    expect(embedQuerySpy).toHaveBeenCalled();
    expect(putSpy).toHaveBeenCalledWith(expect.objectContaining({
      enableEmbedding: true,
      embeddingIdentity: expect.objectContaining({
        provider: 'ollama',
        model: 'nomic-embed-text'
      })
    }));
    expect(findSpy).toHaveBeenCalledWith('Vietnamese', expect.objectContaining({
      mode: 'auto',
      embedder: expect.objectContaining({
        provider: 'ollama',
        modelName: 'nomic-embed-text'
      })
    }));
  });

  it('does not throw when recall query contains unmatched parentheses', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_chars'
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_query_chars',
      hash: 'paren123456',
      summaryText: 'Editor preference stored.',
      essenceText: 'User prefers neovim.',
      fullText: 'User prefers neovim as the main editor.'
    }));
    await store.seal();

    await expect(store.recall('favorite editor (neovim', { k: 5 })).resolves.toEqual([]);
  });

  it('normalizes asterisk in recall queries into text instead of dropping it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_asterisk'
    });

    await store.open();
    const memvid = store.memvidInstance();
    expect(memvid).toBeDefined();

    const findSpy = vi.spyOn(memvid!, 'find');
    await store.recall('3 * 3', { k: 5 });

    expect(findSpy).toHaveBeenCalledWith('3 times 3', expect.objectContaining({
      mode: 'lex'
    }));
  });

  it('normalizes risky quote and bracket characters into text tokens', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_symbols'
    });

    await store.open();
    const memvid = store.memvidInstance();
    expect(memvid).toBeDefined();

    const findSpy = vi.spyOn(memvid!, 'find');
    await store.recall('"abc" [tag] {code}', { k: 5 });

    expect(findSpy).toHaveBeenCalledWith('quote abc quote lbracket tag rbracket lbrace code rbrace', expect.objectContaining({
      mode: 'lex'
    }));
  });

  it('normalizes single quotes into text tokens and avoids empty queries after sanitizing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'memvid-session-store-'));
    tempDirs.push(tempDir);

    const store = new MemvidSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_single_quote'
    });

    await store.open();
    const memvid = store.memvidInstance();
    expect(memvid).toBeDefined();

    const findSpy = vi.spyOn(memvid!, 'find');
    await store.recall("'abc'", { k: 5 });
    await expect(store.recall('()', { k: 5 })).resolves.toEqual([]);

    expect(findSpy).toHaveBeenCalledWith('apostrophe abc apostrophe', expect.objectContaining({
      mode: 'lex'
    }));
    expect(findSpy).toHaveBeenCalledTimes(1);
  });
});
