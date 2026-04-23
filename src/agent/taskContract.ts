import type { DoneCriteria } from './doneCriteria.js';

export interface TaskContract {
  taskId: string;
  goal: string;
  expectedEvidence: string[];
  requiresToolEvidence: boolean;
  requiresSubstantiveFinalAnswer: boolean;
  forbidSuccessAfterToolErrors: boolean;
  createdAt: string;
}

export interface CreateTaskContractInput {
  taskId: string;
  userInput: string;
  criteria: DoneCriteria;
  createdAt?: string;
}

export function createTaskContract(input: CreateTaskContractInput): TaskContract {
  return {
    taskId: input.taskId,
    goal: input.criteria.goal || input.userInput.trim(),
    requiresToolEvidence: input.criteria.requiresToolEvidence,
    requiresSubstantiveFinalAnswer: input.criteria.requiresSubstantiveFinalAnswer,
    forbidSuccessAfterToolErrors: input.criteria.forbidSuccessAfterToolErrors,
    expectedEvidence: buildExpectedEvidence(input.criteria),
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

function buildExpectedEvidence(criteria: DoneCriteria): string[] {
  const evidence: string[] = [];

  if (criteria.requiresToolEvidence) {
    evidence.push('at least one successful tool result');
  }

  if (criteria.requiresSubstantiveFinalAnswer) {
    evidence.push('final answer must contain non-meta substantive content');
  }

  if (criteria.forbidSuccessAfterToolErrors) {
    evidence.push('cannot claim success if tool errors remain');
  }

  return evidence;
}
