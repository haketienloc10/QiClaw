import type { RunAgentTurnInput, RunAgentTurnResult, TurnEvent } from '../agent/loop.js';
import type { TelemetryObserver } from '../telemetry/observer.js';

import {
  runSpecialistOrchestrator,
  type SpecialistOrchestratorResult
} from './orchestrator.js';
import { executeSpecialistTurn } from './runtime.js';
import type { SpecialistArtifact } from './types.js';

export type SpecialistAwareTurnResult = RunAgentTurnResult & {
  historySummary?: string;
  turnStream?: AsyncIterable<TurnEvent>;
  finalResult?: Promise<RunAgentTurnResult & { historySummary?: string }>;
};

export interface RunSpecialistAwareTurnInput extends RunAgentTurnInput {
  sessionId?: string;
  observer?: TelemetryObserver;
}

function isSpecialistResult(
  result: SpecialistOrchestratorResult<SpecialistAwareTurnResult>
): result is Extract<SpecialistOrchestratorResult<SpecialistAwareTurnResult>, { mode: 'specialist' }> {
  return typeof result === 'object' && result !== null && 'mode' in result && result.mode === 'specialist';
}

function renderSpecialistArtifactSection(artifact: SpecialistArtifact): string {
  switch (artifact.kind) {
    case 'research':
      return JSON.stringify({
        kind: artifact.kind,
        summary: artifact.summary,
        confidence: artifact.confidence,
        findings: artifact.findings,
        openQuestions: artifact.openQuestions,
        evidence: artifact.evidence,
        suggestedNextSteps: artifact.suggestedNextSteps
      }, null, 2);
    case 'debug':
      return JSON.stringify({
        kind: artifact.kind,
        summary: artifact.summary,
        confidence: artifact.confidence,
        likelyCauses: artifact.likelyCauses,
        evidence: artifact.evidence,
        proposedFixes: artifact.proposedFixes,
        unresolvedRisks: artifact.unresolvedRisks,
        suggestedNextSteps: artifact.suggestedNextSteps
      }, null, 2);
    case 'review':
      return JSON.stringify({
        kind: artifact.kind,
        summary: artifact.summary,
        confidence: artifact.confidence,
        verdict: artifact.verdict,
        findings: artifact.findings,
        blockingIssues: artifact.blockingIssues,
        nonBlockingIssues: artifact.nonBlockingIssues,
        suggestedNextSteps: artifact.suggestedNextSteps
      }, null, 2);
  }
}

function buildSpecialistHandoffInput(result: Extract<SpecialistOrchestratorResult<SpecialistAwareTurnResult>, { mode: 'specialist' }>): string {
  return [
    'Structured specialist artifact available. Synthesize the final user-facing answer from this artifact instead of returning the raw specialist output.',
    'Treat the artifact as evidence gathered by a restricted specialist subexecution. Do not claim anything beyond the artifact evidence.',
    '',
    'Raw specialist output:',
    result.rawOutput,
    '',
    'Formatted specialist summary:',
    result.finalAnswer,
    '',
    'Structured specialist artifact:',
    renderSpecialistArtifactSection(result.artifact)
  ].join('\n');
}

export async function runSpecialistAwareTurn(
  input: RunSpecialistAwareTurnInput,
  executeMainTurn: (input: RunSpecialistAwareTurnInput) => Promise<SpecialistAwareTurnResult>
): Promise<SpecialistAwareTurnResult> {
  const result = await runSpecialistOrchestrator<SpecialistAwareTurnResult>({
    sessionId: input.sessionId,
    parentTaskId: undefined,
    userInput: input.userInput,
    history: input.history ?? [],
    historySummary: input.historySummary,
    memoryText: input.memoryText,
    availableTools: input.availableTools,
    observer: input.observer,
    executeMainTurn: () => executeMainTurn(input),
    executeSpecialistTurn: ({ brief, availableTools, observer }) => executeSpecialistTurn({
      provider: input.provider,
      cwd: input.cwd,
      brief,
      availableTools,
      observer
    })
  });

  if (!isSpecialistResult(result)) {
    return result;
  }

  if (!result.parsed) {
    throw new Error('Specialist did not produce a structured artifact.');
  }

  return executeMainTurn({
    ...input,
    userInput: buildSpecialistHandoffInput(result)
  });
}
