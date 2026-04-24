import { describe, expect, it } from 'vitest';

import { buildDoneCriteria } from '../../src/agent/doneCriteria.js';
import type { Message } from '../../src/core/types.js';
import type { ToolResultMessage } from '../../src/provider/model.js';
import { createTaskContract } from '../../src/agent/taskContract.js';
import { createTaskVerdict } from '../../src/agent/taskVerdict.js';
import { verifyAgentTurn } from '../../src/agent/verifier.js';

function buildInspectionCompletionSpec() {
  return {
    completionMode: 'tool_verified_answer',
    doneCriteriaShape: 'inspection',
    evidenceRequirement: 'tool evidence + substantive answer',
    stopVsDoneDistinction: 'stop only counts when inspection evidence is present',
    maxToolRounds: 3,
    requiresToolEvidence: true,
    requiresSubstantiveFinalAnswer: true,
    forbidSuccessAfterToolErrors: true
  };
}

function buildContract(goal: string) {
  return createTaskContract({
    taskId: 'task-123',
    userInput: goal,
    criteria: buildDoneCriteria(goal, buildInspectionCompletionSpec()),
    createdAt: '2026-04-23T10:00:00.000Z'
  });
}

describe('createTaskVerdict', () => {
  it('returns passed when evidence is sufficient and the final answer is substantive', () => {
    const contract = buildContract('Inspect the file and explain the result');
    const history = [
      { role: 'user', content: 'Inspect the file and explain the result' },
      { role: 'assistant', content: 'I will inspect the file.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-1',
        content: 'one line',
        isError: false
      } satisfies ToolResultMessage,
      { role: 'assistant', content: 'The file contains one line.' }
    ] satisfies Array<Message | ToolResultMessage>;

    const verification = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result', buildInspectionCompletionSpec()),
      finalAnswer: 'The file contains one line.',
      history: history as Message[]
    });

    expect(createTaskVerdict({
      contract,
      verification,
      finalAnswer: 'The file contains one line.',
      stopReason: 'completed',
      turnCompleted: true,
      createdAt: '2026-04-23T10:00:01.000Z'
    })).toMatchObject({
      taskId: 'task-123',
      status: 'passed',
      isCompleted: true,
      createdAt: '2026-04-23T10:00:01.000Z'
    });
  });

  it('does not return passed when tool errors remain and the answer overclaims success', () => {
    const contract = buildContract('Inspect the file and explain the result');
    const history = [
      { role: 'user', content: 'Inspect the file and explain the result' },
      { role: 'assistant', content: 'I will inspect the file.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-1',
        content: 'missing.txt',
        isError: true
      } satisfies ToolResultMessage,
      { role: 'assistant', content: 'Done.' }
    ] satisfies Array<Message | ToolResultMessage>;

    const verification = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result', buildInspectionCompletionSpec()),
      finalAnswer: 'Done.',
      history: history as Message[]
    });

    expect(createTaskVerdict({
      contract,
      verification,
      finalAnswer: 'Done.',
      stopReason: 'completed',
      turnCompleted: true,
      createdAt: '2026-04-23T10:00:01.000Z'
    })).toMatchObject({
      status: 'failed',
      isCompleted: false
    });
  });

  it('fails when required tool evidence is missing even if the answer is non-empty', () => {
    const contract = buildContract('Inspect the file and explain the result');
    const verification = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result', buildInspectionCompletionSpec()),
      finalAnswer: 'I checked it.',
      history: [{ role: 'user', content: 'Inspect the file and explain the result' }]
    });

    expect(createTaskVerdict({
      contract,
      verification,
      finalAnswer: 'I checked it.',
      stopReason: 'completed',
      turnCompleted: true,
      createdAt: '2026-04-23T10:00:01.000Z'
    })).toMatchObject({
      status: 'failed',
      isCompleted: false
    });
  });

  it('fails when the final answer is meta-only and substantive content is required', () => {
    const contract = buildContract('Inspect the file and explain the result');
    const verification = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result', buildInspectionCompletionSpec()),
      finalAnswer: 'Done.',
      history: [
        { role: 'user', content: 'Inspect the file and explain the result' },
        {
          role: 'tool',
          name: 'read_file',
          toolCallId: 'call-1',
          content: 'one line',
          isError: false
        } as const
      ]
    });

    expect(createTaskVerdict({
      contract,
      verification,
      finalAnswer: 'Done.',
      stopReason: 'completed',
      turnCompleted: true,
      createdAt: '2026-04-23T10:00:01.000Z'
    })).toMatchObject({
      status: 'failed',
      isCompleted: false
    });
  });

  it('returns inconclusive when max tool rounds are reached', () => {
    const contract = buildContract('Inspect the file and explain the result');
    const verification = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result', buildInspectionCompletionSpec()),
      finalAnswer: 'Still working.',
      history: [{ role: 'user', content: 'Inspect the file and explain the result' }],
      turnCompleted: false
    });

    expect(createTaskVerdict({
      contract,
      verification,
      finalAnswer: 'Still working.',
      stopReason: 'max_tool_rounds_reached',
      turnCompleted: false,
      createdAt: '2026-04-23T10:00:01.000Z'
    })).toMatchObject({
      status: 'inconclusive',
      isCompleted: false
    });
  });
});
