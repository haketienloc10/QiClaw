import type { SessionMemoryCandidate, SessionMemoryFidelity } from './sessionMemoryTypes.js';

export interface AssignMemoryFidelityInput {
  remainingChars: number;
  hotThreshold: number;
  warmThreshold: number;
}

export interface AssignedMemoryFidelity {
  candidate: SessionMemoryCandidate;
  fidelity: SessionMemoryFidelity;
  renderedText: string;
}

export function assignMemoryFidelity(
  candidate: SessionMemoryCandidate,
  input: AssignMemoryFidelityInput
): AssignedMemoryFidelity {
  const remainingChars = Math.max(0, input.remainingChars);
  const preferredFidelity = getPreferredFidelity(candidate.finalScore, input.hotThreshold, input.warmThreshold);
  const fidelity = chooseFidelityForBudget(candidate, preferredFidelity, remainingChars);
  const renderedText = renderForFidelity(candidate, fidelity);

  return {
    candidate: {
      ...candidate,
      fidelity
    },
    fidelity,
    renderedText
  };
}

function getPreferredFidelity(score: number, hotThreshold: number, warmThreshold: number): SessionMemoryFidelity {
  if (score >= hotThreshold) {
    return 'full';
  }

  if (score >= warmThreshold) {
    return 'summary';
  }

  return 'essence';
}

function chooseFidelityForBudget(
  candidate: SessionMemoryCandidate,
  preferredFidelity: SessionMemoryFidelity,
  remainingChars: number
): SessionMemoryFidelity {
  const fallbackOrder: SessionMemoryFidelity[] = preferredFidelity === 'full'
    ? ['full', 'summary', 'essence', 'hash']
    : preferredFidelity === 'summary'
      ? ['summary', 'essence', 'hash']
      : ['essence', 'hash'];

  for (const fidelity of fallbackOrder) {
    if (renderForFidelity(candidate, fidelity).length <= remainingChars) {
      return fidelity;
    }
  }

  return 'hash';
}

function renderForFidelity(candidate: SessionMemoryCandidate, fidelity: SessionMemoryFidelity): string {
  switch (fidelity) {
    case 'full':
      return candidate.fullText;
    case 'summary':
      return candidate.summaryText;
    case 'essence':
      return candidate.essenceText;
    case 'hash':
      return `#${candidate.hash}`;
  }
}
