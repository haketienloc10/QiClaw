import { filterToolsByPolicy } from '../agent/runtime.js';
import type { Message } from '../core/types.js';
import { createTelemetryEvent, createNoopObserver, type TelemetryObserver } from '../telemetry/observer.js';
import type { Tool } from '../tools/registry.js';

import { buildSpecialistBrief } from './context.js';
import { getSpecialistDefinition } from './registry.js';
import { routeSpecialist } from './router.js';
import type { SpecialistArtifact, SpecialistExecutionResult } from './types.js';

export interface RunSpecialistOrchestratorInput<TMainResult = unknown, TSpecialistResult extends SpecialistExecutionResult = SpecialistExecutionResult> {
  sessionId?: string;
  parentTaskId?: string;
  userInput: string;
  history: Message[];
  historySummary?: string;
  memoryText?: string;
  availableTools: Tool[];
  observer?: TelemetryObserver;
  executeMainTurn: () => Promise<TMainResult>;
  executeSpecialistTurn: (input: {
    brief: ReturnType<typeof buildSpecialistBrief>;
    availableTools: Tool[];
    observer: TelemetryObserver;
  }) => Promise<TSpecialistResult>;
}

export type SpecialistOrchestratorResult<TMainResult = unknown> =
  | TMainResult
  | {
      mode: 'specialist';
      artifact: SpecialistArtifact;
      finalAnswer: string;
      parsed: boolean;
      rawOutput: string;
    };

export async function runSpecialistOrchestrator<TMainResult = unknown>(
  input: RunSpecialistOrchestratorInput<TMainResult>
): Promise<SpecialistOrchestratorResult<TMainResult>> {
  const routeDecision = routeSpecialist(input.userInput);
  if (routeDecision.kind === 'main') {
    return input.executeMainTurn();
  }

  const observer = input.observer ?? createNoopObserver();
  const definition = getSpecialistDefinition(routeDecision.specialist);
  const brief = buildSpecialistBrief({
    sessionId: input.sessionId,
    parentTaskId: input.parentTaskId,
    specialist: routeDecision.specialist,
    userInput: routeDecision.normalizedInput,
    history: input.history,
    historySummary: input.historySummary,
    memoryText: input.memoryText
  });
  const specialistTools = filterToolsByPolicy(input.availableTools, definition.toolPolicy);
  const contextChars = [brief.goal, brief.relevantContext, ...(brief.evidenceSnippets ?? [])].join('\n').length;

  observer.record(
    createTelemetryEvent('specialist_selected', 'input_received', {
      turnId: input.parentTaskId ?? 'specialist',
      providerRound: 0,
      toolRound: 0,
      sessionId: input.sessionId,
      parentTaskId: input.parentTaskId,
      kind: routeDecision.specialist,
      routeReason: routeDecision.reason,
      matchedRule: routeDecision.matchedRule,
      contextChars,
      historyMessageCount: input.history.length
    })
  );

  observer.record(
    createTelemetryEvent('specialist_started', 'provider_decision', {
      turnId: input.parentTaskId ?? 'specialist',
      providerRound: 0,
      toolRound: 0,
      sessionId: input.sessionId,
      parentTaskId: input.parentTaskId,
      kind: routeDecision.specialist,
      routeReason: routeDecision.reason,
      matchedRule: routeDecision.matchedRule,
      contextChars,
      historyMessageCount: input.history.length
    })
  );

  const startedAt = Date.now();
  const result = await input.executeSpecialistTurn({
    brief,
    availableTools: specialistTools,
    observer
  });

  if (!result.parsed) {
    observer.record(
      createTelemetryEvent('specialist_parse_failed', 'response_composition', {
        turnId: input.parentTaskId ?? 'specialist',
        providerRound: 0,
        toolRound: 0,
        sessionId: input.sessionId,
        parentTaskId: input.parentTaskId,
        kind: routeDecision.specialist,
        routeReason: routeDecision.reason,
        matchedRule: routeDecision.matchedRule,
        contextChars,
        historyMessageCount: input.history.length,
        fallbackReason: 'unstructured_output'
      })
    );
  }

  observer.record(
    createTelemetryEvent('specialist_completed', 'completion_check', {
      turnId: input.parentTaskId ?? 'specialist',
      providerRound: 0,
      toolRound: 0,
      sessionId: input.sessionId,
      parentTaskId: input.parentTaskId,
      kind: routeDecision.specialist,
      routeReason: routeDecision.reason,
      matchedRule: routeDecision.matchedRule,
      contextChars,
      historyMessageCount: input.history.length,
      structuredArtifactParsed: result.parsed,
      durationMs: Date.now() - startedAt
    })
  );

  return {
    mode: 'specialist',
    artifact: result.artifact,
    finalAnswer: result.finalAnswer,
    parsed: result.parsed,
    rawOutput: result.rawOutput
  };
}
