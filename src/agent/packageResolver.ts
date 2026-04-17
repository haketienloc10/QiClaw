import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';

import {
  getBuiltinAgentPackageDirectory,
  getProjectAgentPackageDirectory,
  getSharedAgentPromptFilePath,
  getUserAgentPackageDirectory
} from './packagePaths.js';
import { loadAgentPackageFromDirectory } from './packageLoader.js';
import {
  validateAgentPackageExtendsCycle,
  validateAgentPackageExtendsTarget,
  validateLoadedAgentPackage,
  validateResolvedAgentPackage
} from './packageValidator.js';
import type { AgentPackageSourceTier, AgentPromptFileName, LoadedAgentPackage, ResolvedAgentPackage } from './spec.js';

export async function resolveAgentPackage(
  preset: string,
  options: { cwd: string; homeDirectory?: string; builtinPackagesDirectory?: string }
): Promise<ResolvedAgentPackage> {
  const visited = new Set<string>();
  const stack: string[] = [];
  const packageChain = await loadResolvedChain(preset, options, visited, stack, preset);
  const sharedPromptFiles = await loadSharedPromptFiles();
  const effectivePolicy = mergePolicyChain(packageChain);
  const effectiveCompletion = mergeCompletionChain(packageChain);
  const effectiveDiagnostics = mergeDiagnosticsChain(packageChain);
  const effectivePromptFiles = {
    ...mergePromptFileChain(packageChain),
    ...sharedPromptFiles
  };
  const effectivePromptOrder = resolvePromptOrder(packageChain, effectivePromptFiles);
  const resolvedFiles = dedupeResolvedFiles([
    ...Object.values(sharedPromptFiles).map((promptFile) => promptFile.filePath),
    ...packageChain.flatMap((agentPackage) => [
      agentPackage.manifestPath,
      ...orderedPromptFileNames(agentPackage).flatMap((fileName) => {
        const promptFile = agentPackage.promptFiles[fileName];
        return promptFile ? [promptFile.filePath] : [];
      })
    ])
  ]);
  const resolvedPackage: ResolvedAgentPackage = {
    preset,
    sourceTier: packageChain[0].sourceTier,
    extendsChain: packageChain.map((agentPackage) => agentPackage.preset),
    packageChain,
    effectivePolicy,
    effectiveCompletion,
    effectiveDiagnostics,
    effectivePromptOrder,
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

function mergeCompletionChain(packageChain: LoadedAgentPackage[]) {
  return [...packageChain].reverse().reduce<ResolvedAgentPackage['effectiveCompletion']>((merged, agentPackage) => {
    return {
      ...merged,
      ...agentPackage.manifest?.completion
    };
  }, undefined);
}

function mergeDiagnosticsChain(packageChain: LoadedAgentPackage[]) {
  return [...packageChain].reverse().reduce<ResolvedAgentPackage['effectiveDiagnostics']>((merged, agentPackage) => {
    return {
      ...merged,
      ...agentPackage.manifest?.diagnostics
    };
  }, undefined);
}

function mergePromptFileChain(packageChain: LoadedAgentPackage[]): ResolvedAgentPackage['effectivePromptFiles'] {
  return [...packageChain].reverse().reduce<ResolvedAgentPackage['effectivePromptFiles']>((merged, agentPackage) => ({
    ...merged,
    ...agentPackage.promptFiles
  }), {});
}

function resolvePromptOrder(
  packageChain: LoadedAgentPackage[],
  effectivePromptFiles: ResolvedAgentPackage['effectivePromptFiles']
): AgentPromptFileName[] {
  const inheritedManifestOrder = [...packageChain]
    .reverse()
    .flatMap((agentPackage) => agentPackage.manifest?.promptFiles ?? []);

  return prioritizePromptFile(
    dedupePromptFileNames(inheritedManifestOrder as AgentPromptFileName[]).filter((fileName) => effectivePromptFiles[fileName]),
    effectivePromptFiles
  );
}

async function loadSharedPromptFiles(): Promise<Record<AgentPromptFileName, ResolvedAgentPackage['effectivePromptFiles'][AgentPromptFileName]>> {
  const filePath = getSharedAgentPromptFilePath('QICLAW.md');

  try {
    const content = await readFile(filePath, 'utf8');
    return {
      'QICLAW.md': {
        filePath,
        content: normalizeLineEndings(content)
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function orderedPromptFileNames(agentPackage: LoadedAgentPackage): AgentPromptFileName[] {
  const manifestOrder = agentPackage.manifest?.promptFiles ?? [];
  const fileNames = Object.keys(agentPackage.promptFiles) as AgentPromptFileName[];
  return dedupePromptFileNames([...manifestOrder, ...fileNames]);
}

function prioritizePromptFile(
  fileNames: AgentPromptFileName[],
  effectivePromptFiles: ResolvedAgentPackage['effectivePromptFiles']
): AgentPromptFileName[] {
  if (!effectivePromptFiles['QICLAW.md']) {
    return fileNames;
  }

  return dedupePromptFileNames(['QICLAW.md', ...fileNames]);
}

function dedupePromptFileNames(fileNames: AgentPromptFileName[]): AgentPromptFileName[] {
  const seen = new Set<AgentPromptFileName>();
  const result: AgentPromptFileName[] = [];

  for (const fileName of fileNames) {
    if (seen.has(fileName)) {
      continue;
    }

    seen.add(fileName);
    result.push(fileName);
  }

  return result;
}

function dedupeResolvedFiles(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const filePath of filePaths) {
    if (seen.has(filePath)) {
      continue;
    }

    seen.add(filePath);
    result.push(filePath);
  }

  return result;
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    await access(directoryPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
