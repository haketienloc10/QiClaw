import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getBuiltinAgentPackageDirectory } from './packagePaths.js';
import {
  validateAgentPackageExtendsCycle,
  validateLoadedAgentPackage,
  validateResolvedAgentPackage
} from './packageValidator.js';
import type { AgentPromptFileName, LoadedAgentPackage, ResolvedAgentPackage } from './spec.js';

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
  const effectivePromptFiles = {
    ...(parentPackage?.effectivePromptFiles ?? {}),
    ...loaded.promptFiles
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
    resolvedFiles: [
      loaded.manifestPath,
      ...orderedPromptFileNames(loaded).flatMap((fileName) => {
        const promptFile = loaded.promptFiles[fileName];
        return promptFile ? [promptFile.filePath] : [];
      }),
      ...(parentPackage?.resolvedFiles ?? [])
    ]
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

  return dedupePromptFileNames([...inheritedManifestOrder, ...manifestPromptOrder]).filter(
    (fileName) => effectivePromptFiles[fileName]
  );
}

function orderedPromptFileNames(agentPackage: LoadedAgentPackage): AgentPromptFileName[] {
  return dedupePromptFileNames([...(agentPackage.manifest?.promptFiles ?? []), ...Object.keys(agentPackage.promptFiles)]);
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

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}
