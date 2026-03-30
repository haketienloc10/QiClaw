export interface DoneCriteria {
  goal: string;
  checklist: string[];
  requiresNonEmptyFinalAnswer: true;
  requiresToolEvidence: boolean;
  toolEvidenceReason?: string;
}

const TOOL_EVIDENCE_REASON = 'Goal asks for workspace inspection via read/search/check/review actions.';
const CHECKLIST_SPLIT_PATTERN = /\b(?:and|then)\b|,/gi;
const TOOL_EVIDENCE_PATTERN = /\b(read|inspect|search|grep|scan the repo|scan the workspace|explore the repo|explore the workspace|check the repo|check the workspace|review the repo|review the codebase|examine the repo|examine the codebase|open (?:the )?(?:file|repo|repository|codebase|workspace))\b/i;

export function buildDoneCriteria(goal: string): DoneCriteria {
  const normalizedGoal = goal.trim();
  const checklist = splitGoalIntoChecklist(normalizedGoal);
  const requiresToolEvidence = TOOL_EVIDENCE_PATTERN.test(normalizedGoal);

  return {
    goal: normalizedGoal,
    checklist,
    requiresNonEmptyFinalAnswer: true,
    requiresToolEvidence,
    toolEvidenceReason: requiresToolEvidence ? TOOL_EVIDENCE_REASON : undefined
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
