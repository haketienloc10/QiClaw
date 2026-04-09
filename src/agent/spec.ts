export type AgentCapabilityClass = 'read' | 'write' | 'search' | 'exec_readonly' | 'execute';
export type AgentPackageSourceTier = 'project' | 'user' | 'builtin';
export type AgentPromptSlotFileName = 'AGENT.md' | 'SOUL.md' | 'STYLE.md' | 'TOOLS.md' | 'CHECKLIST.md';
export type AgentMutationMode = 'none' | 'workspace-write';
export type AgentDiagnosticsParticipationLevel = 'none' | 'normal' | 'trace-oriented' | 'audit-oriented';
export type AgentRedactionSensitivity = 'standard' | 'standard-to-high' | 'high';

export interface AgentIdentitySpec {
  purpose: string;
  behavioralFraming: string;
  scopeBoundary: string;
}

export interface AgentCapabilitiesSpec {
  allowedCapabilityClasses: AgentCapabilityClass[];
  operatingSurface: string;
  capabilityExclusions: string[];
}

export interface AgentPoliciesSpec {
  safetyStance: string;
  toolUsePolicy: string;
  escalationPolicy: string;
  mutationPolicy: string;
}

export interface AgentCompletionSpec {
  completionMode: string;
  doneCriteriaShape: string;
  evidenceRequirement: string;
  stopVsDoneDistinction: string;
  maxToolRounds: number;
  requiresToolEvidence?: boolean;
  requiresSubstantiveFinalAnswer?: boolean;
  forbidSuccessAfterToolErrors?: boolean;
}

export interface AgentContextProfile {
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeHistorySummary?: boolean;
  priorityHints?: string[];
}

export interface AgentDiagnosticsProfile {
  diagnosticsParticipationLevel: AgentDiagnosticsParticipationLevel;
  traceabilityExpectation?: string;
  redactionSensitivity?: AgentRedactionSensitivity;
}

export interface AgentSpec {
  identity: AgentIdentitySpec;
  capabilities: AgentCapabilitiesSpec;
  policies: AgentPoliciesSpec;
  completion: AgentCompletionSpec;
  contextProfile?: AgentContextProfile;
  diagnosticsProfile?: AgentDiagnosticsProfile;
}

export interface AgentRuntimePolicy {
  allowedCapabilityClasses?: AgentCapabilityClass[];
  maxToolRounds?: number;
  requiresToolEvidence?: boolean;
  requiresSubstantiveFinalAnswer?: boolean;
  forbidSuccessAfterToolErrors?: boolean;
  mutationMode?: AgentMutationMode;
  includeMemory?: boolean;
  includeSkills?: boolean;
  includeHistorySummary?: boolean;
  diagnosticsParticipationLevel?: AgentDiagnosticsParticipationLevel;
  redactionSensitivity?: AgentRedactionSensitivity;
}

export interface AgentPackageManifest {
  extends?: string;
  policy?: AgentRuntimePolicy;
}

export interface AgentPromptFile {
  filePath: string;
  content: string;
}

export interface LoadedAgentPackage {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  directoryPath: string;
  manifestPath: string;
  manifest?: AgentPackageManifest;
  promptFiles: Partial<Record<AgentPromptSlotFileName, AgentPromptFile>>;
}

export interface ResolvedAgentPackage {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  extendsChain: string[];
  packageChain: LoadedAgentPackage[];
  effectivePolicy: AgentRuntimePolicy;
  effectivePromptFiles: Partial<Record<AgentPromptSlotFileName, AgentPromptFile>>;
  resolvedFiles: string[];
}

export interface AgentPackagePreview {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  extendsChain: string[];
  sectionFiles: Partial<Record<AgentPromptSlotFileName, string>>;
  resolvedFiles: string[];
  effectiveRuntimePolicy: AgentRuntimePolicy;
  renderedPromptText: string;
}
