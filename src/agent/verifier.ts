import type { Message } from '../core/types.js';
import type { ToolResultMessage } from '../provider/model.js';

import type { DoneCriteria } from './doneCriteria.js';

export interface VerificationCheck {
  name: 'turn_completed' | 'final_answer_non_empty' | 'tool_evidence';
  passed: boolean;
  details: string;
}

export interface AgentTurnVerification {
  isVerified: boolean;
  finalAnswerIsNonEmpty: boolean;
  toolEvidenceSatisfied: boolean;
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
  const finalAnswerIsNonEmpty = turnCompleted && input.finalAnswer.trim().length > 0;
  const toolMessages = input.history.filter(isSuccessfulToolMessage);
  const toolMessagesCount = toolMessages.length;
  const toolEvidenceSatisfied = input.criteria.requiresToolEvidence ? toolMessagesCount > 0 : true;

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
    }
  ];

  return {
    isVerified: checks.every((check) => check.passed),
    finalAnswerIsNonEmpty,
    toolEvidenceSatisfied,
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

function isSuccessfulToolMessage(message: Message): message is ToolResultMessage {
  return message.role === 'tool' && 'isError' in message && message.isError === false;
}
