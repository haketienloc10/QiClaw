import type { DoneCriteria } from './doneCriteria.js';
import type { AgentTurnStopReason } from './loop.js';
import type { AgentTurnVerification } from './verifier.js';
import { createTaskContract, type TaskContract } from './taskContract.js';
import { createTaskVerdict, type TaskVerdict } from './taskVerdict.js';
import { appendTaskLedgerRecord } from '../session/taskLedger.js';

export interface WitnessEvaluation {
  contract: TaskContract;
  verdict: TaskVerdict;
}

export interface CreateWitnessContractInput {
  taskId: string;
  userInput: string;
  criteria: DoneCriteria;
  createdAt?: string;
}

export interface FinalizeWitnessTurnInput {
  contract: TaskContract;
  verification: AgentTurnVerification;
  finalAnswer: string;
  stopReason: AgentTurnStopReason;
  turnCompleted: boolean;
  ledgerPath?: string;
  sessionId?: string;
  userInput: string;
  toolRoundsUsed: number;
  createdAt?: string;
}

export function createWitnessContract(input: CreateWitnessContractInput): TaskContract {
  return createTaskContract(input);
}

export function finalizeWitnessTurn(input: FinalizeWitnessTurnInput): WitnessEvaluation {
  const verdict = createTaskVerdict({
    contract: input.contract,
    verification: input.verification,
    finalAnswer: input.finalAnswer,
    stopReason: input.stopReason,
    turnCompleted: input.turnCompleted,
    createdAt: input.createdAt
  });

  if (input.ledgerPath) {
    try {
      appendTaskLedgerRecord(input.ledgerPath, {
        taskId: input.contract.taskId,
        sessionId: input.sessionId,
        userInput: input.userInput,
        contract: input.contract,
        verdict,
        toolRoundsUsed: input.toolRoundsUsed,
        finalAnswer: input.finalAnswer,
        timestamp: input.createdAt ?? new Date().toISOString()
      });
    } catch {
      // Best-effort persistence: witness metadata must not break the completed turn result.
    }
  }

  return {
    contract: input.contract,
    verdict
  };
}
