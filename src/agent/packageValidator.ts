import type {
  AgentCapabilityClass,
  AgentDiagnosticsParticipationLevel,
  AgentMutationMode,
  AgentPackageManifest,
  AgentRedactionSensitivity,
  AgentRuntimePolicy,
  LoadedAgentPackage,
  ResolvedAgentPackage
} from './spec.js';

const validCapabilityClasses = new Set<AgentCapabilityClass>(['read', 'write', 'search', 'exec_readonly', 'execute']);
const validMutationModes = new Set<AgentMutationMode>(['none', 'workspace-write']);
const validDiagnosticsParticipationLevels = new Set<AgentDiagnosticsParticipationLevel>([
  'none',
  'normal',
  'trace-oriented',
  'audit-oriented'
]);
const validRedactionSensitivityLevels = new Set<AgentRedactionSensitivity>(['standard', 'standard-to-high', 'high']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAgentPackageExtendsTarget(rootPreset: string, missingPreset: string): string[] {
  return [`Agent package "${rootPreset}" extends unknown package "${missingPreset}".`];
}

export function validateAgentPackageExtendsCycle(stack: string[], preset: string): string[] {
  return [`Detected agent package extends cycle: ${[...stack, preset].join(' -> ')}`];
}

export function validateLoadedAgentPackage(agentPackage: LoadedAgentPackage): string[] {
  const errors: string[] = [];

  if (agentPackage.manifest === undefined) {
    errors.push(`Agent package "${agentPackage.preset}" is missing agent.json.`);
    return errors;
  }

  if (!isPlainObject(agentPackage.manifest)) {
    errors.push(`Agent package "${agentPackage.preset}" must define agent.json as a plain object.`);
    return errors;
  }

  errors.push(...validateManifestShape(agentPackage.preset, agentPackage.manifest));

  if (errors.length > 0) {
    return errors;
  }

  if (!agentPackage.manifest.extends && !agentPackage.promptFiles['AGENT.md']) {
    errors.push(`Base package "${agentPackage.preset}" must provide AGENT.md.`);
  }

  if (!agentPackage.manifest.extends && !agentPackage.promptFiles['USER.md']) {
    errors.push(`Base package "${agentPackage.preset}" must provide USER.md.`);
  }

  const manifestPolicy = agentPackage.manifest.policy;
  const allowedCapabilityClasses = isPlainObject(manifestPolicy)
    ? (manifestPolicy.allowedCapabilityClasses as unknown)
    : undefined;

  if (Array.isArray(allowedCapabilityClasses)) {
    for (const capabilityClass of allowedCapabilityClasses) {
      if (!validCapabilityClasses.has(capabilityClass as AgentCapabilityClass)) {
        errors.push(`Agent package "${agentPackage.preset}" declares invalid capability class "${String(capabilityClass)}".`);
      }
    }
  }

  return errors;
}

export function validateResolvedAgentPackage(agentPackage: ResolvedAgentPackage): string[] {
  const errors: string[] = [];
  const maxToolRounds = agentPackage.effectivePolicy.maxToolRounds;
  const allowedCapabilityClasses = agentPackage.effectivePolicy.allowedCapabilityClasses ?? [];

  if (typeof maxToolRounds === 'number' && maxToolRounds < 1) {
    errors.push(`Agent package "${agentPackage.preset}" must set maxToolRounds to at least 1.`);
  }

  if (
    agentPackage.effectivePolicy.mutationMode === 'none' &&
    allowedCapabilityClasses.some((capabilityClass) => capabilityClass === 'write' || capabilityClass === 'execute')
  ) {
    errors.push(
      `Agent package "${agentPackage.preset}" cannot allow write or execute capabilities when mutationMode is "none".`
    );
  }

  return errors;
}

export function validateManifestShape(preset: string, manifest: LoadedAgentPackage['manifest']): string[] {
  if (manifest === undefined) {
    return [];
  }

  if (!isPlainObject(manifest)) {
    return [`Agent package "${preset}" must define agent.json as a plain object.`];
  }

  const errors: string[] = [];
  const policy = manifest.policy;
  const completion = manifest.completion;
  const diagnostics = manifest.diagnostics;

  if (manifest.extends !== undefined) {
    if (typeof manifest.extends !== 'string') {
      errors.push(`Agent package "${preset}" must set extends to a string when provided.`);
    } else if (manifest.extends.trim().length === 0) {
      errors.push(`Agent package "${preset}" must set extends to a non-empty string when provided.`);
    }
  }

  if (policy !== undefined) {
    if (!isPlainObject(policy)) {
      errors.push(`Agent package "${preset}" must set policy to a plain object when provided.`);
      return errors;
    }

    errors.push(...validateRuntimePolicyShape(preset, policy as AgentRuntimePolicy));
  }

  if (completion !== undefined) {
    if (!isPlainObject(completion)) {
      errors.push(`Agent package "${preset}" must set completion to a plain object when provided.`);
      return errors;
    }

    errors.push(...validateCompletionShape(preset, completion as NonNullable<AgentPackageManifest['completion']>));
  }

  if (diagnostics !== undefined) {
    if (!isPlainObject(diagnostics)) {
      errors.push(`Agent package "${preset}" must set diagnostics to a plain object when provided.`);
      return errors;
    }

    errors.push(...validateDiagnosticsShape(preset, diagnostics as NonNullable<AgentPackageManifest['diagnostics']>));
  }

  return errors;
}

function validateCompletionShape(preset: string, completion: NonNullable<AgentPackageManifest['completion']>): string[] {
  const errors: string[] = [];

  if (completion.completionMode !== undefined && typeof completion.completionMode !== 'string') {
    errors.push(`Agent package "${preset}" must set completion.completionMode to a string when provided.`);
  }

  if (completion.doneCriteriaShape !== undefined && typeof completion.doneCriteriaShape !== 'string') {
    errors.push(`Agent package "${preset}" must set completion.doneCriteriaShape to a string when provided.`);
  }

  if (completion.evidenceRequirement !== undefined && typeof completion.evidenceRequirement !== 'string') {
    errors.push(`Agent package "${preset}" must set completion.evidenceRequirement to a string when provided.`);
  }

  if (completion.stopVsDoneDistinction !== undefined && typeof completion.stopVsDoneDistinction !== 'string') {
    errors.push(`Agent package "${preset}" must set completion.stopVsDoneDistinction to a string when provided.`);
  }

  return errors;
}

function validateDiagnosticsShape(preset: string, diagnostics: NonNullable<AgentPackageManifest['diagnostics']>): string[] {
  const errors: string[] = [];

  if (diagnostics.traceabilityExpectation !== undefined && typeof diagnostics.traceabilityExpectation !== 'string') {
    errors.push(`Agent package "${preset}" must set diagnostics.traceabilityExpectation to a string when provided.`);
  }

  return errors;
}

function validateRuntimePolicyShape(preset: string, policy: AgentRuntimePolicy): string[] {
  const errors: string[] = [];

  if (policy.allowedCapabilityClasses !== undefined && !Array.isArray(policy.allowedCapabilityClasses)) {
    errors.push(`Agent package "${preset}" must set allowedCapabilityClasses to an array when provided.`);
  }

  if (
    policy.maxToolRounds !== undefined &&
    (!Number.isInteger(policy.maxToolRounds) || policy.maxToolRounds < 1)
  ) {
    errors.push(`Agent package "${preset}" must set maxToolRounds to a positive integer when provided.`);
  }

  if (policy.mutationMode !== undefined && !validMutationModes.has(policy.mutationMode)) {
    errors.push(`Agent package "${preset}" declares invalid mutationMode "${policy.mutationMode}".`);
  }

  if (policy.includeMemory !== undefined && typeof policy.includeMemory !== 'boolean') {
    errors.push(`Agent package "${preset}" must set includeMemory to a boolean when provided.`);
  }

  if (policy.includeSkills !== undefined && typeof policy.includeSkills !== 'boolean') {
    errors.push(`Agent package "${preset}" must set includeSkills to a boolean when provided.`);
  }

  if (policy.includeHistorySummary !== undefined && typeof policy.includeHistorySummary !== 'boolean') {
    errors.push(`Agent package "${preset}" must set includeHistorySummary to a boolean when provided.`);
  }

  if (policy.requiresToolEvidence !== undefined && typeof policy.requiresToolEvidence !== 'boolean') {
    errors.push(`Agent package "${preset}" must set requiresToolEvidence to a boolean when provided.`);
  }

  if (
    policy.requiresSubstantiveFinalAnswer !== undefined &&
    typeof policy.requiresSubstantiveFinalAnswer !== 'boolean'
  ) {
    errors.push(`Agent package "${preset}" must set requiresSubstantiveFinalAnswer to a boolean when provided.`);
  }

  if (policy.forbidSuccessAfterToolErrors !== undefined && typeof policy.forbidSuccessAfterToolErrors !== 'boolean') {
    errors.push(`Agent package "${preset}" must set forbidSuccessAfterToolErrors to a boolean when provided.`);
  }

  if (
    policy.diagnosticsParticipationLevel !== undefined &&
    !validDiagnosticsParticipationLevels.has(policy.diagnosticsParticipationLevel)
  ) {
    errors.push(
      `Agent package "${preset}" declares invalid diagnosticsParticipationLevel "${policy.diagnosticsParticipationLevel}".`
    );
  }

  if (policy.redactionSensitivity !== undefined && !validRedactionSensitivityLevels.has(policy.redactionSensitivity)) {
    errors.push(`Agent package "${preset}" declares invalid redactionSensitivity "${policy.redactionSensitivity}".`);
  }

  return errors;
}
