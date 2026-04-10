export type AgentCapabilityClass = 'read' | 'write' | 'search' | 'exec_readonly' | 'execute';
export type AgentPackageSourceTier = 'project' | 'user' | 'builtin';
export type AgentPromptFileName = string;
export type AgentMutationMode = 'none' | 'workspace-write';
export type AgentDiagnosticsParticipationLevel = 'none' | 'normal' | 'trace-oriented' | 'audit-oriented';
export type AgentRedactionSensitivity = 'standard' | 'standard-to-high' | 'high';

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

export interface AgentCompletionMetadata {
  completionMode?: string;
  doneCriteriaShape?: string;
  evidenceRequirement?: string;
  stopVsDoneDistinction?: string;
}

export interface AgentPackageDiagnosticsManifest {
  traceabilityExpectation?: string;
}

export interface AgentPackageManifest {
  extends?: string;
  promptFiles?: AgentPromptFileName[];
  policy?: AgentRuntimePolicy;
  completion?: AgentCompletionMetadata;
  diagnostics?: AgentPackageDiagnosticsManifest;
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
  promptFiles: Record<AgentPromptFileName, AgentPromptFile>;
}

export interface ResolvedAgentPackage {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  extendsChain: string[];
  packageChain: LoadedAgentPackage[];
  effectivePolicy: AgentRuntimePolicy;
  effectiveCompletion?: AgentPackageManifest['completion'];
  effectiveDiagnostics?: AgentPackageManifest['diagnostics'];
  effectivePromptOrder: AgentPromptFileName[];
  effectivePromptFiles: Record<AgentPromptFileName, AgentPromptFile>;
  resolvedFiles: string[];
}

export interface AgentPackagePreview {
  preset: string;
  sourceTier: AgentPackageSourceTier;
  extendsChain: string[];
  promptFiles: Array<{ fileName: string; filePath: string }>;
  resolvedFiles: string[];
  effectiveRuntimePolicy: AgentRuntimePolicy;
  renderedPromptText: string;
}
