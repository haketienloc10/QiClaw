import type { AgentTurnStopReason } from './loop.js';
import type { AgentTurnVerification } from './verifier.js';
import type { TaskContract } from './taskContract.js';

export type TaskVerdictStatus = 'passed' | 'failed' | 'inconclusive';

export interface TaskVerdictCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface TaskVerdict {
  taskId: string;
  status: TaskVerdictStatus;
  isCompleted: boolean;
  checks: TaskVerdictCheck[];
  evidenceSummary: string;
  finalAnswerSummary: string;
  createdAt: string;
}

export interface CreateTaskVerdictInput {
  contract: TaskContract;
  verification: AgentTurnVerification;
  finalAnswer: string;
  stopReason: AgentTurnStopReason;
  turnCompleted: boolean;
  createdAt?: string;
}

export function createTaskVerdict(input: CreateTaskVerdictInput): TaskVerdict {
  const status = resolveStatus(input);

  return {
    taskId: input.contract.taskId,
    status,
    isCompleted: status === 'passed',
    checks: input.verification.checks.map((check) => ({ ...check })),
    evidenceSummary: buildEvidenceSummary(input),
    finalAnswerSummary: buildFinalAnswerSummary(input),
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

function resolveStatus(input: CreateTaskVerdictInput): TaskVerdictStatus {
  if (!input.turnCompleted || input.stopReason === 'max_tool_rounds_reached') {
    return 'inconclusive';
  }

  return input.verification.isVerified ? 'passed' : 'failed';
}

function buildEvidenceSummary(input: CreateTaskVerdictInput): string {
  if (!input.turnCompleted || input.stopReason === 'max_tool_rounds_reached') {
    return 'Turn ended before enough evidence was collected to confirm completion.';
  }

  if (!input.verification.toolEvidenceSatisfied) {
    return 'Required tool evidence was not satisfied.';
  }

  if (!input.verification.noUnresolvedToolErrors) {
    return 'Tool errors remain unresolved, so success cannot be confirmed.';
  }

  if (input.verification.toolMessagesCount > 0) {
    return `Observed ${input.verification.toolMessagesCount} successful tool result(s).`;
  }

  return 'No tool evidence was required for this task.';
}

function buildFinalAnswerSummary(input: CreateTaskVerdictInput): string {
  const finalAnswer = input.finalAnswer.trim();

  if (!input.turnCompleted || input.stopReason === 'max_tool_rounds_reached') {
    return 'Final answer cannot establish completion because the turn stopped early.';
  }

  if (finalAnswer.length === 0) {
    return 'Final answer is empty.';
  }

  if (!input.verification.finalAnswerIsSubstantive) {
    return 'Final answer is meta-only and not substantive enough.';
  }

  return `Final answer is substantive: ${summarizeText(finalAnswer)}`;
}

function summarizeText(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}
