import { describe, expect, it, vi } from 'vitest';

import {
  captureInteractiveTurnMemory,
  prepareInteractiveSessionMemory,
  recallSessionMemories
} from '../../src/memory/sessionMemoryEngine.js';
import * as sessionMemoryMaintenance from '../../src/memory/sessionMemoryMaintenance.js';
import * as decay from '../../src/memory/decay.js';
import { FileSessionStore } from '../../src/memory/fileSessionStore.js';
import { GlobalMemoryStore } from '../../src/memory/globalMemoryStore.js';
import type { SessionMemoryCandidate } from '../../src/memory/sessionMemoryTypes.js';

function createCandidate(overrides: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    kind: 'fact',
    fullText: 'User explicitly asked to always answer in Vietnamese with concise wording.',
    summaryText: 'Answer in Vietnamese.',
    essenceText: 'Vietnamese responses.',
    tags: ['language'],
    source: 'turn-1',
    sourceTurnId: 'turn-1',
    createdAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z',
    accessCount: 0,
    importance: 0.5,
    explicitSave: false,
    retrievalScore: 0.5,
    finalScore: 0,
    fidelity: 'summary',
    ...overrides
  };
}

describe('captureInteractiveTurnMemory', () => {
  it('runs write maintenance preflight before persisting or sealing', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);
    const ensureWriteReady = vi.spyOn(sessionMemoryMaintenance, 'ensureSessionStoreWriteReady').mockResolvedValue({ ok: true });

    try {
      const result = await captureInteractiveTurnMemory({
        store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
        sessionId: 'session_1',
        userInput: 'remember that i use pnpm',
        finalAnswer: 'I will remember that you use pnpm.'
      });

      expect(result.saved).toBe(true);
      expect(ensureWriteReady).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledTimes(1);
      expect(seal).toHaveBeenCalledTimes(1);
    } finally {
      ensureWriteReady.mockRestore();
    }
  });

  it('fails when write maintenance preflight rejects before persisting', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);
    const ensureWriteReady = vi.spyOn(sessionMemoryMaintenance, 'ensureSessionStoreWriteReady').mockRejectedValue(new Error('write preflight failed'));

    try {
      await expect(captureInteractiveTurnMemory({
        store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
        sessionId: 'session_1',
        userInput: 'remember that i use pnpm',
        finalAnswer: 'I will remember that you use pnpm.'
      })).rejects.toThrow('write preflight failed');

      expect(put).not.toHaveBeenCalled();
      expect(seal).not.toHaveBeenCalled();
    } finally {
      ensureWriteReady.mockRestore();
    }
  });

  const readMeta = vi.fn(async () => ({
    version: 1,
    engine: 'file-session-memory-store',
    sessionId: 'session_1',
    memoryPath: '/tmp/memory/index.json',
    metaPath: '/tmp/memory/meta.json',
    totalEntries: 0,
    lastCompactedAt: null,
    lastVerifiedAt: null,
    lastDoctorAt: null,
    lastSealedAt: null,
    accessStatsByHash: {}
  }));

  it('does not persist question-style remember phrasing as an explicit save', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'do you remember that I prefer concise answers?',
      finalAnswer: 'Yes, I remember that preference.'
    });

    expect(result.saved).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('persists memory_candidates before falling back to heuristic capture', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: {
        put,
        seal,
        readMeta,
        paths: () => ({
          directoryPath: '/tmp/memory',
          memoryPath: '/tmp/memory/index.json',
          metaPath: '/tmp/memory/meta.json'
        })
      } as never,
      sessionId: 'session_1',
      userInput: 'hãy nhớ rằng tôi thích trả lời bằng tiếng Việt',
      finalAnswer: 'Tôi sẽ nhớ rằng bạn thích trả lời bằng tiếng Việt.',
      memoryCandidates: [
        {
          operation: 'create',
          target_memory_ids: '',
          kind: 'fact',
          title: 'User prefers Vietnamese',
          summary: 'Always answer in Vietnamese unless explicitly asked otherwise.',
          keywords: 'language | vietnamese | preference',
          confidence: 0.94,
          durability: 'durable',
          speculative: false,
          novelty_basis: 'User explicitly stated this preference in the current turn.'
        }
      ]
    });

    expect(result.saved).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(result.entry).toMatchObject({
      kind: 'fact',
      summaryText: 'Always answer in Vietnamese unless explicitly asked otherwise',
      essenceText: 'User prefers Vietnamese',
      explicitSave: false,
      sourceTurnId: undefined,
      updatedAt: expect.any(String),
      status: 'active',
      invalidatedAt: undefined,
      markdownPath: expect.stringMatching(/^\/tmp\/memory\/\d{4}-\d{2}-\d{2}\/fact\/[a-f0-9]+\.md$/)
    });
    expect(result.entry?.tags).toContain('language');
    expect(result.entry?.tags).toContain('vietnamese');
  });

  it('persists refine candidates by superseding target memories and saving the refined memory', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);
    const supersede = vi.fn(async () => ['abc123def456']);

    const result = await captureInteractiveTurnMemory({
      store: {
        put,
        seal,
        readMeta,
        paths: () => ({ memoryPath: '/tmp/memory/index.json' }),
        supersedeByHashes: supersede
      } as never,
      sessionId: 'session_1',
      userInput: 'remember my answer preference more precisely',
      finalAnswer: 'I refined that preference.',
      memoryCandidates: [
        {
          operation: 'refine',
          target_memory_ids: 'abc123def456',
          kind: 'decision',
          title: 'User prefers Vietnamese concise answers',
          summary: 'Answer in Vietnamese with concise wording unless explicitly asked otherwise.',
          keywords: 'language | vietnamese | concise',
          confidence: 0.91,
          durability: 'durable',
          speculative: false,
          novelty_basis: 'The user clarified both language and brevity in the current turn.'
        }
      ]
    });

    expect(result.saved).toBe(true);
    expect(supersede).toHaveBeenCalledWith(['abc123def456'], expect.any(String));
    expect(put).toHaveBeenCalledTimes(1);
    expect(result.entry).toMatchObject({
      kind: 'decision',
      summaryText: 'Answer in Vietnamese with concise wording unless explicitly asked otherwise',
      essenceText: 'User prefers Vietnamese concise answers'
    });
  });

  it('keeps normalized model kinds for workflow and uncertainty candidates', async () => {
    const workflowPut = vi.fn(async () => undefined);
    const workflowSeal = vi.fn(async () => undefined);

    const workflowResult = await captureInteractiveTurnMemory({
      store: {
        put: workflowPut,
        seal: workflowSeal,
        readMeta,
        paths: () => ({ memoryPath: '/tmp/memory/index.json' })
      } as never,
      sessionId: 'session_1',
      userInput: 'remember the deploy workflow',
      finalAnswer: 'I will remember that workflow.',
      memoryCandidates: [
        {
          operation: 'create',
          target_memory_ids: '',
          kind: 'workflow',
          title: 'Deploy workflow',
          summary: 'Run build, run tests, and deploy only after both pass.',
          keywords: 'deploy | workflow | tests',
          confidence: 0.93,
          durability: 'durable',
          speculative: false,
          novelty_basis: 'The user described a reusable workflow explicitly.'
        }
      ]
    });

    expect(workflowResult.saved).toBe(true);
    expect(workflowResult.entry).toMatchObject({
      kind: 'workflow',
      summaryText: 'Run build, run tests, and deploy only after both pass'
    });

    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => ['abc123def456']);

    const result = await captureInteractiveTurnMemory({
      store: {
        put,
        seal,
        readMeta,
        paths: () => ({ memoryPath: '/tmp/memory/index.json' }),
        invalidateByHashes: invalidate
      } as never,
      sessionId: 'session_1',
      userInput: 'that uncertainty is no longer true',
      finalAnswer: 'Understood. I will discard that memory.',
      memoryCandidates: [
        {
          operation: 'invalidate',
          target_memory_ids: 'abc123def456',
          kind: 'uncertainty',
          title: 'Deprecated uncertainty',
          summary: 'This uncertainty is no longer valid.',
          keywords: 'deprecated | uncertainty',
          confidence: 0.88,
          durability: 'working',
          speculative: false,
          novelty_basis: 'The user explicitly said the prior uncertainty no longer applies.'
        }
      ]
    });

    expect(result.saved).toBe(false);
    expect(invalidate).toHaveBeenCalledWith(['abc123def456'], expect.any(String));
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('persists Vietnamese explicit save requests without the command prefix', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'hãy nhớ rằng tôi thích trả lời bằng tiếng Việt',
      finalAnswer: 'Tôi sẽ nhớ rằng bạn thích trả lời bằng tiếng Việt.'
    });

    expect(result.saved).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(result.entry).toMatchObject({
      kind: 'fact',
      summaryText: 'tôi thích trả lời bằng tiếng Việt',
      essenceText: 'tôi thích trả lời bằng tiếng Việt',
      explicitSave: true
    });
    expect(result.entry?.tags).toContain('tiếng');
    expect(result.entry?.tags).toContain('việt');
  });

  it('persists Vietnamese ghi nhớ requests without the command prefix', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'ghi nhớ là tôi dùng pnpm',
      finalAnswer: 'Tôi sẽ nhớ rằng bạn dùng pnpm.'
    });

    expect(result.saved).toBe(true);
    expect(result.entry).toMatchObject({
      kind: 'fact',
      summaryText: 'tôi dùng pnpm',
      explicitSave: true
    });
  });

  it('keeps the session save when global memory persistence fails for an explicit save', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);
    const globalOpen = vi.spyOn(GlobalMemoryStore.prototype, 'open').mockResolvedValue(undefined);
    const globalPut = vi.spyOn(GlobalMemoryStore.prototype, 'put').mockRejectedValue(new Error('global put failed'));
    const globalSeal = vi.spyOn(GlobalMemoryStore.prototype, 'seal').mockResolvedValue(undefined);

    try {
      const result = await captureInteractiveTurnMemory({
        store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
        sessionId: 'session_1',
        userInput: 'remember that my favorite editor is neovim',
        finalAnswer: 'I will remember that your favorite editor is neovim.'
      });

      expect(result.saved).toBe(true);
      expect(result.entry).toMatchObject({
        kind: 'fact',
        summaryText: 'that my favorite editor is neovim',
        explicitSave: true
      });
      expect(put).toHaveBeenCalledTimes(1);
      expect(seal).toHaveBeenCalledTimes(1);
      expect(globalOpen).toHaveBeenCalledTimes(1);
      expect(globalPut).toHaveBeenCalledTimes(1);
      expect(globalSeal).not.toHaveBeenCalled();
    } finally {
      globalOpen.mockRestore();
      globalPut.mockRestore();
      globalSeal.mockRestore();
    }
  });

  it('does not persist Vietnamese question-style remember phrasing as an explicit save', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'bạn có nhớ tôi thích câu trả lời ngắn gọn không?',
      finalAnswer: 'Có, tôi nhớ sở thích đó.'
    });

    expect(result.saved).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('persists a procedure memory when the turn ends with a successful tool result and concise conclusion', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'show me the package version',
      finalAnswer: 'package.json shows version 1.2.3.',
      history: [
        { role: 'user', content: 'show me the package version' },
        {
          role: 'assistant',
          content: 'I will inspect the package metadata.',
          toolCalls: [{ id: 'tool_1', name: 'Read', input: { file_path: '/tmp/package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_1',
          content: '{"version":"1.2.3"}',
          isError: false
        },
        { role: 'assistant', content: 'package.json shows version 1.2.3.' }
      ]
    });

    expect(result.saved).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(result.entry).toMatchObject({
      kind: 'workflow',
      summaryText: expect.stringContaining('Read'),
      essenceText: expect.stringContaining('version 1.2.3'),
      explicitSave: false
    });
  });

  it('does not persist a procedure memory when the current turn has no tool result', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'how should you check package version next time?',
      finalAnswer: 'You can read package.json to confirm the version quickly.',
      history: [
        { role: 'user', content: 'show me the package version' },
        {
          role: 'assistant',
          content: 'I will inspect the package metadata.',
          toolCalls: [{ id: 'tool_1', name: 'Read', input: { file_path: '/tmp/package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_1',
          content: '{"version":"1.2.3"}',
          isError: false
        },
        { role: 'assistant', content: 'package.json shows version 1.2.3.' },
        { role: 'user', content: 'how should you check package version next time?' },
        { role: 'assistant', content: 'You can read package.json to confirm the version quickly.' }
      ]
    });

    expect(result.saved).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('persists a Vietnamese procedure memory when the turn ends with a successful tool result and concise conclusion', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'hãy kiểm tra phiên bản package',
      finalAnswer: 'package.json cho thấy phiên bản 1.2.3.',
      history: [
        { role: 'user', content: 'hãy kiểm tra phiên bản package' },
        {
          role: 'assistant',
          content: 'Tôi sẽ đọc package.json.',
          toolCalls: [{ id: 'tool_vi_1', name: 'Read', input: { file_path: '/tmp/package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_vi_1',
          content: '{"version":"1.2.3"}',
          isError: false
        },
        { role: 'assistant', content: 'package.json cho thấy phiên bản 1.2.3.' }
      ]
    });

    expect(result.saved).toBe(true);
    expect(result.entry).toMatchObject({
      kind: 'workflow',
      explicitSave: false
    });
    expect(result.entry?.summaryText).toContain('phiên bản 1.2.3');
    expect(result.entry?.tags).toContain('phiên');
  });

  it('persists a Vietnamese failure memory when the turn ends with tool failure and recovery guidance', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'hãy đọc file package',
      finalAnswer: 'Hãy thử lại với đường dẫn đúng hoặc kiểm tra lại tên file.',
      history: [
        { role: 'user', content: 'hãy đọc file package' },
        {
          role: 'assistant',
          content: 'Tôi sẽ mở file.',
          toolCalls: [{ id: 'tool_vi_fail', name: 'Read', input: { file_path: '/tmp/missing-package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_vi_fail',
          content: 'ENOENT: no such file or directory',
          isError: true
        },
        { role: 'assistant', content: 'Hãy thử lại với đường dẫn đúng hoặc kiểm tra lại tên file.' }
      ]
    });

    expect(result.saved).toBe(true);
    expect(result.entry).toMatchObject({
      kind: 'uncertainty',
      explicitSave: false
    });
    expect(result.entry?.summaryText).toContain('thử lại');
  });

  it('does not persist a successful procedure memory when the current tool result is an error', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory/index.json' }) } as never,
      sessionId: 'session_1',
      userInput: 'read the package file',
      finalAnswer: 'Try again with the correct path or verify the file name.',
      history: [
        { role: 'user', content: 'read the package file' },
        {
          role: 'assistant',
          content: 'I will inspect the package file.',
          toolCalls: [{ id: 'tool_err_1', name: 'Read', input: { file_path: '/tmp/missing-package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_err_1',
          content: 'ENOENT: no such file or directory',
          isError: true
        },
        { role: 'assistant', content: 'Try again with the correct path or verify the file name.' }
      ]
    });

    expect(result.saved).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(result.entry).toMatchObject({
      kind: 'uncertainty',
      explicitSave: false
    });
    expect(result.entry?.kind).not.toBe('procedure');
    expect(result.entry?.summaryText.toLowerCase()).toContain('try again');
  });
});

