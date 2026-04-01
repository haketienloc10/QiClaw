import type { AgentCompletionSpec } from './spec.js';

export interface DoneCriteria {
  goal: string;
  checklist: string[];
  requiresNonEmptyFinalAnswer: true;
  requiresToolEvidence: boolean;
  requiresSubstantiveFinalAnswer: boolean;
  forbidSuccessAfterToolErrors: boolean;
  toolEvidenceReason?: string;
  completionMode?: string;
  doneCriteriaShape?: string;
  evidenceRequirement?: string;
  stopVsDoneDistinction?: string;
}

const TOOL_EVIDENCE_REASON = 'Goal asks for project inspection via read/search/check/review actions.';
const CHECKLIST_SPLIT_PATTERN = /\b(?:and|then)\b|,/gi;
const TOOL_EVIDENCE_PATTERN = /\b(read|inspect|search|grep|scan the repo|scan the workspace|explore the repo|explore the workspace|check the repo|check the workspace|review the repo|review the codebase|examine the repo|examine the codebase|open (?:the )?(?:file|repo|repository|codebase|workspace))\b/i;

export function buildDoneCriteria(goal: string, completion?: AgentCompletionSpec): DoneCriteria {
  const normalizedGoal = goal.trim();
  const checklist = splitGoalIntoChecklist(normalizedGoal);
  const requiresToolEvidence = completion?.requiresToolEvidence ?? TOOL_EVIDENCE_PATTERN.test(normalizedGoal);

  return {
    goal: normalizedGoal,
    checklist,
    requiresNonEmptyFinalAnswer: true,
    requiresToolEvidence,
    requiresSubstantiveFinalAnswer: completion?.requiresSubstantiveFinalAnswer ?? false,
    forbidSuccessAfterToolErrors: completion?.forbidSuccessAfterToolErrors ?? false,
    toolEvidenceReason: requiresToolEvidence ? TOOL_EVIDENCE_REASON : undefined,
    completionMode: completion?.completionMode,
    doneCriteriaShape: completion?.doneCriteriaShape,
    evidenceRequirement: completion?.evidenceRequirement,
    stopVsDoneDistinction: completion?.stopVsDoneDistinction
  };
}

function splitGoalIntoChecklist(goal: string): string[] {
  const parts = goal
    .split(CHECKLIST_SPLIT_PATTERN)
    .map((part) => normalizeChecklistItem(part))
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : [goal];
}

function normalizeChecklistItem(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
