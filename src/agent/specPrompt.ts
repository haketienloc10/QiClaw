import { agentPromptSlotFileNames } from './spec.js';
import type { AgentPromptSlotFileName, ResolvedAgentPackage } from './spec.js';

const promptSlotFileNames: AgentPromptSlotFileName[] = [...agentPromptSlotFileNames];

export function renderAgentSystemPrompt(resolvedPackage: ResolvedAgentPackage): string {
  const sections = promptSlotFileNames
    .flatMap((slotFileName) => {
      const promptFile = resolvedPackage.effectivePromptFiles[slotFileName];
      return promptFile ? [[slotFileName, promptFile.content].join('\n')] : [];
    })
    .concat(renderRuntimeConstraintsSummary(resolvedPackage));

  return sections.join('\n\n');
}

function renderRuntimeConstraintsSummary(resolvedPackage: ResolvedAgentPackage): string {
  const policy = resolvedPackage.effectivePolicy;

  return [
    'Runtime constraints summary',
    `- Allowed capability classes: ${(policy.allowedCapabilityClasses ?? []).join(', ')}`,
    `- Max tool rounds: ${policy.maxToolRounds ?? 0}`,
    `- Mutation mode: ${policy.mutationMode ?? 'none'}`,
    `- Requires tool evidence: ${policy.requiresToolEvidence === true ? 'yes' : 'no'}`,
    `- Requires substantive final answer: ${policy.requiresSubstantiveFinalAnswer === true ? 'yes' : 'no'}`,
    `- Forbid success after tool errors: ${policy.forbidSuccessAfterToolErrors === true ? 'yes' : 'no'}`,
    `- Include memory: ${policy.includeMemory === true ? 'yes' : 'no'}`,
    `- Include skills: ${policy.includeSkills === true ? 'yes' : 'no'}`,
    `- Include history summary: ${policy.includeHistorySummary === true ? 'yes' : 'no'}`,
    policy.diagnosticsParticipationLevel ? `- Diagnostics participation: ${policy.diagnosticsParticipationLevel}` : '',
    policy.redactionSensitivity ? `- Redaction sensitivity: ${policy.redactionSensitivity}` : ''
  ].filter((line) => line.length > 0).join('\n');
}
