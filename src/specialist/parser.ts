import type {
  DebugArtifact,
  DebugLikelyCause,
  ResearchArtifact,
  ReviewArtifact,
  ReviewFinding,
  SpecialistArtifact,
  SpecialistKind
} from './types.js';

export function parseSpecialistArtifact(kind: SpecialistKind, rawOutput: string): SpecialistArtifact {
  const parsed = tryParseJsonObject(rawOutput);
  if (!parsed) {
    return buildFallbackArtifact(kind, rawOutput);
  }

  switch (kind) {
    case 'research':
      return isResearchArtifact(parsed) ? parsed : buildFallbackArtifact(kind, rawOutput);
    case 'debug':
      return isDebugArtifact(parsed) ? parsed : buildFallbackArtifact(kind, rawOutput);
    case 'review':
      return isReviewArtifact(parsed) ? parsed : buildFallbackArtifact(kind, rawOutput);
  }
}

function tryParseJsonObject(rawOutput: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawOutput);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isResearchArtifact(value: Record<string, unknown>): value is ResearchArtifact {
  return value.kind === 'research'
    && hasBaseArtifactShape(value)
    && isStringArray(value.findings)
    && isStringArray(value.openQuestions)
    && isStringArray(value.evidence);
}

function isDebugArtifact(value: Record<string, unknown>): value is DebugArtifact {
  return value.kind === 'debug'
    && hasBaseArtifactShape(value)
    && Array.isArray(value.likelyCauses)
    && value.likelyCauses.every(isDebugLikelyCause)
    && isStringArray(value.evidence)
    && isStringArray(value.proposedFixes)
    && isStringArray(value.unresolvedRisks);
}

function isReviewArtifact(value: Record<string, unknown>): value is ReviewArtifact {
  return value.kind === 'review'
    && hasBaseArtifactShape(value)
    && Array.isArray(value.findings)
    && value.findings.every(isReviewFinding)
    && isStringArray(value.blockingIssues)
    && isStringArray(value.nonBlockingIssues)
    && (value.verdict === 'pass' || value.verdict === 'changes_requested' || value.verdict === 'needs_followup');
}

function hasBaseArtifactShape(value: Record<string, unknown>): boolean {
  return typeof value.summary === 'string'
    && typeof value.confidence === 'number'
    && Array.isArray(value.suggestedNextSteps)
    && value.suggestedNextSteps.every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDebugLikelyCause(value: unknown): value is DebugLikelyCause {
  return !!value
    && typeof value === 'object'
    && typeof (value as { title?: unknown }).title === 'string'
    && typeof (value as { confidence?: unknown }).confidence === 'number'
    && isStringArray((value as { evidence?: unknown }).evidence);
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  return !!value
    && typeof value === 'object'
    && (((value as { severity?: unknown }).severity === 'low')
      || ((value as { severity?: unknown }).severity === 'medium')
      || ((value as { severity?: unknown }).severity === 'high'))
    && typeof (value as { title?: unknown }).title === 'string'
    && typeof (value as { details?: unknown }).details === 'string';
}

function buildFallbackArtifact(kind: SpecialistKind, rawOutput: string): SpecialistArtifact {
  const summary = 'Could not parse specialist output into a structured artifact.';
  const suggestedNextSteps = [
    'Review the raw specialist output manually.',
    'Retry the specialist with a narrower brief if needed.'
  ];

  switch (kind) {
    case 'research':
      return {
        kind,
        summary,
        confidence: 0.2,
        suggestedNextSteps,
        findings: rawOutput.trim().length > 0 ? [rawOutput.trim()] : [],
        openQuestions: [],
        evidence: []
      };
    case 'debug':
      return {
        kind,
        summary,
        confidence: 0.2,
        suggestedNextSteps,
        likelyCauses: [],
        evidence: [],
        proposedFixes: [],
        unresolvedRisks: []
      };
    case 'review':
      return {
        kind,
        summary,
        confidence: 0.2,
        suggestedNextSteps,
        findings: [],
        blockingIssues: [],
        nonBlockingIssues: rawOutput.trim().length > 0 ? [rawOutput.trim()] : [],
        verdict: 'needs_followup'
      };
  }
}
