import { describe, expect, it } from 'vitest';

import {
  buildPersistedMemoryRecord,
  buildRecallCandidate,
  buildSessionMemoryUri,
  parseSessionMemoryUri
} from '../../src/memory/sessionMemoryTypes.js';

describe('session memory uri helpers', () => {
  it('builds and parses session memory uris deterministically', () => {
    const uri = buildSessionMemoryUri('session_123', 'abc123def456');

    expect(uri).toBe('mv2://sessions/session_123/memory/abc123def456');
    expect(parseSessionMemoryUri(uri)).toEqual({
      sessionId: 'session_123',
      hash: 'abc123def456'
    });
  });

  it('rejects uris outside the session memory namespace', () => {
    expect(parseSessionMemoryUri('mv2://projects/qiclaw/memory/abc123')).toBeUndefined();
  });
});

describe('persisted memory record helpers', () => {
  it('builds a persisted memory record with normalized lifecycle fields', () => {
    const record = buildPersistedMemoryRecord({
      hash: 'abc123def456',
      sessionId: 'session_1',
      kind: 'fact',
      summaryText: 'Use concise Vietnamese.',
      essenceText: 'Vietnamese preference.',
      fullText: 'Always answer in Vietnamese unless explicitly asked otherwise.',
      tags: ['language', 'style'],
      source: 'turn-1',
      sourceTurnId: 'turn-1',
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z',
      accessCount: 0,
      importance: 0.8,
      explicitSave: true,
      markdownPath: '/tmp/memory/2026-04-05/fact/abc123def456.md'
    });

    expect(record).toEqual({
      hash: 'abc123def456',
      sessionId: 'session_1',
      kind: 'fact',
      summaryText: 'Use concise Vietnamese.',
      essenceText: 'Vietnamese preference.',
      fullText: 'Always answer in Vietnamese unless explicitly asked otherwise.',
      tags: ['language', 'style'],
      source: 'turn-1',
      sourceTurnId: 'turn-1',
      createdAt: '2026-04-05T10:00:00.000Z',
      updatedAt: '2026-04-05T10:00:00.000Z',
      invalidatedAt: undefined,
      status: 'active',
      lastAccessed: '2026-04-05T10:00:00.000Z',
      accessCount: 0,
      importance: 0.8,
      explicitSave: true,
      markdownPath: '/tmp/memory/2026-04-05/fact/abc123def456.md'
    });
    expect(record).not.toHaveProperty('memoryType');
  });

  it('keeps explicit lifecycle fields when building a persisted memory record', () => {
    const record = buildPersistedMemoryRecord({
      hash: 'abc123def456',
      sessionId: 'session_1',
      kind: 'fact',
      summaryText: 'Superseded memory.',
      essenceText: 'Old preference.',
      fullText: 'This memory has been replaced.',
      tags: [],
      source: 'turn-2',
      createdAt: '2026-04-05T10:00:00.000Z',
      updatedAt: '2026-04-06T02:00:00.000Z',
      invalidatedAt: '2026-04-06T03:00:00.000Z',
      status: 'invalidated',
      lastAccessed: '2026-04-05T10:00:00.000Z',
      accessCount: 3,
      importance: 0.5,
      explicitSave: false,
      markdownPath: '/tmp/memory/2026-04-05/fact/abc123def456.md'
    });

    expect(record.status).toBe('invalidated');
    expect(record.updatedAt).toBe('2026-04-06T02:00:00.000Z');
    expect(record.invalidatedAt).toBe('2026-04-06T03:00:00.000Z');
  });
});

describe('recall candidate helpers', () => {
  it('builds a recall candidate without mutating persisted lifecycle fields', () => {
    const persisted = buildPersistedMemoryRecord({
      hash: 'abc123def456',
      sessionId: 'session_1',
      kind: 'fact',
      summaryText: 'Use concise Vietnamese.',
      essenceText: 'Vietnamese preference.',
      fullText: 'Always answer in Vietnamese unless explicitly asked otherwise.',
      tags: ['language'],
      source: 'turn-1',
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z',
      accessCount: 1,
      importance: 0.8,
      explicitSave: true,
      markdownPath: '/tmp/memory/2026-04-05/fact/abc123def456.md'
    });

    const candidate = buildRecallCandidate({
      record: persisted,
      retrievalScore: 4.25,
      finalScore: 0,
      fidelity: 'summary'
    });

    expect(candidate).toEqual({
      hash: 'abc123def456',
      sessionId: 'session_1',
      kind: 'fact',
      summaryText: 'Use concise Vietnamese.',
      essenceText: 'Vietnamese preference.',
      fullText: 'Always answer in Vietnamese unless explicitly asked otherwise.',
      tags: ['language'],
      source: 'turn-1',
      sourceTurnId: undefined,
      createdAt: '2026-04-05T10:00:00.000Z',
      updatedAt: '2026-04-05T10:00:00.000Z',
      invalidatedAt: undefined,
      status: 'active',
      lastAccessed: '2026-04-05T10:00:00.000Z',
      accessCount: 1,
      importance: 0.8,
      explicitSave: true,
      markdownPath: '/tmp/memory/2026-04-05/fact/abc123def456.md',
      retrievalScore: 4.25,
      finalScore: 0,
      fidelity: 'summary'
    });
    expect(candidate).not.toHaveProperty('memoryType');
  });
});
