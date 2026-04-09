import { agentPromptSlotFileNames } from './spec.js';
import type { AgentPackagePreview, AgentPromptSlotFileName, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

const promptSlotOrder: AgentPromptSlotFileName[] = [...agentPromptSlotFileNames];

export function createAgentPackagePreview(agentPackage: ResolvedAgentPackage): AgentPackagePreview {
  return {
    preset: agentPackage.preset,
    sourceTier: agentPackage.sourceTier,
    extendsChain: agentPackage.extendsChain,
    sectionFiles: Object.fromEntries(
      promptSlotOrder.map((slot) => [slot, agentPackage.effectivePromptFiles[slot]?.filePath])
    ) as AgentPackagePreview['sectionFiles'],
    resolvedFiles: agentPackage.resolvedFiles,
    effectiveRuntimePolicy: agentPackage.effectivePolicy,
    renderedPromptText: renderAgentSystemPrompt(agentPackage)
  };
}
