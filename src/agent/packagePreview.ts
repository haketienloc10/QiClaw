import type { AgentPackagePreview, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

export function createAgentPackagePreview(agentPackage: ResolvedAgentPackage): AgentPackagePreview {
  return {
    preset: agentPackage.preset,
    sourceTier: agentPackage.sourceTier,
    extendsChain: agentPackage.extendsChain,
    promptFiles: Object.entries(agentPackage.effectivePromptFiles)
      .map(([fileName, promptFile]) => ({
        fileName,
        filePath: promptFile?.filePath
      }))
      .sort((left, right) => agentPackage.resolvedFiles.indexOf(left.filePath ?? '') - agentPackage.resolvedFiles.indexOf(right.filePath ?? '')),
    resolvedFiles: agentPackage.resolvedFiles,
    effectiveRuntimePolicy: agentPackage.effectivePolicy,
    renderedPromptText: renderAgentSystemPrompt(agentPackage)
  };
}
