import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GlobalMemoryStore } from '../../src/memory/globalMemoryStore.js';
import { FileSessionStore } from '../../src/memory/fileSessionStore.js';
import type { SessionMemoryEntry } from '../../src/memory/sessionMemoryTypes.js';

const tempDirs: string[] = [];

function createEntry(overrides: Partial<SessionMemoryEntry> = {}): SessionMemoryEntry {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    kind: 'fact',
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

describe('FileSessionStore', () => {
  it('creates session-scoped artifacts, persists an entry, and recalls only the matching session uri namespace', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
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
      engine: 'file-session-memory-store',
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
    expect(hits.engine).toBe('file-session-memory-store');
    expect(hits.total_hits).toBe(1);
    expect(hits.hits[0]?.uri).toBe('mv2://sessions/session_1/memory/abc123def456');
    expect(hits.hits[0]?.track).toBe('session:session_1');
  });

  it('reopens persisted stores and maps find hits back into session memory candidates', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const writer = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_9'
    });

    await writer.open();
    await writer.put(createEntry({ sessionId: 'session_9', hash: 'reopen123456', source: 'turn-9' }));
    await writer.put(createEntry({
      sessionId: 'session_9',
      hash: 'decision12345',
      source: 'turn-10',
      kind: 'decision',
      summaryText: 'Answer in Vietnamese with concise wording.',
      essenceText: 'Response style decision.',
      fullText: 'Decision: answer in Vietnamese with concise wording by default.',
      tags: ['decision', 'language', 'style']
    }));
    await writer.put(createEntry({
      sessionId: 'session_9',
      hash: 'episode123456',
      source: 'turn-11',
      kind: 'episode',
      summaryText: 'Deployment incident walkthrough.',
      essenceText: 'Deployment episode.',
      fullText: 'Episode: deployment failed because the runbook URL was outdated.',
      tags: ['episode', 'deployment', 'incident']
    }));
    await writer.put(createEntry({
      sessionId: 'session_9',
      hash: 'heuristic1234',
      source: 'turn-12',
      kind: 'heuristic',
      summaryText: 'Prefer reading package.json before guessing versions.',
      essenceText: 'Version-check heuristic.',
      fullText: 'Heuristic: read package.json before answering package version questions.',
      tags: ['heuristic', 'package', 'version']
    }));
    await writer.put(createEntry({
      sessionId: 'session_9',
      hash: 'uncertainty12',
      source: 'turn-13',
      kind: 'uncertainty',
      summaryText: 'Deployment docs may be outdated.',
      essenceText: 'Runbook uncertainty.',
      fullText: 'Uncertainty: deployment docs may be outdated until confirmed.',
      tags: ['uncertainty', 'deployment', 'docs']
    }));
    await writer.seal();

    const reader = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_9'
    });

    await reader.open();
    const recalled = await reader.recall('concise', { k: 5 });
    const decision = await reader.recall('decision language', { k: 5 });
    const episode = await reader.recall('deployment incident', { k: 5 });
    const heuristic = await reader.recall('package version heuristic', { k: 5 });
    const uncertainty = await reader.recall('deployment docs uncertainty', { k: 5 });

    expect(recalled).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'session_9',
        hash: 'reopen123456',
        source: 'turn-9',
        updatedAt: '2026-04-05T10:00:00.000Z',
        status: 'active',
        invalidatedAt: undefined,
        markdownPath: expect.stringContaining('reopen123456.md'),
        retrievalScore: expect.any(Number),
        fidelity: 'summary'
      })
    ]));
    expect(decision).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: 'decision12345',
        kind: 'decision'
      })
    ]));
    expect(episode).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: 'episode123456',
        kind: 'episode'
      })
    ]));
    expect(heuristic).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: 'heuristic1234',
        kind: 'heuristic'
      })
    ]));
    expect(uncertainty).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: 'uncertainty12',
        kind: 'uncertainty'
      })
    ]));
  });

  it('writes a markdown artifact under date and type directories for each memory entry', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_markdown'
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_markdown',
      hash: 'markdown123456',
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    }));
    await store.seal();

    const markdownPath = join(
      tempDir,
      '.qiclaw',
      'sessions',
      'session_markdown',
      'memory',
      '2026-04-05',
      'fact',
      'markdown123456.md'
    );

    const markdown = await readFile(markdownPath, 'utf8');
    expect(markdown).toContain('# Use concise Vietnamese.');
    expect(markdown).toContain('User prefers concise Vietnamese responses in this session.');
  });

  it('recalls by hash prefix only within the current session and updates touch metadata', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
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

  it('supersedes and invalidates entries by hash in the file-based session index', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_status'
    });

    await store.open();
    await store.put(createEntry({ sessionId: 'session_status', hash: 'abc123def456', summaryText: 'Original memory.' }));
    await store.put(createEntry({ sessionId: 'session_status', hash: 'def789abc000', summaryText: 'Second memory.' }));

    await store.supersedeByHashes(['abc123def456'], '2026-04-06T02:00:00.000Z');
    await store.invalidateByHashes(['def789abc000'], '2026-04-06T03:00:00.000Z');

    const index = JSON.parse(await readFile(store.paths().memoryPath, 'utf8')) as { entries: Array<Record<string, unknown>> };
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: 'abc123def456',
        status: 'superseded',
        updatedAt: '2026-04-06T02:00:00.000Z'
      }),
      expect.objectContaining({
        hash: 'def789abc000',
        status: 'invalidated',
        updatedAt: '2026-04-06T03:00:00.000Z',
        invalidatedAt: '2026-04-06T03:00:00.000Z'
      })
    ]));
  });

  it('keeps lexical recall working when memoryConfig is provided', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_ollama',
      memoryConfig: {
        provider: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434'
      }
    });

    await store.open();
    await store.put(createEntry({ sessionId: 'session_ollama' }));

    const hits = await store.find('Vietnamese', { k: 5 });

    expect(hits.engine).toBe('file-session-memory-store');
    expect(hits.total_hits).toBe(1);
    expect(hits.hits[0]).toEqual(expect.objectContaining({
      uri: 'mv2://sessions/session_ollama/memory/abc123def456',
      track: 'session:session_ollama'
    }));
  });

  it('recalls safely when recall query contains unmatched parentheses', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
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

    await expect(store.recall('favorite editor (neovim', { k: 5 })).resolves.toEqual([
      expect.objectContaining({
        hash: 'paren123456',
        sessionId: 'session_query_chars'
      })
    ]);
  });

  it('normalizes asterisk in recall queries into text instead of dropping it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_asterisk'
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_query_asterisk',
      hash: 'times123456',
      summaryText: 'Math memory.',
      essenceText: 'Three times three.',
      fullText: 'Remember the phrase 3 times 3 for sanitized lexical recall.'
    }));

    const hits = await store.recall('3 * 3', { k: 5 });

    expect(hits).toEqual([
      expect.objectContaining({
        hash: 'times123456',
        sessionId: 'session_query_asterisk'
      })
    ]);
  });

  it('normalizes risky quote and bracket characters into text tokens', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_symbols'
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_query_symbols',
      hash: 'symbols12345',
      summaryText: 'Symbol memory.',
      essenceText: 'Quoted abc tag code.',
      fullText: 'quote abc quote lbracket tag rbracket lbrace code rbrace'
    }));

    const hits = await store.recall('"abc" [tag] {code}', { k: 5 });

    expect(hits).toEqual([
      expect.objectContaining({
        hash: 'symbols12345',
        sessionId: 'session_query_symbols'
      })
    ]);
  });

  it('normalizes single quotes into text tokens and avoids empty queries after sanitizing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'file-session-store-'));
    tempDirs.push(tempDir);

    const store = new FileSessionStore({
      cwd: tempDir,
      sessionId: 'session_query_single_quote'
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_query_single_quote',
      hash: 'quote1234567',
      summaryText: 'Quote memory.',
      essenceText: 'Apostrophe abc apostrophe.',
      fullText: 'apostrophe abc apostrophe'
    }));

    await expect(store.recall("'abc'", { k: 5 })).resolves.toEqual([
      expect.objectContaining({
        hash: 'quote1234567',
        sessionId: 'session_query_single_quote'
      })
    ]);
    await expect(store.recall('()', { k: 5 })).resolves.toEqual([]);
  });
});

