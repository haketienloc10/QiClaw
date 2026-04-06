import type { SessionMemoryCandidate } from './sessionMemoryTypes.js';

export interface ScoreSessionMemoryCandidateInput {
  now?: string;
  explicitSaveBoost?: number;
  accessCountWeight?: number;
  ageDecayHours?: number;
}

const DEFAULT_EXPLICIT_SAVE_BOOST = 0.05;
const DEFAULT_ACCESS_COUNT_WEIGHT = 0.03;
const DEFAULT_AGE_DECAY_HOURS = 24;

export function scoreSessionMemoryCandidate(
  candidate: SessionMemoryCandidate,
  input: ScoreSessionMemoryCandidateInput = {}
): number {
  const nowTime = Date.parse(input.now ?? new Date().toISOString());
  const lastAccessedTime = Date.parse(candidate.lastAccessed);
  const createdAtTime = Date.parse(candidate.createdAt);
  const freshestTime = Number.isNaN(lastAccessedTime) ? createdAtTime : lastAccessedTime;
  const ageHours = Math.max(0, (nowTime - freshestTime) / 3_600_000);
  const ageDecayHours = Math.max(1, input.ageDecayHours ?? DEFAULT_AGE_DECAY_HOURS);
  const recencyFactor = Math.exp(-ageHours / ageDecayHours);
  const explicitSaveBoost = input.explicitSaveBoost ?? DEFAULT_EXPLICIT_SAVE_BOOST;
  const accessCountWeight = input.accessCountWeight ?? DEFAULT_ACCESS_COUNT_WEIGHT;
  const decayedImportance = candidate.importance * recencyFactor;
  const accessBoost = Math.log1p(Math.max(0, candidate.accessCount)) * accessCountWeight;

  return candidate.retrievalScore +
    decayedImportance +
    accessBoost +
    (candidate.explicitSave ? explicitSaveBoost : 0);
}
