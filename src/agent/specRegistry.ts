import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getBuiltinAgentPackageDirectory } from './packagePaths.js';
import {
  validateAgentPackageExtendsCycle,
  validateLoadedAgentPackage,
  validateResolvedAgentPackage
} from './packageValidator.js';
import { agentPromptSlotFileNames } from './spec.js';
import type { AgentPromptSlotFileName, AgentSpec, LoadedAgentPackage, ResolvedAgentPackage } from './spec.js';
const builtinPackagesDirectory = dirname(getBuiltinAgentPackageDirectory('default'));
const builtinAgentSpecNames = readdirSync(builtinPackagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort() as BuiltinAgentSpecName[];

export type BuiltinAgentSpecName = 'default' | 'readonly';

export function getBuiltinAgentSpec(name: string): AgentSpec {
  return deriveAgentSpecFromResolvedPackage(resolveBuiltinAgentPackage(name));
}

export function resolveBuiltinAgentPackage(name: string): ResolvedAgentPackage {
  return resolveBuiltinAgentPackageWithStack(name, []);
}

export function resolveAgentPackage(options?: { agentSpec?: AgentSpec; agentSpecName?: string }): ResolvedAgentPackage {
  if (options?.agentSpec) {
    return compileResolvedAgentPackage(options.agentSpecName ?? 'inline', options.agentSpec);
  }

  return resolveBuiltinAgentPackage(options?.agentSpecName ?? getDefaultAgentSpecName());
}

export function getDefaultAgentSpecName(): BuiltinAgentSpecName {
  return 'default';
}

export function listBuiltinAgentSpecNames(): BuiltinAgentSpecName[] {
  return [...builtinAgentSpecNames];
}

function assertBuiltinAgentSpecName(name: string): asserts name is BuiltinAgentSpecName {
  if (!builtinAgentSpecNames.includes(name as BuiltinAgentSpecName)) {
    throw new Error(`Unknown agent spec: ${name}`);
  }
}

function resolveBuiltinAgentPackageWithStack(name: string, stack: string[]): ResolvedAgentPackage {
  assertBuiltinAgentSpecName(name);

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
    effectivePromptFiles: {
      ...(parentPackage?.effectivePromptFiles ?? {}),
      ...loaded.promptFiles
    },
    resolvedFiles: [
      loaded.manifestPath,
      ...agentPromptSlotFileNames.flatMap((slotFileName) => {
        const promptFile = loaded.promptFiles[slotFileName];
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

function loadBuiltinPackage(name: BuiltinAgentSpecName): LoadedAgentPackage {
  const directoryPath = getBuiltinAgentPackageDirectory(name);
  const manifestPath = join(directoryPath, 'agent.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LoadedAgentPackage['manifest'];
  const promptFiles = Object.fromEntries(
    agentPromptSlotFileNames.flatMap((slotFileName) => {
      const filePath = join(directoryPath, slotFileName);

      try {
        return [[slotFileName, { filePath, content: normalizeLineEndings(readFileSync(filePath, 'utf8')) }]];
      } catch (error) {
        if (isMissingFileError(error)) {
          return [];
        }

        throw error;
      }
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

function deriveAgentSpecFromResolvedPackage(resolvedPackage: ResolvedAgentPackage): AgentSpec {
  const agentPrompt = requirePromptFileContent(resolvedPackage, 'AGENT.md').split('\n');
  const soulPromptContent = requirePromptFileContent(resolvedPackage, 'SOUL.md');
  const soulPrompt = soulPromptContent.split('\n');
  const stylePrompt = requirePromptFileContent(resolvedPackage, 'STYLE.md').split('\n');
  const toolsPrompt = requirePromptFileContent(resolvedPackage, 'TOOLS.md').split('\n');
  const mutationMode = resolvedPackage.effectivePolicy.mutationMode;

  return {
    identity: {
      purpose: readLineValue(agentPrompt, 'Purpose: '),
      behavioralFraming: readOptionalLineValue(soulPrompt, 'Behavioral framing: ') ?? soulPromptContent.trim().split('\n')[0] ?? '',
      scopeBoundary: readLineValue(agentPrompt, 'Scope boundary: ')
    },
    capabilities: {
      allowedCapabilityClasses: [...(resolvedPackage.effectivePolicy.allowedCapabilityClasses ?? [])],
      operatingSurface: readLineValue(stylePrompt, 'Operating surface: '),
      capabilityExclusions: readOptionalLineValue(toolsPrompt, 'Capability exclusions: ')?.split('; ') ?? []
    },
    policies: {
      safetyStance: readLineValue(soulPrompt, 'Safety stance: '),
      toolUsePolicy: readLineValue(toolsPrompt, 'Tool-use policy: '),
      escalationPolicy: readLineValue(soulPrompt, 'Escalation policy: '),
      mutationPolicy:
        mutationMode === 'none'
          ? 'Do not mutate the project surface.'
          : 'Mutate the project surface only when the task requires it and keep changes tightly scoped.'
    },
    completion: {
      completionMode: resolvedPackage.effectiveCompletion?.completionMode ?? '',
      doneCriteriaShape: resolvedPackage.effectiveCompletion?.doneCriteriaShape ?? '',
      evidenceRequirement: resolvedPackage.effectiveCompletion?.evidenceRequirement ?? '',
      stopVsDoneDistinction: resolvedPackage.effectiveCompletion?.stopVsDoneDistinction ?? '',
      maxToolRounds: resolvedPackage.effectivePolicy.maxToolRounds ?? 1,
      requiresToolEvidence: resolvedPackage.effectivePolicy.requiresToolEvidence,
      requiresSubstantiveFinalAnswer: resolvedPackage.effectivePolicy.requiresSubstantiveFinalAnswer,
      forbidSuccessAfterToolErrors: resolvedPackage.effectivePolicy.forbidSuccessAfterToolErrors
    },
    contextProfile: {
      includeMemory: resolvedPackage.effectivePolicy.includeMemory,
      includeSkills: resolvedPackage.effectivePolicy.includeSkills,
      includeHistorySummary: resolvedPackage.effectivePolicy.includeHistorySummary,
      priorityHints: readOptionalLineValue(stylePrompt, 'Priority hints: ')?.split('; ')
    },
    diagnosticsProfile: resolvedPackage.effectivePolicy.diagnosticsParticipationLevel
      ? {
          diagnosticsParticipationLevel: resolvedPackage.effectivePolicy.diagnosticsParticipationLevel,
          traceabilityExpectation: resolvedPackage.effectiveDiagnostics?.traceabilityExpectation,
          redactionSensitivity: resolvedPackage.effectivePolicy.redactionSensitivity
        }
      : undefined
  };
}

function requirePromptFileContent(resolvedPackage: ResolvedAgentPackage, slotFileName: AgentPromptSlotFileName): string {
  const promptFile = resolvedPackage.effectivePromptFiles[slotFileName];

  if (!promptFile) {
    throw new Error(`Builtin agent package "${resolvedPackage.preset}" is missing ${slotFileName}.`);
  }

  return promptFile.content;
}

function readLineValue(lines: string[], prefix: string): string {
  const value = readOptionalLineValue(lines, prefix);

  if (value === undefined) {
    throw new Error(`Missing prompt line with prefix: ${prefix}`);
  }

  return value;
}

function readOptionalLineValue(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function compileResolvedAgentPackage(name: string, spec: AgentSpec): ResolvedAgentPackage {
  return {
    preset: name,
    sourceTier: 'builtin',
    extendsChain: [name],
    packageChain: [],
    effectivePolicy: {
      allowedCapabilityClasses: spec.capabilities.allowedCapabilityClasses,
      maxToolRounds: spec.completion.maxToolRounds,
      requiresToolEvidence: spec.completion.requiresToolEvidence,
      requiresSubstantiveFinalAnswer: spec.completion.requiresSubstantiveFinalAnswer,
      forbidSuccessAfterToolErrors: spec.completion.forbidSuccessAfterToolErrors,
      mutationMode: spec.policies.mutationPolicy === 'Do not mutate the project surface.' ? 'none' : 'workspace-write',
      includeMemory: spec.contextProfile?.includeMemory,
      includeSkills: spec.contextProfile?.includeSkills,
      includeHistorySummary: spec.contextProfile?.includeHistorySummary,
      diagnosticsParticipationLevel: spec.diagnosticsProfile?.diagnosticsParticipationLevel,
      redactionSensitivity: spec.diagnosticsProfile?.redactionSensitivity
    },
    effectiveCompletion: {
      completionMode: spec.completion.completionMode,
      doneCriteriaShape: spec.completion.doneCriteriaShape,
      evidenceRequirement: spec.completion.evidenceRequirement,
      stopVsDoneDistinction: spec.completion.stopVsDoneDistinction
    },
    effectiveDiagnostics: spec.diagnosticsProfile?.traceabilityExpectation
      ? {
          traceabilityExpectation: spec.diagnosticsProfile.traceabilityExpectation
        }
      : undefined,
    effectivePromptFiles: buildPromptFiles(spec),
    resolvedFiles: []
  };
}

function buildPromptFiles(spec: AgentSpec): Partial<Record<AgentPromptSlotFileName, { filePath: string; content: string }>> {
  return {
    'AGENT.md': {
      filePath: 'builtin://AGENT.md',
      content: [
        `Purpose: ${spec.identity.purpose}`,
        `Scope boundary: ${spec.identity.scopeBoundary}`
      ].join('\n')
    },
    'SOUL.md': {
      filePath: 'builtin://SOUL.md',
      content: [
        `Behavioral framing: ${spec.identity.behavioralFraming}`,
        `Safety stance: ${spec.policies.safetyStance}`,
        `Escalation policy: ${spec.policies.escalationPolicy}`
      ].join('\n')
    },
    'STYLE.md': {
      filePath: 'builtin://STYLE.md',
      content: [
        `Operating surface: ${spec.capabilities.operatingSurface}`,
        spec.contextProfile?.priorityHints?.length
          ? `Priority hints: ${spec.contextProfile.priorityHints.join('; ')}`
          : ''
      ].filter((line) => line.length > 0).join('\n')
    },
    'TOOLS.md': {
      filePath: 'builtin://TOOLS.md',
      content: [
        `Allowed capability classes: ${spec.capabilities.allowedCapabilityClasses.join(', ')}`,
        `Tool-use policy: ${spec.policies.toolUsePolicy}`,
        `Mutation policy: ${spec.policies.mutationPolicy}`,
        spec.capabilities.capabilityExclusions.length > 0
          ? `Capability exclusions: ${spec.capabilities.capabilityExclusions.join('; ')}`
          : ''
      ].filter((line) => line.length > 0).join('\n')
    },
    'USER.md': {
      filePath: 'builtin://USER.md',
      content: ''
    }
  };
}
