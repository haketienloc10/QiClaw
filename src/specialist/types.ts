import type { AgentCapabilityClass } from '../agent/spec.js';

export type SpecialistKind = 'research' | 'debug' | 'review';

export interface SpecialistBrief {
  sessionId?: string;
  parentTaskId?: string;
  kind: SpecialistKind;
  goal: string;
  relevantContext?: string;
  constraints?: string[];
  evidenceSnippets?: string[];
}

export interface SpecialistArtifactBase {
  kind: SpecialistKind;
  summary: string;
  confidence: number;
  suggestedNextSteps: string[];
}

export interface ResearchArtifact extends SpecialistArtifactBase {
  kind: 'research';
  findings: string[];
  openQuestions: string[];
  evidence: string[];
}

export interface DebugLikelyCause {
  title: string;
  confidence: number;
  evidence: string[];
}

export interface DebugArtifact extends SpecialistArtifactBase {
  kind: 'debug';
  likelyCauses: DebugLikelyCause[];
  evidence: string[];
  proposedFixes: string[];
  unresolvedRisks: string[];
}

export interface ReviewFinding {
  severity: 'low' | 'medium' | 'high';
  title: string;
  details: string;
}

export interface ReviewArtifact extends SpecialistArtifactBase {
  kind: 'review';
  findings: ReviewFinding[];
  blockingIssues: string[];
  nonBlockingIssues: string[];
  verdict: 'pass' | 'changes_requested' | 'needs_followup';
}

export type SpecialistArtifact = ResearchArtifact | DebugArtifact | ReviewArtifact;

export type SpecialistRouteDecision =
  | {
      kind: 'main';
    }
  | {
      kind: 'specialist';
      specialist: SpecialistKind;
      reason: 'explicit' | 'heuristic';
      matchedRule: string;
      normalizedInput: string;
    };

export interface SpecialistToolPolicy {
  allowedCapabilityClasses: AgentCapabilityClass[];
  allowedToolNames?: string[];
}

export interface SpecialistDefinition {
  kind: SpecialistKind;
  slashCommand: `/${SpecialistKind}`;
  heuristicPatterns: RegExp[];
  systemPrompt: string;
  toolPolicy: SpecialistToolPolicy;
}

export interface SpecialistExecutionResult {
  artifact: SpecialistArtifact;
  rawOutput: string;
  parsed: boolean;
  finalAnswer: string;
  toolNames: string[];
}
