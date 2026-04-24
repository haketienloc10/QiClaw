import { runAgentTurn } from '../agent/loop.js';
import type { ModelProvider } from '../provider/model.js';
import type { TelemetryObserver } from '../telemetry/observer.js';
import type { Tool } from '../tools/registry.js';

import { parseSpecialistArtifact } from './parser.js';
import { getSpecialistDefinition } from './registry.js';
import type { SpecialistArtifact, SpecialistBrief, SpecialistExecutionResult } from './types.js';

export interface ExecuteSpecialistTurnInput {
  provider: ModelProvider;
  cwd: string;
  brief: SpecialistBrief;
  availableTools: Tool[];
  observer: TelemetryObserver;
}

export async function executeSpecialistTurn(input: ExecuteSpecialistTurnInput): Promise<SpecialistExecutionResult> {
  const definition = getSpecialistDefinition(input.brief.kind);
  const turnResult = await runAgentTurn({
    provider: input.provider,
    availableTools: input.availableTools,
    baseSystemPrompt: definition.systemPrompt,
    userInput: renderSpecialistBrief(input.brief),
    cwd: input.cwd,
    maxToolRounds: 2,
    observer: input.observer,
    history: []
  });
  const artifact = parseSpecialistArtifact(input.brief.kind, turnResult.finalAnswer);

  return {
    artifact,
    rawOutput: turnResult.finalAnswer,
    parsed: artifact.summary !== 'Could not parse specialist output into a structured artifact.',
    finalAnswer: formatArtifactForUser(artifact),
    toolNames: input.availableTools.map((tool) => tool.name)
  };
}

function renderSpecialistBrief(brief: SpecialistBrief): string {
  return [
    `Goal: ${brief.goal}`,
    brief.relevantContext ? `Relevant context:\n${brief.relevantContext}` : undefined,
    brief.constraints && brief.constraints.length > 0 ? `Constraints:\n- ${brief.constraints.join('\n- ')}` : undefined,
    brief.evidenceSnippets && brief.evidenceSnippets.length > 0 ? `Evidence snippets:\n- ${brief.evidenceSnippets.join('\n- ')}` : undefined
  ].filter((value): value is string => Boolean(value && value.length > 0)).join('\n\n');
}

function formatArtifactForUser(artifact: SpecialistArtifact): string {
  switch (artifact.kind) {
    case 'research':
      return [
        artifact.summary,
        ...artifact.findings.slice(0, 3).map((finding) => `- ${finding}`),
        ...artifact.openQuestions.slice(0, 2).map((question) => `Open question: ${question}`)
      ].join('\n');
    case 'debug':
      return [
        artifact.summary,
        ...artifact.likelyCauses.slice(0, 3).map((cause) => `- ${cause.title}`),
        ...artifact.proposedFixes.slice(0, 2).map((fix) => `Suggested fix: ${fix}`)
      ].join('\n');
    case 'review':
      return [
        artifact.summary,
        ...artifact.blockingIssues.slice(0, 3).map((issue) => `Blocking: ${issue}`),
        ...artifact.nonBlockingIssues.slice(0, 2).map((issue) => `Non-blocking: ${issue}`),
        `Verdict: ${artifact.verdict}`
      ].join('\n');
  }
}
