import type { Message } from '../core/types.js';
import type { ToolResultMessage } from '../provider/model.js';

import type { DoneCriteria } from './doneCriteria.js';

const META_ONLY_FINAL_ANSWER_PATTERNS = [
  /^(done|completed|finished|all set|ok|okay|sure|here you go)[.!]?$/i,
  /^i (am|have) (done|finished)(\.|!)*$/i,
  /^handled(\.|!)*$/i
];

const SUCCESS_CLAIM_PATTERNS = [
  /\bdone\b/i,
  /\bcompleted\b/i,
  /\bfinished\b/i,
  /\bsuccess(?:fully)?\b/i,
  /\bthe task is complete\b/i,
  /\ball set\b/i,
  /\bhandled\b/i
];

export interface VerificationCheck {
  name: 'turn_completed' | 'final_answer_non_empty' | 'tool_evidence' | 'final_answer_substantive' | 'no_unresolved_tool_errors';
  passed: boolean;
  details: string;
}

export interface AgentTurnVerification {
  isVerified: boolean;
  finalAnswerIsNonEmpty: boolean;
  finalAnswerIsSubstantive: boolean;
  toolEvidenceSatisfied: boolean;
  noUnresolvedToolErrors: boolean;
  toolMessagesCount: number;
  checks: VerificationCheck[];
}

export interface VerifyAgentTurnInput {
  criteria: DoneCriteria;
  finalAnswer: string;
  history: Message[];
  turnCompleted?: boolean;
}

export function verifyAgentTurn(input: VerifyAgentTurnInput): AgentTurnVerification {
  const turnCompleted = input.turnCompleted ?? true;
  const finalAnswer = input.finalAnswer.trim();
  const finalAnswerIsNonEmpty = turnCompleted && finalAnswer.length > 0;
  const toolMessages = input.history.filter(isSuccessfulToolMessage);
  const toolMessagesCount = toolMessages.length;
  const toolEvidenceSatisfied = input.criteria.requiresToolEvidence ? toolMessagesCount > 0 : true;
  const finalAnswerIsSubstantive = input.criteria.requiresSubstantiveFinalAnswer
    ? finalAnswerIsNonEmpty && !isMetaOnlyFinalAnswer(finalAnswer)
    : true;
  const toolErrorsCount = input.history.filter(isToolErrorMessage).length;
  const noUnresolvedToolErrors = input.criteria.forbidSuccessAfterToolErrors
    ? toolErrorsCount === 0 || !looksLikeSuccessClaim(finalAnswer)
    : true;

  const checks: VerificationCheck[] = [
    {
      name: 'turn_completed',
      passed: turnCompleted,
      details: turnCompleted
        ? 'Agent turn reached a provider stop with no remaining tool calls.'
        : 'Agent turn stopped before the provider produced a final post-tool answer.'
    },
    {
      name: 'final_answer_non_empty',
      passed: finalAnswerIsNonEmpty,
      details: turnCompleted
        ? finalAnswerIsNonEmpty
          ? 'Final answer is non-empty.'
          : 'Final answer is empty.'
        : 'Final answer is not accepted because the turn stopped before completion.'
    },
    {
      name: 'tool_evidence',
      passed: toolEvidenceSatisfied,
      details: buildToolEvidenceDetails(input.criteria, toolMessagesCount, toolEvidenceSatisfied)
    },
    {
      name: 'final_answer_substantive',
      passed: finalAnswerIsSubstantive,
      details: buildFinalAnswerSubstantiveDetails(input.criteria, finalAnswer, finalAnswerIsSubstantive)
    },
    {
      name: 'no_unresolved_tool_errors',
      passed: noUnresolvedToolErrors,
      details: buildToolErrorConsistencyDetails(input.criteria, toolErrorsCount, finalAnswer, noUnresolvedToolErrors)
    }
  ];

  return {
    isVerified: checks.every((check) => check.passed),
    finalAnswerIsNonEmpty,
    finalAnswerIsSubstantive,
    toolEvidenceSatisfied,
    noUnresolvedToolErrors,
    toolMessagesCount,
    checks
  };
}

function buildToolEvidenceDetails(
  criteria: DoneCriteria,
  toolMessagesCount: number,
  toolEvidenceSatisfied: boolean
): string {
  if (!criteria.requiresToolEvidence) {
    return 'Tool evidence not required for this goal.';
  }

  if (toolEvidenceSatisfied) {
    return `Observed ${toolMessagesCount} tool message(s) for an inspection-style goal.`;
  }

  return `Expected at least one tool message because: ${criteria.toolEvidenceReason}`;
}

function buildFinalAnswerSubstantiveDetails(
  criteria: DoneCriteria,
  finalAnswer: string,
  finalAnswerIsSubstantive: boolean
): string {
  if (!criteria.requiresSubstantiveFinalAnswer) {
    return 'Substantive final answer not required for this goal.';
  }

  if (finalAnswerIsSubstantive) {
    return 'Final answer is substantive enough for completion.';
  }

  if (finalAnswer.length === 0) {
    return 'Final answer cannot be substantive because it is empty.';
  }

  return 'Final answer is too meta-only to satisfy completion.';
}

function buildToolErrorConsistencyDetails(
  criteria: DoneCriteria,
  toolErrorsCount: number,
  finalAnswer: string,
  noUnresolvedToolErrors: boolean
): string {
  if (!criteria.forbidSuccessAfterToolErrors) {
    return 'Tool-error consistency check not required for this goal.';
  }

  if (noUnresolvedToolErrors) {
    return toolErrorsCount === 0
      ? 'No tool errors observed during the turn.'
      : 'Tool errors were observed, and the final answer does not overclaim success.';
  }

  return `Observed ${toolErrorsCount} tool error(s), so the final answer cannot present the task as completed successfully.`;
}

function isMetaOnlyFinalAnswer(finalAnswer: string): boolean {
  const normalized = finalAnswer.trim().toLowerCase();

  return META_ONLY_FINAL_ANSWER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeSuccessClaim(finalAnswer: string): boolean {
  const normalized = finalAnswer.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return SUCCESS_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSuccessfulToolMessage(message: Message): message is ToolResultMessage {
  return message.role === 'tool' && 'isError' in message && message.isError === false;
}

function isToolErrorMessage(message: Message): message is ToolResultMessage {
  return message.role === 'tool' && 'isError' in message && message.isError === true;
}
