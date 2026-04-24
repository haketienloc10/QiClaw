import { describe, expect, it } from 'vitest';

import { routeSpecialist } from '../../src/specialist/router.js';

describe('routeSpecialist', () => {
  it('routes research prompts to the research specialist', () => {
    const decision = routeSpecialist('Find and analyze the auth flow in this codebase.');

    expect(decision.kind).toBe('specialist');
    expect(decision.specialist).toBe('research');
    expect(decision.reason).toBe('heuristic');
  });

  it('routes debug prompts to the debug specialist', () => {
    const decision = routeSpecialist('Investigate this stack trace and find the root cause of the crash.');

    expect(decision.kind).toBe('specialist');
    expect(decision.specialist).toBe('debug');
    expect(decision.reason).toBe('heuristic');
  });

  it('routes review prompts to the review specialist', () => {
    const decision = routeSpecialist('Please review this patch and check invariants for regressions.');

    expect(decision.kind).toBe('specialist');
    expect(decision.specialist).toBe('review');
    expect(decision.reason).toBe('heuristic');
  });

  it('prefers explicit slash commands over heuristics', () => {
    const decision = routeSpecialist('/review Find and analyze this module for issues.');

    expect(decision.kind).toBe('specialist');
    expect(decision.specialist).toBe('review');
    expect(decision.reason).toBe('explicit');
  });

  it('leaves normal prompts on the main flow', () => {
    expect(routeSpecialist('Hello there, can you help me?')).toEqual({
      kind: 'main'
    });
  });
});
