import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import { getBuiltinAgentPackageDirectory, getProjectAgentPackageDirectory, getUserAgentPackageDirectory } from './packagePaths.js';
import { loadAgentPackageFromDirectory } from './packageLoader.js';
import {
  validateAgentPackageExtendsCycle,
  validateAgentPackageExtendsTarget,
  validateLoadedAgentPackage,
  validateResolvedAgentPackage
} from './packageValidator.js';
import type { AgentPackageSourceTier, AgentPromptSlotFileName, LoadedAgentPackage, ResolvedAgentPackage } from './spec.js';

const promptSlotFileNames: AgentPromptSlotFileName[] = ['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'CHECKLIST.md'];

export async function resolveAgentPackage(
  preset: string,
  options: { cwd: string; homeDirectory?: string; builtinPackagesDirectory?: string }
): Promise<ResolvedAgentPackage> {
  const visited = new Set<string>();
  const stack: string[] = [];
  const packageChain = await loadResolvedChain(preset, options, visited, stack, preset);
  const effectivePolicy = mergePolicyChain(packageChain);
  const effectivePromptFiles = mergePromptFileChain(packageChain);
  const resolvedFiles = packageChain.flatMap((agentPackage) => [
    agentPackage.manifestPath,
    ...promptSlotFileNames.flatMap((slotFileName) => {
      const promptFile = agentPackage.promptFiles[slotFileName];
      return promptFile ? [promptFile.filePath] : [];
    })
  ]);
  const resolvedPackage: ResolvedAgentPackage = {
    preset,
    sourceTier: packageChain[0].sourceTier,
    extendsChain: packageChain.map((agentPackage) => agentPackage.preset),
    packageChain,
    effectivePolicy,
    effectivePromptFiles,
    resolvedFiles
  };
  const errors = validateResolvedAgentPackage(resolvedPackage);

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return resolvedPackage;
}

async function loadResolvedChain(
  preset: string,
  options: { cwd: string; homeDirectory?: string; builtinPackagesDirectory?: string },
  visited: Set<string>,
  stack: string[],
  rootPreset: string
): Promise<LoadedAgentPackage[]> {
  if (stack.includes(preset)) {
    throw new Error(validateAgentPackageExtendsCycle(stack, preset).join('\n'));
  }

  if (visited.has(preset)) {
    return [];
  }

  stack.push(preset);
  const loaded = await loadFirstAvailablePackage(preset, options, rootPreset);
  const validationErrors = validateLoadedAgentPackage(loaded);

  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('\n'));
  }

  visited.add(preset);
  const parentChain = loaded.manifest?.extends
    ? await loadResolvedChain(loaded.manifest.extends, options, visited, stack, rootPreset)
    : [];

  stack.pop();

  return [loaded, ...parentChain];
}

async function loadFirstAvailablePackage(
  preset: string,
  options: { cwd: string; homeDirectory?: string; builtinPackagesDirectory?: string },
  rootPreset: string
): Promise<LoadedAgentPackage> {
  const candidates: Array<{ sourceTier: AgentPackageSourceTier; directoryPath: string }> = [
    {
      sourceTier: 'project',
      directoryPath: getProjectAgentPackageDirectory(options.cwd, preset)
    },
    {
      sourceTier: 'user',
      directoryPath: getUserAgentPackageDirectory(preset, options.homeDirectory)
    },
    {
      sourceTier: 'builtin',
      directoryPath: getBuiltinAgentPackageDirectory(preset, options.builtinPackagesDirectory)
    }
  ];

  for (const candidate of candidates) {
    if (await directoryExists(candidate.directoryPath)) {
      return loadAgentPackageFromDirectory(candidate.directoryPath, { preset, sourceTier: candidate.sourceTier });
    }
  }

  throw new Error(validateAgentPackageExtendsTarget(rootPreset, preset).join('\n'));
}

function mergePolicyChain(packageChain: LoadedAgentPackage[]) {
  return [...packageChain].reverse().reduce<ResolvedAgentPackage['effectivePolicy']>((merged, agentPackage) => {
    return {
      ...merged,
      ...agentPackage.manifest?.policy,
      allowedCapabilityClasses: agentPackage.manifest?.policy?.allowedCapabilityClasses ?? merged.allowedCapabilityClasses
    };
  }, {});
}

function mergePromptFileChain(packageChain: LoadedAgentPackage[]): Partial<Record<AgentPromptSlotFileName, LoadedAgentPackage['promptFiles'][AgentPromptSlotFileName]>> {
  return [...packageChain].reverse().reduce<Partial<Record<AgentPromptSlotFileName, LoadedAgentPackage['promptFiles'][AgentPromptSlotFileName]>>>(
    (merged, agentPackage) => ({
      ...merged,
      ...agentPackage.promptFiles
    }),
    {}
  );
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    await access(directoryPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

