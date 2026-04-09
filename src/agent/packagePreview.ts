import type { AgentPackagePreview, AgentPromptSlotFileName, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

const promptSlotOrder: AgentPromptSlotFileName[] = ['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md'];

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
