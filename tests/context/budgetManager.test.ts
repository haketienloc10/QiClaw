import { describe, expect, it } from 'vitest';

import { allocateContextBudget } from '../../src/context/budgetManager.js';

describe('allocateContextBudget', () => {
  it('returns deterministic buckets that sum to the requested total', () => {
    const allocation = allocateContextBudget({
      total: 1000,
      reserveChars: 50
    });

    expect(allocation).toEqual({
      total: 1000,
      reserved: 50,
      available: 950,
      buckets: {
        system: 238,
        recentHistory: 332,
        memory: 142,
        skills: 95,
        oldHistory: 143
      }
    });
  });

  it('never returns negative buckets when reserve exceeds total', () => {
    expect(
      allocateContextBudget({
        total: 80,
        reserveChars: 100
      })
    ).toEqual({
      total: 80,
      reserved: 80,
      available: 0,
      buckets: {
        system: 0,
        recentHistory: 0,
        memory: 0,
        skills: 0,
        oldHistory: 0
      }
    });
  });
});
