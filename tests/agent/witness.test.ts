import { describe, expect, it, vi } from 'vitest';

import { createTaskContract } from '../../src/agent/taskContract.js';
import { finalizeWitnessTurn } from '../../src/agent/witness.js';
import * as taskLedgerModule from '../../src/session/taskLedger.js';

describe('finalizeWitnessTurn', () => {
  it('does not throw when ledger append fails', () => {
    const appendSpy = vi.spyOn(taskLedgerModule, 'appendTaskLedgerRecord').mockImplementation(() => {
      throw new Error('disk full');
    });

    const contract = createTaskContract({
      taskId: 'task-1',
      userInput: 'say hi',
      criteria: {
        goal: 'say hi',
        checklist: ['say hi'],
        requiresNonEmptyFinalAnswer: true,
        requiresToolEvidence: false,
        requiresSubstantiveFinalAnswer: false,
        forbidSuccessAfterToolErrors: false
      },
      createdAt: '2026-04-23T10:00:00.000Z'
    });

    expect(() => finalizeWitnessTurn({
      contract,
      verification: {
        isVerified: true,
        finalAnswerIsNonEmpty: true,
        finalAnswerIsSubstantive: true,
        toolEvidenceSatisfied: true,
        noUnresolvedToolErrors: true,
        toolMessagesCount: 0,
        checks: []
      },
      finalAnswer: 'Hello',
      stopReason: 'completed',
      turnCompleted: true,
      ledgerPath: '/tmp/witness-ledger.jsonl',
      sessionId: 'session-1',
      userInput: 'say hi',
      toolRoundsUsed: 0,
      createdAt: '2026-04-23T10:00:01.000Z'
    })).not.toThrow();

    expect(appendSpy).toHaveBeenCalledOnce();
  });
});
