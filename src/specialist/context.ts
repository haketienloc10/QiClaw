import type { Message } from '../core/types.js';

import type { SpecialistBrief, SpecialistKind } from './types.js';

export interface BuildSpecialistBriefInput {
  sessionId?: string;
  parentTaskId?: string;
  specialist: SpecialistKind;
  userInput: string;
  history: Message[];
  historySummary?: string;
  memoryText?: string;
}

const MAX_EVIDENCE_SNIPPETS = 4;

export function buildSpecialistBrief(input: BuildSpecialistBriefInput): SpecialistBrief {
  const evidenceSnippets = input.history
    .slice(-MAX_EVIDENCE_SNIPPETS)
    .map((message) => `${message.role}: ${message.content}`);
  const relevantParts = [
    input.historySummary?.trim() ? `History summary:\n${input.historySummary.trim()}` : undefined,
    evidenceSnippets.length > 0 ? `Recent messages:\n${evidenceSnippets.join('\n')}` : undefined
  ].filter((value): value is string => Boolean(value && value.length > 0));

  return {
    sessionId: input.sessionId,
    parentTaskId: input.parentTaskId,
    kind: input.specialist,
    goal: input.userInput.trim(),
    relevantContext: relevantParts.join('\n\n'),
    constraints: [
      'Use only the provided brief and evidence snippets.',
      'Do not assume access to the full main transcript.',
      'Keep the artifact concise and structured.'
    ],
    evidenceSnippets
  };
}