describe('prepareInteractiveSessionMemory', () => {
  it('passes the memory embedding config into session and global store constructors during prepare', async () => {
    const open = vi.spyOn(FileSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const globalOpen = vi.spyOn(GlobalMemoryStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(FileSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-session-memory-store',
      sessionId: 'session_1',
      memoryPath: '/tmp/existing.mv2',
      metaPath: '/tmp/meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const globalReadMeta = vi.spyOn(GlobalMemoryStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-global-memory-store',
      sessionId: 'user-global',
      memoryPath: '/tmp/global.mv2',
      metaPath: '/tmp/global-meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const recall = vi.spyOn(FileSessionStore.prototype, 'recall').mockResolvedValue([]);
    const globalRecall = vi.spyOn(GlobalMemoryStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(FileSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const globalTouchByHashes = vi.spyOn(GlobalMemoryStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockResolvedValue({ ok: true, verified: false });

    try {
      await prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-verify',
        sessionId: 'session_1',
        userInput: 'do you remember anything about me?',
        memoryConfig: {
          provider: 'ollama',
          model: 'nomic-embed-text',
          baseUrl: 'http://localhost:11434'
        }
      });

      expect(open).toHaveBeenCalledTimes(1);
      expect(globalOpen).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      globalOpen.mockRestore();
      readMeta.mockRestore();
      globalReadMeta.mockRestore();
      recall.mockRestore();
      globalRecall.mockRestore();
      touchByHashes.mockRestore();
      globalTouchByHashes.mockRestore();
      verifyOpen.mockRestore();
    }
  });

  it('runs best-effort maintenance verify when opening an existing store and continues on success', async () => {
    const open = vi.spyOn(FileSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const writeMeta = vi.spyOn(FileSessionStore.prototype, 'writeMeta').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(FileSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-session-memory-store',
      sessionId: 'session_1',
      memoryPath: '/tmp/existing.mv2',
      metaPath: '/tmp/meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const recall = vi.spyOn(FileSessionStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(FileSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const globalOpen = vi.spyOn(GlobalMemoryStore.prototype, 'open').mockResolvedValue(undefined);
    const globalReadMeta = vi.spyOn(GlobalMemoryStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-global-memory-store',
      sessionId: 'user-global',
      memoryPath: '/tmp/global/index.json',
      metaPath: '/tmp/global/meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const globalRecall = vi.spyOn(GlobalMemoryStore.prototype, 'recall').mockResolvedValue([]);
    const globalTouchByHashes = vi.spyOn(GlobalMemoryStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockResolvedValue({
      ok: true,
      verified: true,
      meta: {
        lastVerifiedAt: '2026-04-06T08:00:00.000Z'
      }
    });

    try {
      const result = await prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-verify',
        sessionId: 'session_1',
        userInput: 'do you remember anything about me?',
        checkpointState: {
          storeSessionId: 'session_1',
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/existing.mv2',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      });

      expect(result.memoryText).toBe('');
      expect(verifyOpen).toHaveBeenCalledTimes(1);
      expect(verifyOpen).toHaveBeenCalledWith(expect.objectContaining({
        store: expect.any(FileSessionStore),
        meta: expect.objectContaining({ memoryPath: '/tmp/existing.mv2' })
      }));
    } finally {
      open.mockRestore();
      writeMeta.mockRestore();
      readMeta.mockRestore();
      recall.mockRestore();
      touchByHashes.mockRestore();
      globalOpen.mockRestore();
      globalReadMeta.mockRestore();
      globalRecall.mockRestore();
      globalTouchByHashes.mockRestore();
      verifyOpen.mockRestore();
    }
  });

  it('propagates maintenance verify failures so the CLI layer can fail open', async () => {
    const open = vi.spyOn(FileSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(FileSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-session-memory-store',
      sessionId: 'session_1',
      memoryPath: '/tmp/existing.mv2',
      metaPath: '/tmp/meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const writeMeta = vi.spyOn(FileSessionStore.prototype, 'writeMeta').mockResolvedValue(undefined);
    const recall = vi.spyOn(FileSessionStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(FileSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockRejectedValue(new Error('verify failed'));

    try {
      await expect(prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-verify-fail',
        sessionId: 'session_1',
        userInput: 'do you remember anything about me?',
        checkpointState: {
          storeSessionId: 'session_1',
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/existing.mv2',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })).rejects.toThrow('verify failed');

      expect(recall).not.toHaveBeenCalled();
      expect(touchByHashes).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      writeMeta.mockRestore();
      readMeta.mockRestore();
      recall.mockRestore();
      touchByHashes.mockRestore();
      verifyOpen.mockRestore();
    }
  });

  it('logs recall inputs for debugging with the filtered query list', async () => {
    const open = vi.spyOn(FileSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const globalOpen = vi.spyOn(GlobalMemoryStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(FileSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-session-memory-store',
      sessionId: 'session_1',
      memoryPath: '/tmp/memory.json',
      metaPath: '/tmp/meta.json',
      totalEntries: 2,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const globalReadMeta = vi.spyOn(GlobalMemoryStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-global-memory-store',
      sessionId: 'user-global',
      memoryPath: '/tmp/global-memory.json',
      metaPath: '/tmp/global-meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockResolvedValue({ ok: true, verified: false });
    const recall = vi.spyOn(FileSessionStore.prototype, 'recall')
      .mockResolvedValueOnce([
        createCandidate({
          hash: 'session-user-1',
          sessionId: 'session_1',
          kind: 'fact',
          summaryText: 'User hit from current input.',
          essenceText: 'User hit.',
          source: 'turn-user',
          retrievalScore: 0.91,
          importance: 0.8,
          explicitSave: true
        })
      ])
      .mockResolvedValueOnce([
        createCandidate({
          hash: 'session-history-1',
          sessionId: 'session_1',
          kind: 'workflow',
          summaryText: 'History hit from summary.',
          essenceText: 'History hit.',
          source: 'turn-history',
          retrievalScore: 0.72,
          importance: 0.5,
          explicitSave: false
        })
      ])
      .mockResolvedValueOnce([
        createCandidate({
          hash: 'session-user-1',
          sessionId: 'session_1',
          kind: 'fact',
          summaryText: 'User hit from current input.',
          essenceText: 'User hit.',
          source: 'turn-user',
          retrievalScore: 0.91,
          importance: 0.8,
          explicitSave: true
        })
      ]);
    const globalRecall = vi.spyOn(GlobalMemoryStore.prototype, 'recall')
      .mockResolvedValueOnce([
        createCandidate({
          hash: 'global-user-1',
          sessionId: 'user-global',
          kind: 'fact',
          summaryText: 'Global user hit.',
          essenceText: 'Global user hit.',
          source: 'global-user',
          retrievalScore: 0.61,
          importance: 0.7,
          explicitSave: true
        })
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createCandidate({
          hash: 'global-latest-1',
          sessionId: 'user-global',
          kind: 'uncertainty',
          summaryText: 'Global latest-summary hit.',
          essenceText: 'Global latest hit.',
          source: 'global-latest',
          retrievalScore: 0.52,
          importance: 0.6,
          explicitSave: false
        })
      ]);
    const touchByHashes = vi.spyOn(FileSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const globalTouchByHashes = vi.spyOn(GlobalMemoryStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const debugRecallInputs = vi.fn();

    try {
      await prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-touch',
        sessionId: 'session_1',
        userInput: 'remind me of my pinned preference',
        historySummary: 'History summary: pinned preference stored',
        checkpointState: {
          storeSessionId: 'session_1',
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/memory.json',
          metaPath: '/tmp/meta.json',
          totalEntries: 2,
          lastCompactedAt: null,
          latestSummaryText: 'pinned preference'
        },
        totalBudgetChars: 130,
        now: '2026-04-05T12:00:00.000Z',
        debugRecallInputs
      });

      expect(debugRecallInputs).toHaveBeenCalledTimes(1);
      expect(debugRecallInputs).toHaveBeenCalledWith({
        type: 'memory_recall_inputs',
        timestamp: '2026-04-05T12:00:00.000Z',
        sessionId: 'session_1',
        userInput: 'remind me of my pinned preference',
        historySummary: 'History summary: pinned preference stored',
        latestSummaryText: 'pinned preference',
        queries: [
          'remind me of my pinned preference',
          'History summary: pinned preference stored',
          'pinned preference'
        ],
        queryCount: 3,
        userInputLength: 'remind me of my pinned preference'.length,
        historySummaryLength: 'History summary: pinned preference stored'.length,
        latestSummaryTextLength: 'pinned preference'.length,
        queryOverview: [
          {
            source: 'userInput',
            query: 'remind me of my pinned preference',
            sessionHitCount: 1,
            globalHitCount: 1,
            totalHitCount: 2
          },
          {
            source: 'historySummary',
            query: 'History summary: pinned preference stored',
            sessionHitCount: 1,
            globalHitCount: 0,
            totalHitCount: 1
          },
          {
            source: 'latestSummaryText',
            query: 'pinned preference',
            sessionHitCount: 1,
            globalHitCount: 1,
            totalHitCount: 2
          }
        ],
        queryResults: [
          {
            source: 'userInput',
            query: 'remind me of my pinned preference',
            sessionHits: [
              {
                hash: 'session-user-1',
                sessionId: 'session_1',
                kind: 'fact',
                summaryText: 'User hit from current input.',
                source: 'turn-user',
                retrievalScore: 0.91,
                importance: 0.8,
                explicitSave: true
              }
            ],
            globalHits: [
              {
                hash: 'global-user-1',
                sessionId: 'user-global',
                kind: 'fact',
                summaryText: 'Global user hit.',
                source: 'global-user',
                retrievalScore: 0.61,
                importance: 0.7,
                explicitSave: true
              }
            ]
          },
          {
            source: 'historySummary',
            query: 'History summary: pinned preference stored',
            sessionHits: [
              {
                hash: 'session-history-1',
                sessionId: 'session_1',
                kind: 'workflow',
                summaryText: 'History hit from summary.',
                source: 'turn-history',
                retrievalScore: 0.72,
                importance: 0.5,
                explicitSave: false
              }
            ],
            globalHits: []
          },
          {
            source: 'latestSummaryText',
            query: 'pinned preference',
            sessionHits: [
              {
                hash: 'session-user-1',
                sessionId: 'session_1',
                kind: 'fact',
                summaryText: 'User hit from current input.',
                source: 'turn-user',
                retrievalScore: 0.91,
                importance: 0.8,
                explicitSave: true
              }
            ],
            globalHits: [
              {
                hash: 'global-latest-1',
                sessionId: 'user-global',
                kind: 'uncertainty',
                summaryText: 'Global latest-summary hit.',
                source: 'global-latest',
                retrievalScore: 0.52,
                importance: 0.6,
                explicitSave: false
              }
            ]
          }
        ],
        finalOverview: {
          finalResultCount: 4,
          sessionFinalCount: 2,
          globalFinalCount: 2
        },
        finalResults: [
          {
            hash: 'session-user-1',
            sessionId: 'session_1',
            kind: 'fact',
            summaryText: 'User hit from current input.',
            source: 'turn-user',
            retrievalScore: 0.91,
            importance: 0.8,
            explicitSave: true
          },
          {
            hash: 'global-user-1',
            sessionId: 'user-global',
            kind: 'fact',
            summaryText: 'Global user hit.',
            source: 'global-user',
            retrievalScore: 0.61,
            importance: 0.7,
            explicitSave: true
          },
          {
            hash: 'session-history-1',
            sessionId: 'session_1',
            kind: 'workflow',
            summaryText: 'History hit from summary.',
            source: 'turn-history',
            retrievalScore: 0.72,
            importance: 0.5,
            explicitSave: false
          },
          {
            hash: 'global-latest-1',
            sessionId: 'user-global',
            kind: 'uncertainty',
            summaryText: 'Global latest-summary hit.',
            source: 'global-latest',
            retrievalScore: 0.52,
            importance: 0.6,
            explicitSave: false
          }
        ]
      });
      expect(touchByHashes.mock.calls.length + globalTouchByHashes.mock.calls.length).toBeGreaterThanOrEqual(0);
    } finally {
      open.mockRestore();
      globalOpen.mockRestore();
      readMeta.mockRestore();
      globalReadMeta.mockRestore();
      verifyOpen.mockRestore();
      recall.mockRestore();
      globalRecall.mockRestore();
      touchByHashes.mockRestore();
      globalTouchByHashes.mockRestore();
    }
  });

  it('touches only hashes that survive final recall packing', async () => {
    const open = vi.spyOn(FileSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const globalOpen = vi.spyOn(GlobalMemoryStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(FileSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-session-memory-store',
      sessionId: 'session_1',
      memoryPath: '/tmp/memory.json',
      metaPath: '/tmp/meta.json',
      totalEntries: 2,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const globalReadMeta = vi.spyOn(GlobalMemoryStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-global-memory-store',
      sessionId: 'user-global',
      memoryPath: '/tmp/global-memory.json',
      metaPath: '/tmp/global-meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockResolvedValue({ ok: true, verified: false });
    const recall = vi.spyOn(FileSessionStore.prototype, 'recall')
      .mockResolvedValueOnce([
        createCandidate({
          hash: 'full123def456',
          retrievalScore: 0.95,
          importance: 0.9,
          explicitSave: true,
          fullText: 'Pinned pref.',
          summaryText: 'Pinned pref.',
          essenceText: 'Pinned pref.'
        }),
        createCandidate({
          hash: 'trim123def456',
          retrievalScore: 0.4,
          importance: 0.2,
          explicitSave: false,
          fullText: 'This lower-priority memory should be dropped by the final budget packing step because it needs much more room than remains.',
          summaryText: 'This lower-priority memory should be dropped by the final budget packing step because it needs much more room than remains.',
          essenceText: 'Dropped memory still too large for the remaining packed budget.'
        })
      ]);
    const globalRecall = vi.spyOn(GlobalMemoryStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(FileSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const globalTouchByHashes = vi.spyOn(GlobalMemoryStore.prototype, 'touchByHashes').mockResolvedValue([]);

    try {
      const result = await prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-touch',
        sessionId: 'session_1',
        userInput: 'remind me of my pinned preference',
        totalBudgetChars: 130,
        now: '2026-04-05T12:00:00.000Z'
      });

      expect(result.recalled.map((candidate) => candidate.hash)).toEqual(['full123def456']);
      expect(touchByHashes).toHaveBeenCalledTimes(1);
      expect(touchByHashes).toHaveBeenCalledWith(['full123def456']);
      expect(globalTouchByHashes).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      globalOpen.mockRestore();
      readMeta.mockRestore();
      globalReadMeta.mockRestore();
      verifyOpen.mockRestore();
      recall.mockRestore();
      globalRecall.mockRestore();
      touchByHashes.mockRestore();
      globalTouchByHashes.mockRestore();
    }
  });

  it('does not touch any hash when no memory is recalled', async () => {
    const open = vi.spyOn(FileSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(FileSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-session-memory-store',
      sessionId: 'session_1',
      memoryPath: '/tmp/memory.json',
      metaPath: '/tmp/meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockResolvedValue({ ok: true, verified: false });
    const recall = vi.spyOn(FileSessionStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(FileSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const globalOpen = vi.spyOn(GlobalMemoryStore.prototype, 'open').mockResolvedValue(undefined);
    const globalReadMeta = vi.spyOn(GlobalMemoryStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'file-global-memory-store',
      sessionId: 'user-global',
      memoryPath: '/tmp/global/index.json',
      metaPath: '/tmp/global/meta.json',
      totalEntries: 0,
      lastCompactedAt: null,
      lastVerifiedAt: null,
      lastDoctorAt: null,
      lastSealedAt: null,
      accessStatsByHash: {}
    });
    const globalRecall = vi.spyOn(GlobalMemoryStore.prototype, 'recall').mockResolvedValue([]);
    const globalTouchByHashes = vi.spyOn(GlobalMemoryStore.prototype, 'touchByHashes').mockResolvedValue([]);

    try {
      const result = await prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-empty',
        sessionId: 'session_1',
        userInput: 'brand new question',
        checkpointState: {
          storeSessionId: 'session_1',
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/memory.json',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null,
          latestSummaryText: 'remembered summary'
        },
        totalBudgetChars: 200
      });

      expect(result.memoryText).toBe('');
      expect(result.checkpointState).toMatchObject({
        storeSessionId: 'session_1',
        latestSummaryText: 'remembered summary'
      });
      expect(touchByHashes).not.toHaveBeenCalled();
      expect(globalTouchByHashes).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      readMeta.mockRestore();
      verifyOpen.mockRestore();
      recall.mockRestore();
      touchByHashes.mockRestore();
      globalOpen.mockRestore();
      globalReadMeta.mockRestore();
      globalRecall.mockRestore();
      globalTouchByHashes.mockRestore();
    }
  });
});

describe('recallSessionMemories', () => {
  it('uses the memory budget bucket to pack hot, warm, and faded memories into memoryText', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({ hash: 'hot123def456', retrievalScore: 0.9, importance: 0.9, explicitSave: true }),
        createCandidate({ hash: 'warm23def456', retrievalScore: 0.6, importance: 0.5, summaryText: 'Warm summary.' }),
        createCandidate({ hash: 'cool33def456', retrievalScore: 0.2, importance: 0.1, essenceText: 'Cool essence.' })
      ],
      budgetChars: 200,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.usedBudgetChars).toBeLessThanOrEqual(200);
    expect(result.memoryText.length).toBeLessThanOrEqual(200);

    expect(result.memoryText).toContain('Memory:');
    expect(result.memoryText).toContain('Hot memories:');
    expect(result.memoryText).toContain('Faded references:');
    expect(result.memoryText).toMatch(/Warm summary\.|Cool essence\.|#cool33def456/u);
  });

  it('does not overflow the final assembled memory text budget or render empty headers', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({
          hash: 'hot123def456',
          retrievalScore: 0.9,
          importance: 0.9,
          explicitSave: true,
          fullText: 'A moderately long memory that should not fit once section headers are included.',
          summaryText: 'A moderately long summary that also should not fit.',
          essenceText: 'brief essence'
        })
      ],
      budgetChars: 15,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.memoryText.length).toBeLessThanOrEqual(15);
    expect(result.usedBudgetChars).toBe(result.memoryText.length);
    expect(result.memoryText).toBe('');
    expect(result.recalled).toEqual([]);
    expect(result.memoryText).not.toContain('Hot memories:');
    expect(result.memoryText).not.toContain('Warm summaries:');
    expect(result.memoryText).not.toContain('Faded references:');
  });

  it('renders a compact block when the memory budget is low', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({
          hash: 'fact123def456',
          kind: 'fact',
          retrievalScore: 0.95,
          importance: 0.9,
          explicitSave: true,
          summaryText: 'Prefer concise answers in Vietnamese.',
          essenceText: 'Vietnamese concise.'
        }),
        createCandidate({
          hash: 'proc123def456',
          kind: 'workflow',
          retrievalScore: 0.7,
          importance: 0.6,
          summaryText: 'Use Read on package.json to confirm the package version.',
          essenceText: 'Read package.json for version.'
        })
      ],
      budgetChars: 90,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.memoryText.length).toBeLessThanOrEqual(90);
    expect(result.memoryText).toContain('Mem:');
    expect(result.memoryText).not.toContain('Hot memories:');
    expect(result.memoryText).not.toContain('Warm summaries:');
    expect(result.memoryText).not.toContain('Faded references:');
  });

  it('prefers explicit saves when candidates have equal final scores', () => {
    const score = vi.spyOn(decay, 'scoreSessionMemoryCandidate').mockReturnValue(1);
    const explicit = createCandidate({
      hash: 'aaa111def456',
      source: 'turn-a',
      sourceTurnId: 'turn-a',
      summaryText: 'Explicit same-score memory.',
      essenceText: 'Explicit same-score memory.',
      retrievalScore: 0.1,
      importance: 0.1,
      explicitSave: true,
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    });
    const regular = createCandidate({
      hash: 'bbb222def456',
      source: 'turn-b',
      sourceTurnId: 'turn-b',
      summaryText: 'Regular same-score memory.',
      essenceText: 'Regular same-score memory.',
      retrievalScore: 0.9,
      importance: 0.9,
      explicitSave: false,
      createdAt: '2026-04-05T11:00:00.000Z',
      lastAccessed: '2026-04-05T11:00:00.000Z'
    });

    try {
      const result = recallSessionMemories({
        candidates: [regular, explicit],
        budgetChars: 4000,
        now: '2026-04-07T00:00:00.000Z'
      });

      expect(score).toHaveBeenCalledTimes(2);
      expect(result.recalled.map((entry) => entry.hash)).toEqual(['aaa111def456', 'bbb222def456']);
    } finally {
      score.mockRestore();
    }
  });

  it('falls back to normalized recency when final score and explicit save are tied', () => {
    const score = vi.spyOn(decay, 'scoreSessionMemoryCandidate').mockReturnValue(1);
    const newer = createCandidate({
      hash: 'bbb222def456',
      source: 'turn-b',
      sourceTurnId: 'turn-b',
      summaryText: 'Newer same-score memory.',
      essenceText: 'Newer same-score memory.',
      retrievalScore: 0.1,
      importance: 0.1,
      explicitSave: false,
      createdAt: 'invalid-date',
      lastAccessed: '2026-04-05T11:00:00.000Z'
    });
    const older = createCandidate({
      hash: 'aaa111def456',
      source: 'turn-a',
      sourceTurnId: 'turn-a',
      summaryText: 'Older same-score memory.',
      essenceText: 'Older same-score memory.',
      retrievalScore: 0.9,
      importance: 0.9,
      explicitSave: false,
      createdAt: '2026-04-05T10:30:00.000Z',
      lastAccessed: 'invalid-date'
    });

    try {
      const firstRun = recallSessionMemories({
        candidates: [older, newer],
        budgetChars: 4000,
        now: '2026-04-07T00:00:00.000Z'
      });
      const secondRun = recallSessionMemories({
        candidates: [newer, older],
        budgetChars: 4000,
        now: '2026-04-07T00:00:00.000Z'
      });

      expect(score).toHaveBeenCalledTimes(4);
      expect(firstRun.recalled.map((entry) => entry.hash)).toEqual(['bbb222def456', 'aaa111def456']);
      expect(secondRun.recalled.map((entry) => entry.hash)).toEqual(['bbb222def456', 'aaa111def456']);
    } finally {
      score.mockRestore();
    }
  });

  it('returns deterministic order by hash and source when scores, explicit save, and recency are tied', () => {
    const score = vi.spyOn(decay, 'scoreSessionMemoryCandidate').mockReturnValue(1);
    const first = createCandidate({
      hash: 'aaa111def456',
      source: 'turn-b',
      sourceTurnId: 'turn-b',
      summaryText: 'First same-score memory.',
      essenceText: 'First same-score memory.',
      retrievalScore: 0.1,
      importance: 0.1,
      explicitSave: false,
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    });
    const second = createCandidate({
      hash: 'bbb222def456',
      source: 'turn-a',
      sourceTurnId: 'turn-a',
      summaryText: 'Second same-score memory.',
      essenceText: 'Second same-score memory.',
      retrievalScore: 0.9,
      importance: 0.9,
      explicitSave: false,
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    });
    const sameHashLowerSource = createCandidate({
      hash: 'ccc333def456',
      source: 'turn-a',
      sourceTurnId: 'turn-a',
      summaryText: 'Same hash lower source memory.',
      essenceText: 'Same hash lower source memory.',
      retrievalScore: 0.7,
      importance: 0.7,
      explicitSave: false,
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    });
    const sameHashHigherSource = createCandidate({
      hash: 'ccc333def456',
      source: 'turn-b',
      sourceTurnId: 'turn-b',
      summaryText: 'Same hash higher source memory.',
      essenceText: 'Same hash higher source memory.',
      retrievalScore: 0.8,
      importance: 0.8,
      explicitSave: false,
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    });

    try {
      const firstRun = recallSessionMemories({
        candidates: [sameHashHigherSource, second, sameHashLowerSource, first],
        budgetChars: 4000,
        now: '2026-04-07T00:00:00.000Z'
      });
      const secondRun = recallSessionMemories({
        candidates: [sameHashLowerSource, first, sameHashHigherSource, second],
        budgetChars: 4000,
        now: '2026-04-07T00:00:00.000Z'
      });

      expect(score).toHaveBeenCalledTimes(8);
      expect(firstRun.recalled.map((entry) => `${entry.hash}:${entry.source}`)).toEqual([
        'aaa111def456:turn-b',
        'bbb222def456:turn-a',
        'ccc333def456:turn-a',
        'ccc333def456:turn-b'
      ]);
      expect(secondRun.recalled.map((entry) => `${entry.hash}:${entry.source}`)).toEqual([
        'aaa111def456:turn-b',
        'bbb222def456:turn-a',
        'ccc333def456:turn-a',
        'ccc333def456:turn-b'
      ]);
    } finally {
      score.mockRestore();
    }
  });

  it('renders an explicit global candidate ahead of a weaker session candidate', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({
          hash: 'sessweak1234',
          sessionId: 'session_1',
          summaryText: 'Noisy session note for the login blueprint.',
          essenceText: 'Noisy login note.',
          retrievalScore: 0.55,
          importance: 0.2,
          explicitSave: false
        }),
        createCandidate({
          hash: 'globalstrong',
          sessionId: 'user-global',
          summaryText: 'Use login blueprint with audit logging.',
          essenceText: 'login blueprint with audit logging',
          retrievalScore: 0.55,
          importance: 0.2,
          explicitSave: true
        })
      ],
      budgetChars: 4000,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.recalled.map((entry) => entry.hash)).toEqual(['globalstrong', 'sessweak1234']);
    expect(result.memoryText).toContain('login blueprint with audit logging');
    expect(result.memoryText).toContain('Noisy login note');
  });
});
