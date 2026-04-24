import type { RunAgentTurnResult } from '../agent/loop.js';
import type { BlueprintOutcome, BlueprintRecord } from './types.js';

export function deriveBlueprintOutcome(result: RunAgentTurnResult): BlueprintOutcome {
  return {
    used: true,
    status: result.stopReason === 'completed' && result.verification.isVerified ? 'success' : 'failure'
  };
}

export function applyBlueprintOutcome(input: {
  blueprint: BlueprintRecord;
  outcome: BlueprintOutcome;
  now?: string;
}): BlueprintRecord {
  if (!input.outcome.used) {
    return input.blueprint;
  }

  const now = input.now ?? new Date().toISOString();
  const { stats } = input.blueprint;

  return {
    ...input.blueprint,
    updatedAt: now,
    stats: {
      ...stats,
      useCount: stats.useCount + 1,
      successCount: stats.successCount + (input.outcome.status === 'success' ? 1 : 0),
      failureCount: stats.failureCount + (input.outcome.status === 'failure' ? 1 : 0),
      lastUsedAt: now,
      lastSucceededAt: input.outcome.status === 'success' ? now : stats.lastSucceededAt,
      lastFailedAt: input.outcome.status === 'failure' ? now : stats.lastFailedAt
    }
  };
}
