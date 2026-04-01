export type AgentCapabilityClass = 'workspace_read' | 'workspace_write' | 'workspace_search' | 'workspace_shell';

export interface AgentIdentitySpec {
  purpose: string;
  behavioralFraming: string;
  scopeBoundary: string;
}

export interface AgentCapabilitiesSpec {
  allowedCapabilityClasses: AgentCapabilityClass[];
  workspaceRelationship: string;
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
  diagnosticsParticipationLevel: 'none' | 'normal' | 'trace-oriented' | 'audit-oriented';
  traceabilityExpectation?: string;
  redactionSensitivity?: 'standard' | 'standard-to-high' | 'high';
}

export interface AgentSpec {
  identity: AgentIdentitySpec;
  capabilities: AgentCapabilitiesSpec;
  policies: AgentPoliciesSpec;
  completion: AgentCompletionSpec;
  contextProfile?: AgentContextProfile;
  diagnosticsProfile?: AgentDiagnosticsProfile;
}
