import { describe, expect, it } from 'vitest';

import { scoreSessionMemoryCandidate } from '../../src/memory/decay.js';
import type { SessionMemoryCandidate } from '../../src/memory/sessionMemoryTypes.js';

function createCandidate(overrides: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    kind: 'fact',
    fullText: 'Full text',
    summaryText: 'Summary',
    essenceText: 'Essence',
    tags: ['runtime'],
    source: 'turn-1',
    sourceTurnId: 'turn-1',
    createdAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z',
    accessCount: 0,
    importance: 0.4,
    explicitSave: false,
    retrievalScore: 0.5,
    finalScore: 0,
    fidelity: 'summary',
    ...overrides
  };
}

describe('scoreSessionMemoryCandidate', () => {
  it('scores newer or more recently accessed memories higher when other factors are equal', () => {
    const now = '2026-04-05T12:00:00.000Z';

    const stale = scoreSessionMemoryCandidate(
      createCandidate({
        createdAt: '2026-04-04T08:00:00.000Z',
        lastAccessed: '2026-04-04T09:00:00.000Z'
      }),
      { now }
    );
    const fresh = scoreSessionMemoryCandidate(
      createCandidate({
        createdAt: '2026-04-05T11:30:00.000Z',
        lastAccessed: '2026-04-05T11:45:00.000Z'
      }),
      { now }
    );

    expect(fresh).toBeGreaterThan(stale);
  });

  it('gives explicit saves a small edge when retrieval is otherwise equal', () => {
    const now = '2026-04-05T12:00:00.000Z';

    const baseline = scoreSessionMemoryCandidate(createCandidate(), { now });
    const boosted = scoreSessionMemoryCandidate(
      createCandidate({
        explicitSave: true
      }),
      { now }
    );

    expect(boosted).toBeGreaterThan(baseline);
  });

  it('keeps a large retrieval mismatch ahead despite freshness and explicit save', () => {
    const now = '2026-04-05T12:00:00.000Z';

    const highRetrieval = scoreSessionMemoryCandidate(
      createCandidate({
        retrievalScore: 0.95,
        importance: 0.2,
        explicitSave: false,
        createdAt: '2026-04-05T02:00:00.000Z',
        lastAccessed: '2026-04-05T02:00:00.000Z'
      }),
      { now }
    );
    const freshExplicit = scoreSessionMemoryCandidate(
      createCandidate({
        retrievalScore: 0.1,
        importance: 0.4,
        explicitSave: true,
        createdAt: '2026-04-05T11:59:00.000Z',
        lastAccessed: '2026-04-05T11:59:00.000Z'
      }),
      { now }
    );

    expect(highRetrieval).toBeGreaterThan(freshExplicit);
  });

  it('falls back to createdAt when lastAccessed is invalid', () => {
    const now = '2026-04-05T12:00:00.000Z';

    const stale = scoreSessionMemoryCandidate(
      createCandidate({
        createdAt: '2026-04-04T08:00:00.000Z',
        lastAccessed: 'not-a-date'
      }),
      { now }
    );
    const fresh = scoreSessionMemoryCandidate(
      createCandidate({
        createdAt: '2026-04-05T11:30:00.000Z',
        lastAccessed: 'not-a-date'
      }),
      { now }
    );

    expect(fresh).toBeGreaterThan(stale);
  });

  it('uses decayed importance directly instead of scaling it by a separate weight', () => {
    const now = '2026-04-05T12:00:00.000Z';
    const candidate = createCandidate({
      retrievalScore: 0.5,
      importance: 0.4,
      explicitSave: false,
      accessCount: 0,
      createdAt: '2026-04-05T10:00:00.000Z',
      lastAccessed: '2026-04-05T10:00:00.000Z'
    });

    const score = scoreSessionMemoryCandidate(candidate, { now, ageDecayHours: 24 });
    const expected = 0.5 + 0.4 * Math.exp(-2 / 24);

    expect(score).toBeCloseTo(expected, 6);
  });

  it('adds only a small access boost on top of the decayed score', () => {
    const now = '2026-04-05T12:00:00.000Z';

    const baseline = scoreSessionMemoryCandidate(createCandidate(), { now });
    const accessed = scoreSessionMemoryCandidate(
      createCandidate({ accessCount: 9 }),
      { now }
    );

    expect(accessed).toBeGreaterThan(baseline);
    expect(accessed - baseline).toBeLessThan(0.2);
  });
});
