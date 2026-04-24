import { describe, expect, it } from 'vitest';

import { buildDoneCriteria } from '../../src/agent/doneCriteria.js';
import { createTaskContract } from '../../src/agent/taskContract.js';

describe('createTaskContract', () => {
  it('builds a deterministic contract from done criteria flags', () => {
    const contract = createTaskContract({
      taskId: 'task-123',
      userInput: 'Inspect the repo and explain what changed',
      criteria: buildDoneCriteria('Inspect the repo and explain what changed', {
        completionMode: 'tool_verified_answer',
        doneCriteriaShape: 'inspection',
        evidenceRequirement: 'tool evidence + substantive answer',
        stopVsDoneDistinction: 'stop only counts when inspection evidence is present',
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

  it('records structured specialist artifacts as explicit expected evidence for specialist goals', () => {
    const contract = createTaskContract({
      taskId: 'task-specialist-review',
      userInput: '/review check this patch',
      criteria: buildDoneCriteria('/review check this patch', {
        completionMode: 'specialist_review',
        doneCriteriaShape: 'specialist_artifact',
        evidenceRequirement: 'parsed specialist artifact + substantive answer',
        stopVsDoneDistinction: 'specialist output only counts when the artifact is structured',
        maxToolRounds: 10,
        requiresToolEvidence: false,
        requiresSubstantiveFinalAnswer: true,
        forbidSuccessAfterToolErrors: true
      }),
      createdAt: '2026-04-24T10:00:00.000Z'
    });

    expect(contract.expectedEvidence).toContain('structured specialist artifact required');
  });
});
