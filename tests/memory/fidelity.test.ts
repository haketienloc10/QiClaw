import { describe, expect, it } from 'vitest';

import { assignMemoryFidelity } from '../../src/memory/fidelity.js';
import type { SessionMemoryCandidate } from '../../src/memory/sessionMemoryTypes.js';

function createCandidate(overrides: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    kind: 'fact',
    fullText: 'This is the full memory text with enough characters to exceed tiny budgets.',
    summaryText: 'Short summary for warm recall.',
    essenceText: 'Tiny essence.',
    tags: ['runtime'],
    source: 'turn-1',
    sourceTurnId: 'turn-1',
    markdownPath: '/tmp/session-memory.md',
    status: 'active',
    createdAt: '2026-04-05T10:00:00.000Z',
    updatedAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z',
    accessCount: 0,
    importance: 0.6,
    explicitSave: false,
    retrievalScore: 0.5,
    finalScore: 0.5,
    fidelity: 'summary',
    ...overrides
  };
}

describe('assignMemoryFidelity', () => {
  it('keeps hot memories at full fidelity when the budget allows it', () => {
    const result = assignMemoryFidelity(createCandidate({ finalScore: 0.95 }), {
      remainingChars: 200,
      hotThreshold: 0.85,
      warmThreshold: 0.5
    });

    expect(result.fidelity).toBe('full');
    expect(result.renderedText).toBe(result.candidate.fullText);
  });

  it('downgrades warm memories to summaries and cool ones to essence/hash as budget shrinks', () => {
    const warm = assignMemoryFidelity(createCandidate({ finalScore: 0.6 }), {
      remainingChars: 40,
      hotThreshold: 0.85,
      warmThreshold: 0.5
    });
    const cool = assignMemoryFidelity(createCandidate({ finalScore: 0.2 }), {
      remainingChars: 8,
      hotThreshold: 0.85,
      warmThreshold: 0.5
    });

    expect(warm.fidelity).toBe('summary');
    expect(warm.renderedText).toBe(warm.candidate.summaryText);
    expect(cool.fidelity).toBe('hash');
    expect(cool.renderedText).toContain('#abc123def456');
  });
});
