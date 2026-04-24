export type BlueprintStatus = 'active' | 'superseded' | 'retired';

export interface BlueprintTrigger {
  title: string;
  patterns: string[];
  tags: string[];
}

export interface BlueprintPrecondition {
  description: string;
  required?: boolean;
}

export interface BlueprintEvidenceRequirement {
  description: string;
  kind: 'tool_result' | 'final_answer' | 'state_change' | 'user_confirmation';
  required: boolean;
}

export interface BlueprintFailureMode {
  title: string;
  signals: string[];
  mitigation?: string;
}

export interface BlueprintStep {
  id: string;
  title: string;
  instruction: string;
  kind: 'inspect' | 'act' | 'verify' | 'communicate';
  expectedEvidence?: string[];
  onFailure?: string;
  nextStepId?: string;
}

export interface BlueprintBranch {
  id: string;
  condition: string;
  gotoStepId: string;
}

export interface BlueprintStats {
  useCount: number;
  successCount: number;
  failureCount: number;
  lastUsedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
}

export interface BlueprintRecord {
  id: string;
  title: string;
  goal: string;
  trigger: BlueprintTrigger;
  preconditions: BlueprintPrecondition[];
  steps: BlueprintStep[];
  branches: BlueprintBranch[];
  expectedEvidence: BlueprintEvidenceRequirement[];
  failureModes: BlueprintFailureMode[];
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  status: BlueprintStatus;
  stats: BlueprintStats;
  supersedesBlueprintId?: string;
}

export interface PersistedBlueprintRecord extends BlueprintRecord {
  markdownPath: string;
  sourceContentHash?: string;
}

export interface BlueprintMatch {
  blueprint: BlueprintRecord;
  score: number;
  reasons: string[];
}

export interface BlueprintOutcome {
  used: boolean;
  status: 'success' | 'failure';
}

export interface BlueprintStoreMeta {
  version: number;
  engine: string;
  indexPath: string;
  metaPath: string;
  totalEntries: number;
  lastSealedAt: string | null;
}

export interface BlueprintArtifactPaths {
  directoryPath: string;
  indexPath: string;
  metaPath: string;
}
