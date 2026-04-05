import { describe, expect, it } from 'vitest';

import { scoreSessionMemoryCandidate } from '../../src/memory/decay.js';
import type { SessionMemoryCandidate } from '../../src/memory/sessionMemoryTypes.js';

function createCandidate(overrides: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    memoryType: 'fact',
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

  it('boosts explicit saves and higher-importance memories above equally retrieved candidates', () => {
    const now = '2026-04-05T12:00:00.000Z';

    const baseline = scoreSessionMemoryCandidate(createCandidate(), { now });
    const boosted = scoreSessionMemoryCandidate(
      createCandidate({
        explicitSave: true,
        importance: 0.9
      }),
      { now }
    );

    expect(boosted).toBeGreaterThan(baseline);
  });
});
