import { describe, expect, it, vi } from 'vitest';

import {
  captureInteractiveTurnMemory,
  prepareInteractiveSessionMemory,
  recallSessionMemories
} from '../../src/memory/sessionMemoryEngine.js';
import * as sessionMemoryMaintenance from '../../src/memory/sessionMemoryMaintenance.js';
import { MemvidSessionStore } from '../../src/memory/memvidSessionStore.js';
import type { SessionMemoryCandidate } from '../../src/memory/sessionMemoryTypes.js';

function createCandidate(overrides: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    memoryType: 'fact',
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
        store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory.mv2' }) } as never,
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
        store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory.mv2' }) } as never,
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
    engine: 'memvid-session-store',
    sessionId: 'session_1',
    memoryPath: '/tmp/memory.mv2',
    metaPath: '/tmp/memory.meta.json',
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
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory.mv2' }) } as never,
      sessionId: 'session_1',
      userInput: 'do you remember that I prefer concise answers?',
      finalAnswer: 'Yes, I remember that preference.'
    });

    expect(result.saved).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('persists a procedure memory when the turn ends with a successful tool result and concise conclusion', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory.mv2' }) } as never,
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
      memoryType: 'procedure',
      summaryText: expect.stringContaining('Read'),
      essenceText: expect.stringContaining('version 1.2.3'),
      explicitSave: false
    });
  });

  it('does not persist a procedure memory when the current turn has no tool result', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal, readMeta, paths: () => ({ memoryPath: '/tmp/memory.mv2' }) } as never,
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
});

describe('prepareInteractiveSessionMemory', () => {
  it('runs best-effort maintenance verify when opening an existing store and continues on success', async () => {
    const open = vi.spyOn(MemvidSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const writeMeta = vi.spyOn(MemvidSessionStore.prototype, 'writeMeta').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(MemvidSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'memvid-session-store',
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
    const recall = vi.spyOn(MemvidSessionStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(MemvidSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
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
          engine: 'memvid-session-store',
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
        store: expect.any(MemvidSessionStore),
        meta: expect.objectContaining({ memoryPath: '/tmp/existing.mv2' })
      }));
    } finally {
      open.mockRestore();
      writeMeta.mockRestore();
      readMeta.mockRestore();
      recall.mockRestore();
      touchByHashes.mockRestore();
      verifyOpen.mockRestore();
    }
  });

  it('propagates maintenance verify failures so the CLI layer can fail open', async () => {
    const open = vi.spyOn(MemvidSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(MemvidSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'memvid-session-store',
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
    const writeMeta = vi.spyOn(MemvidSessionStore.prototype, 'writeMeta').mockResolvedValue(undefined);
    const recall = vi.spyOn(MemvidSessionStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(MemvidSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);
    const verifyOpen = vi.spyOn(sessionMemoryMaintenance, 'verifySessionStoreOnOpen').mockRejectedValue(new Error('verify failed'));

    try {
      await expect(prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-verify-fail',
        sessionId: 'session_1',
        userInput: 'do you remember anything about me?',
        checkpointState: {
          storeSessionId: 'session_1',
          engine: 'memvid-session-store',
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

  it('touches only hashes that survive final recall packing', async () => {
    const open = vi.spyOn(MemvidSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(MemvidSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'memvid-session-store',
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
    const recall = vi.spyOn(MemvidSessionStore.prototype, 'recall')
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
    const touchByHashes = vi.spyOn(MemvidSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);

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
    } finally {
      open.mockRestore();
      readMeta.mockRestore();
      recall.mockRestore();
      touchByHashes.mockRestore();
    }
  });

  it('does not touch any hash when no memory is recalled', async () => {
    const open = vi.spyOn(MemvidSessionStore.prototype, 'open').mockResolvedValue(undefined);
    const readMeta = vi.spyOn(MemvidSessionStore.prototype, 'readMeta').mockResolvedValue({
      version: 1,
      engine: 'memvid-session-store',
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
    const recall = vi.spyOn(MemvidSessionStore.prototype, 'recall').mockResolvedValue([]);
    const touchByHashes = vi.spyOn(MemvidSessionStore.prototype, 'touchByHashes').mockResolvedValue([]);

    try {
      const result = await prepareInteractiveSessionMemory({
        cwd: '/tmp/session-memory-engine-empty',
        sessionId: 'session_1',
        userInput: 'brand new question',
        checkpointState: {
          storeSessionId: 'session_1',
          engine: 'memvid-session-store',
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
    } finally {
      open.mockRestore();
      readMeta.mockRestore();
      verifyOpen.mockRestore();
      recall.mockRestore();
      touchByHashes.mockRestore();
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
          memoryType: 'fact',
          retrievalScore: 0.95,
          importance: 0.9,
          explicitSave: true,
          summaryText: 'Prefer concise answers in Vietnamese.',
          essenceText: 'Vietnamese concise.'
        }),
        createCandidate({
          hash: 'proc123def456',
          memoryType: 'procedure',
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
});
