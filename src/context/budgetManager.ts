export interface ContextBudgetBuckets {
  system: number;
  recentHistory: number;
  memory: number;
  skills: number;
  oldHistory: number;
}

export interface ContextBudgetAllocation {
  total: number;
  reserved: number;
  available: number;
  buckets: ContextBudgetBuckets;
}

export interface AllocateContextBudgetInput {
  total: number;
  reserveChars?: number;
}

const BUCKET_ORDER: Array<keyof ContextBudgetBuckets> = [
  'system',
  'recentHistory',
  'memory',
  'skills',
  'oldHistory'
];

const REMAINDER_ORDER: Array<keyof ContextBudgetBuckets> = [
  'system',
  'oldHistory',
  'recentHistory',
  'memory',
  'skills'
];

const BUCKET_WEIGHTS: Record<keyof ContextBudgetBuckets, number> = {
  system: 25,
  recentHistory: 35,
  memory: 15,
  skills: 10,
  oldHistory: 15
};

export function allocateContextBudget(input: AllocateContextBudgetInput): ContextBudgetAllocation {
  const total = Math.max(0, Math.floor(input.total));
  const reserved = Math.min(total, Math.max(0, Math.floor(input.reserveChars ?? 0)));
  const available = total - reserved;

  if (available === 0) {
    return {
      total,
      reserved,
      available,
      buckets: {
        system: 0,
        recentHistory: 0,
        memory: 0,
        skills: 0,
        oldHistory: 0
      }
    };
  }

  const weightTotal = BUCKET_ORDER.reduce((sum, bucket) => sum + BUCKET_WEIGHTS[bucket], 0);
  const buckets = {
    system: 0,
    recentHistory: 0,
    memory: 0,
    skills: 0,
    oldHistory: 0
  } satisfies ContextBudgetBuckets;

  let remainder = available;

  for (const bucket of BUCKET_ORDER) {
    const portion = Math.floor((available * BUCKET_WEIGHTS[bucket]) / weightTotal);
    buckets[bucket] = portion;
    remainder -= portion;
  }

  for (const bucket of REMAINDER_ORDER) {
    if (remainder === 0) {
      break;
    }

    buckets[bucket] += 1;
    remainder -= 1;
  }

  return {
    total,
    reserved,
    available,
    buckets
  };
}
