import { describe, expect, it } from 'vitest';

import { buildDoneCriteria } from '../../src/agent/doneCriteria.js';
import { createTaskContract } from '../../src/agent/taskContract.js';

describe('createTaskContract', () => {
  it('builds a deterministic contract from done criteria flags', () => {
    const contract = createTaskContract({
      taskId: 'task-123',
      userInput: 'Inspect the repo and explain what changed',
      criteria: buildDoneCriteria('Inspect the repo and explain what changed', {
        maxToolRounds: 3,
        requiresToolEvidence: true,
        requiresSubstantiveFinalAnswer: true,
        forbidSuccessAfterToolErrors: true
      }),
      createdAt: '2026-04-23T10:00:00.000Z'
    });

    expect(contract).toEqual({
      taskId: 'task-123',
      goal: 'Inspect the repo and explain what changed',
      requiresToolEvidence: true,
      requiresSubstantiveFinalAnswer: true,
      forbidSuccessAfterToolErrors: true,
      expectedEvidence: [
        'at least one successful tool result',
        'final answer must contain non-meta substantive content',
        'cannot claim success if tool errors remain'
      ],
      createdAt: '2026-04-23T10:00:00.000Z'
    });
  });
});