describe('GlobalMemoryStore', () => {
  it('writes a markdown artifact under date and type directories for each global memory entry', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'global-memory-store-'));
    tempDirs.push(tempDir);

    const store = new GlobalMemoryStore({
      baseDirectory: tempDir
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_global_source',
      hash: 'global123456',
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    }));
    await store.seal();

    const markdownPath = join(tempDir, '2026-04-05', 'fact', 'global123456.md');
    const markdown = await readFile(markdownPath, 'utf8');

    expect(markdown).toContain('# Use concise Vietnamese.');
    expect(markdown).toContain('User prefers concise Vietnamese responses in this session.');
    expect(markdown).toContain('- Session: user-global');
  });

  it('recalls global memories from file-based index data', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'global-memory-store-'));
    tempDirs.push(tempDir);

    const store = new GlobalMemoryStore({
      baseDirectory: tempDir
    });

    await store.open();
    await store.put(createEntry({
      sessionId: 'session_global_source',
      hash: 'globalrecall1',
      summaryText: 'Use concise Vietnamese.',
      essenceText: 'Vietnamese preference.',
      fullText: 'Always answer in Vietnamese unless explicitly asked otherwise.'
    }));
    await store.seal();

    const hits = await store.find('Vietnamese', { k: 5 });
    expect(hits.engine).toBe('file-global-memory-store');
    expect(hits.total_hits).toBe(1);
    expect(hits.hits[0]).toEqual(expect.objectContaining({
      uri: 'mv2://sessions/user-global/memory/globalrecall1',
      track: 'user-global'
    }));

    const recalled = await store.recall('Vietnamese', { k: 5 });
    expect(recalled).toEqual([
      expect.objectContaining({
        hash: 'globalrecall1',
        sessionId: 'user-global',
        updatedAt: '2026-04-05T10:00:00.000Z',
        status: 'active',
        invalidatedAt: undefined,
        markdownPath: expect.stringContaining('globalrecall1.md')
      })
    ]);
  });

  it('supersedes and invalidates entries by hash in the file-based global index', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'global-memory-store-'));
    tempDirs.push(tempDir);

    const store = new GlobalMemoryStore({
      baseDirectory: tempDir
    });

    await store.open();
    await store.put(createEntry({ sessionId: 'session_global_source', hash: 'globalabc123', summaryText: 'Global original memory.' }));
    await store.put(createEntry({ sessionId: 'session_global_source', hash: 'globaldef456', summaryText: 'Global second memory.' }));

    await store.supersedeByHashes(['globalabc123'], '2026-04-06T02:00:00.000Z');
    await store.invalidateByHashes(['globaldef456'], '2026-04-06T03:00:00.000Z');

    const index = JSON.parse(await readFile(store.paths().memoryPath, 'utf8')) as { entries: Array<Record<string, unknown>> };
    expect(index.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: 'globalabc123',
        status: 'superseded',
        updatedAt: '2026-04-06T02:00:00.000Z'
      }),
      expect.objectContaining({
        hash: 'globaldef456',
        status: 'invalidated',
        updatedAt: '2026-04-06T03:00:00.000Z',
        invalidatedAt: '2026-04-06T03:00:00.000Z'
      })
    ]));
  });
});
