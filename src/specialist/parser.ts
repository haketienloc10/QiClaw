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
    case 'review': {
      const coerced = coerceReviewArtifact(parsed);
      return coerced && isReviewArtifact(coerced) ? coerced : buildFallbackArtifact(kind, rawOutput);
    }
  }
}

function tryParseJsonObject(rawOutput: string): Record<string, unknown> | undefined {
  for (const candidate of buildJsonCandidates(rawOutput)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }

  return undefined;
}

function buildJsonCandidates(rawOutput: string): string[] {
  const trimmed = rawOutput.trim();
  const candidates = new Set<string>();

  if (trimmed.length > 0) {
    candidates.add(trimmed);
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    candidates.add(fencedMatch[1].trim());
  }

  const extractedObject = extractFirstJsonObject(trimmed);
  if (extractedObject) {
    candidates.add(extractedObject);
  }

  return [...candidates];
}

function extractFirstJsonObject(rawOutput: string): string | undefined {
  const start = rawOutput.indexOf('{');
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < rawOutput.length; index += 1) {
    const character = rawOutput[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (character === '\\') {
        escaping = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return rawOutput.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function isResearchArtifact(value: unknown): value is ResearchArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'research'
    && hasBaseArtifactShape(candidate)
    && isStringArray(candidate.findings)
    && isStringArray(candidate.openQuestions)
    && isStringArray(candidate.evidence);
}

function isDebugArtifact(value: unknown): value is DebugArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'debug'
    && hasBaseArtifactShape(candidate)
    && Array.isArray(candidate.likelyCauses)
    && candidate.likelyCauses.every(isDebugLikelyCause)
    && isStringArray(candidate.evidence)
    && isStringArray(candidate.proposedFixes)
    && isStringArray(candidate.unresolvedRisks);
}

function isReviewArtifact(value: unknown): value is ReviewArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'review'
    && hasBaseArtifactShape(candidate)
    && Array.isArray(candidate.findings)
    && candidate.findings.every(isReviewFinding)
    && isStringArray(candidate.blockingIssues)
    && isStringArray(candidate.nonBlockingIssues)
    && (candidate.verdict === 'pass' || candidate.verdict === 'changes_requested' || candidate.verdict === 'needs_followup');
}

function coerceReviewArtifact(value: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isReviewArtifact(value)) {
    return value as unknown as Record<string, unknown>;
  }

  const rawFindings = value.findings;
  if (typeof value.summary !== 'string' || !Array.isArray(rawFindings)) {
    return undefined;
  }

  const findings = rawFindings
    .map(coerceReviewFinding)
    .filter((finding): finding is ReviewFinding => Boolean(finding));

  if (findings.length !== rawFindings.length) {
    return undefined;
  }

  const blockingIssues = isStringArray(value.blockingIssues)
    ? value.blockingIssues
    : findings
      .filter((_, index) => isBlockingReviewFinding(rawFindings[index]))
      .map((finding) => finding.title);
  const nonBlockingIssues = isStringArray(value.nonBlockingIssues)
    ? value.nonBlockingIssues
    : findings
      .filter((_, index) => !isBlockingReviewFinding(rawFindings[index]))
      .map((finding) => finding.title);

  return {
    kind: 'review',
    summary: value.summary,
    confidence: typeof value.confidence === 'number' ? value.confidence : 0.6,
    suggestedNextSteps: isStringArray(value.suggestedNextSteps)
      ? value.suggestedNextSteps
      : [...blockingIssues, ...nonBlockingIssues].slice(0, 3),
    findings,
    blockingIssues,
    nonBlockingIssues,
    verdict: coerceReviewVerdict(value.verdict, blockingIssues.length > 0)
  };
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

function coerceReviewFinding(value: unknown): ReviewFinding | undefined {
  if (isReviewFinding(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as {
    severity?: unknown;
    title?: unknown;
    issue?: unknown;
    details?: unknown;
    evidence?: unknown;
  };
  const title = typeof candidate.title === 'string'
    ? candidate.title
    : typeof candidate.issue === 'string'
      ? candidate.issue
      : undefined;
  const details = typeof candidate.details === 'string'
    ? candidate.details
    : isStringArray(candidate.evidence)
      ? candidate.evidence.join('\n')
      : typeof candidate.evidence === 'string'
        ? candidate.evidence
        : undefined;

  if (!title || !details) {
    return undefined;
  }

  if (candidate.severity !== 'low' && candidate.severity !== 'medium' && candidate.severity !== 'high') {
    return undefined;
  }

  return {
    severity: candidate.severity,
    title,
    details
  };
}

function isBlockingReviewFinding(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && (value as { blocking?: unknown }).blocking === true;
}

function coerceReviewVerdict(value: unknown, hasBlockingIssues: boolean): ReviewArtifact['verdict'] {
  if (value === 'pass' || value === 'changes_requested' || value === 'needs_followup') {
    return value;
  }

  if (value === 'reject') {
    return 'changes_requested';
  }

  return hasBlockingIssues ? 'changes_requested' : 'needs_followup';
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
