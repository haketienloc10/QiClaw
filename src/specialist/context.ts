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
  const normalizedGoal = normalizeSpecialistGoal(input.specialist, input.userInput);

  return {
    sessionId: input.sessionId,
    parentTaskId: input.parentTaskId,
    kind: input.specialist,
    goal: normalizedGoal,
    relevantContext: relevantParts.join('\n\n'),
    constraints: [
      'Use only the provided brief and evidence snippets.',
      'Do not assume access to the full main transcript.',
      input.specialist === 'review'
        ? 'If the request refers to the current patch, treat it as the current workspace diff unless a specific commit or diff is named.'
        : undefined,
      'Keep the artifact concise and structured.'
    ].filter((value): value is string => Boolean(value && value.length > 0)),
    evidenceSnippets
  };
}

function normalizeSpecialistGoal(specialist: SpecialistKind, userInput: string): string {
  const trimmedInput = userInput.trim();

  if (specialist !== 'review') {
    return trimmedInput;
  }

  if (/\bbản vá hiện tại\b/i.test(trimmedInput) || /\bcurrent patch\b/i.test(trimmedInput)) {
    return `${trimmedInput} Review the current workspace diff unless the brief names a specific commit or diff.`;
  }

  return trimmedInput;
}
