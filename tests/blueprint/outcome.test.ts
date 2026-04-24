import { describe, expect, it } from 'vitest';

import { applyBlueprintOutcome, deriveBlueprintOutcome } from '../../src/blueprint/outcome.js';
import type { BlueprintRecord } from '../../src/blueprint/types.js';
import type { RunAgentTurnResult } from '../../src/agent/loop.js';

function createBlueprint(overrides: Partial<BlueprintRecord> = {}): BlueprintRecord {
  return {
    id: 'bp_deploy_rollback',
    title: 'Deploy rollback investigation',
    goal: 'Handle deploy rollback requests safely.',
    trigger: {
      title: 'Deploy rollback',
      patterns: ['deploy rollback'],
      tags: ['deploy', 'rollback']
    },
    preconditions: [],
    steps: [
      {
        id: 'inspect_logs',
        title: 'Inspect logs',
        instruction: 'Read deployment logs before taking action.',
        kind: 'inspect'
      }
    ],
    branches: [],
    expectedEvidence: [
      { description: 'Deployment logs reviewed.', kind: 'tool_result', required: true }
    ],
    failureModes: [],
    tags: ['deploy', 'rollback'],
    source: 'fixture:test',
    createdAt: '2026-04-23T10:00:00.000Z',
    updatedAt: '2026-04-23T10:00:00.000Z',
    status: 'active',
    stats: {
      useCount: 0,
      successCount: 0,
      failureCount: 0
    },
    ...overrides
  };
}

function createTurnResult(overrides: Partial<RunAgentTurnResult> = {}): RunAgentTurnResult {
  return {
    stopReason: 'completed',
    finalAnswer: 'Done.',
    history: [],
    memoryCandidates: [],
    structuredOutputParsed: false,
    toolRoundsUsed: 1,
    doneCriteria: {
      goal: 'Handle deploy rollback safely.',
      checklist: ['Handle deploy rollback safely.'],
      requiresNonEmptyFinalAnswer: true,
      requiresToolEvidence: false,
      requiresSubstantiveFinalAnswer: false,
      forbidSuccessAfterToolErrors: false
    },
    verification: {
      isVerified: true,
      finalAnswerIsNonEmpty: true,
      finalAnswerIsSubstantive: true,
      toolEvidenceSatisfied: true,
      noUnresolvedToolErrors: true,
      toolMessagesCount: 1,
      checks: []
    },
    ...overrides
  };
}

describe('deriveBlueprintOutcome', () => {
  it('marks completed and verified turns as success', () => {
    expect(deriveBlueprintOutcome(createTurnResult())).toEqual({
      used: true,
      status: 'success'
    });
  });

  it('marks unverified or incomplete turns as failure', () => {
    expect(deriveBlueprintOutcome(createTurnResult({
      stopReason: 'max_tool_rounds_reached',
      verification: {
        isVerified: false,
        finalAnswerIsNonEmpty: true,
        finalAnswerIsSubstantive: true,
        toolEvidenceSatisfied: true,
        noUnresolvedToolErrors: true,
        toolMessagesCount: 1,
        checks: []
      }
    }))).toEqual({
      used: true,
      status: 'failure'
    });
  });
});

describe('applyBlueprintOutcome', () => {
  it('increments use and success stats for successful turns', () => {
    const updated = applyBlueprintOutcome({
      blueprint: createBlueprint(),
      outcome: { used: true, status: 'success' },
      now: '2026-04-24T08:00:00.000Z'
    });

    expect(updated.stats).toEqual({
      useCount: 1,
      successCount: 1,
      failureCount: 0,
      lastUsedAt: '2026-04-24T08:00:00.000Z',
      lastSucceededAt: '2026-04-24T08:00:00.000Z'
    });
  });

  it('increments failure stats for failed turns', () => {
    const updated = applyBlueprintOutcome({
      blueprint: createBlueprint(),
      outcome: { used: true, status: 'failure' },
      now: '2026-04-24T09:00:00.000Z'
    });

    expect(updated.stats).toEqual({
      useCount: 1,
      successCount: 0,
      failureCount: 1,
      lastUsedAt: '2026-04-24T09:00:00.000Z',
      lastFailedAt: '2026-04-24T09:00:00.000Z'
    });
  });
});
