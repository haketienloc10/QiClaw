import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getBuiltinAgentPackageDirectory, getSharedAgentPromptFilePath } from './packagePaths.js';
import {
  validateAgentPackageExtendsCycle,
  validateLoadedAgentPackage,
  validateResolvedAgentPackage
} from './packageValidator.js';
import type { AgentPromptFileName, LoadedAgentPackage, ResolvedAgentPackage } from './spec.js';

const priorityPromptFileName: AgentPromptFileName = 'QICLAW.md';
const builtinPackagesDirectory = dirname(getBuiltinAgentPackageDirectory('default'));
const builtinAgentPackageNames = readdirSync(builtinPackagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort() as BuiltinAgentPackageName[];
const defaultPromptOrder: AgentPromptFileName[] = ['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'USER.md'];

export type BuiltinAgentPackageName = 'default' | 'readonly';

export function resolveBuiltinAgentPackage(name: string): ResolvedAgentPackage {
  return resolveBuiltinAgentPackageWithStack(name, []);
}

export function getDefaultAgentSpecName(): BuiltinAgentPackageName {
  return 'default';
}

export function listBuiltinAgentSpecNames(): BuiltinAgentPackageName[] {
  return [...builtinAgentPackageNames];
}

function assertBuiltinAgentPackageName(name: string): asserts name is BuiltinAgentPackageName {
  if (!builtinAgentPackageNames.includes(name as BuiltinAgentPackageName)) {
    throw new Error(`Unknown agent spec: ${name}`);
  }
}

function resolveBuiltinAgentPackageWithStack(name: string, stack: string[]): ResolvedAgentPackage {
  assertBuiltinAgentPackageName(name);

  if (stack.includes(name)) {
    throw new Error(validateAgentPackageExtendsCycle(stack, name).join('\n'));
  }

  const loaded = loadBuiltinPackage(name);
  const validationErrors = validateLoadedAgentPackage(loaded);

  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('\n'));
  }

  const parentPackage = loaded.manifest?.extends
    ? resolveBuiltinAgentPackageWithStack(loaded.manifest.extends, [...stack, name])
    : undefined;
  const sharedPromptFiles = loadSharedPromptFile(loaded.directoryPath);
  const effectivePromptFiles = {
    ...(parentPackage?.effectivePromptFiles ?? {}),
    ...loaded.promptFiles,
    ...sharedPromptFiles
  };
  const effectivePromptOrder = resolvePromptOrder(loaded, parentPackage, effectivePromptFiles);
  const packageChain = [loaded, ...(parentPackage?.packageChain ?? [])];
  const resolvedPackage: ResolvedAgentPackage = {
    preset: name,
    sourceTier: 'builtin',
    extendsChain: [name, ...(parentPackage?.extendsChain ?? [])],
    packageChain,
    effectivePolicy: {
      ...(parentPackage?.effectivePolicy ?? {}),
      ...(loaded.manifest?.policy ?? {}),
      allowedCapabilityClasses:
        loaded.manifest?.policy?.allowedCapabilityClasses ?? parentPackage?.effectivePolicy.allowedCapabilityClasses
    },
    effectiveCompletion: {
      ...(parentPackage?.effectiveCompletion ?? {}),
      ...(loaded.manifest?.completion ?? {})
    },
    effectiveDiagnostics: {
      ...(parentPackage?.effectiveDiagnostics ?? {}),
      ...(loaded.manifest?.diagnostics ?? {})
    },
    effectivePromptOrder,
    effectivePromptFiles,
    resolvedFiles: dedupeResolvedFiles([
      loaded.manifestPath,
      ...orderedPromptFileNames(loaded).flatMap((fileName) => {
        const promptFile = loaded.promptFiles[fileName];
        return promptFile ? [promptFile.filePath] : [];
      }),
      ...('QICLAW.md' in sharedPromptFiles ? [sharedPromptFiles['QICLAW.md'].filePath] : []),
      ...(parentPackage?.resolvedFiles ?? [])
    ])
  };
  const resolvedValidationErrors = validateResolvedAgentPackage(resolvedPackage);

  if (resolvedValidationErrors.length > 0) {
    throw new Error(resolvedValidationErrors.join('\n'));
  }

  return resolvedPackage;
}

function loadBuiltinPackage(name: BuiltinAgentPackageName): LoadedAgentPackage {
  const directoryPath = getBuiltinAgentPackageDirectory(name);
  const manifestPath = join(directoryPath, 'agent.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LoadedAgentPackage['manifest'];
  const promptFiles = Object.fromEntries(
    readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const filePath = join(directoryPath, entry.name);
        return [entry.name, { filePath, content: normalizeLineEndings(readFileSync(filePath, 'utf8')) }];
      })
  ) as LoadedAgentPackage['promptFiles'];

  return {
    preset: name,
    sourceTier: 'builtin',
    directoryPath,
    manifestPath,
    manifest,
    promptFiles
  };
}

function loadSharedPromptFile(
  builtinPackageDirectory: string
): Record<AgentPromptFileName, ResolvedAgentPackage['effectivePromptFiles'][AgentPromptFileName]> {
  const filePath = getSharedAgentPromptFilePath(priorityPromptFileName, dirname(dirname(builtinPackageDirectory)));

  if (!existsSync(filePath)) {
    return {};
  }

  return {
    [priorityPromptFileName]: {
      filePath,
      content: normalizeLineEndings(readFileSync(filePath, 'utf8'))
    }
  };
}

function resolvePromptOrder(
  loaded: LoadedAgentPackage,
  parentPackage: ResolvedAgentPackage | undefined,
  effectivePromptFiles: ResolvedAgentPackage['effectivePromptFiles']
): AgentPromptFileName[] {
  const inheritedManifestOrder = parentPackage?.effectivePromptOrder ?? [];
  const manifestPromptOrder = loaded.manifest?.promptFiles?.length
    ? loaded.manifest.promptFiles
    : inheritedManifestOrder.length > 0
      ? []
      : defaultPromptOrder;

  return prioritizePromptFile(
    dedupePromptFileNames([...inheritedManifestOrder, ...manifestPromptOrder]).filter((fileName) => effectivePromptFiles[fileName]),
    effectivePromptFiles
  );
}

function orderedPromptFileNames(agentPackage: LoadedAgentPackage): AgentPromptFileName[] {
  return dedupePromptFileNames([...(agentPackage.manifest?.promptFiles ?? []), ...Object.keys(agentPackage.promptFiles)]);
}

function prioritizePromptFile(
  fileNames: AgentPromptFileName[],
  effectivePromptFiles: ResolvedAgentPackage['effectivePromptFiles']
): AgentPromptFileName[] {
  if (!effectivePromptFiles[priorityPromptFileName]) {
    return fileNames;
  }

  return dedupePromptFileNames([priorityPromptFileName, ...fileNames]);
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
