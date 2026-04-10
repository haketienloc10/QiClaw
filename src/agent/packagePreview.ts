import type { AgentPackagePreview, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

export function createAgentPackagePreview(agentPackage: ResolvedAgentPackage): AgentPackagePreview {
  return {
    preset: agentPackage.preset,
    sourceTier: agentPackage.sourceTier,
    extendsChain: agentPackage.extendsChain,
    promptFiles: agentPackage.effectivePromptOrder.flatMap((fileName) => {
      const promptFile = agentPackage.effectivePromptFiles[fileName];
      return promptFile ? [{ fileName, filePath: promptFile.filePath }] : [];
    }),
    resolvedFiles: agentPackage.resolvedFiles,
    effectiveRuntimePolicy: agentPackage.effectivePolicy,
    renderedPromptText: renderAgentSystemPrompt(agentPackage)
  };
}
