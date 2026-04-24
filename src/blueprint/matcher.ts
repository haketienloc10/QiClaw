import type { BlueprintMatch, BlueprintRecord } from './types.js';

export function matchBlueprints(input: {
  userInput: string;
  blueprints: BlueprintRecord[];
  historySummary?: string;
}): BlueprintMatch[] {
  const tokens = tokenize([input.userInput, input.historySummary].filter(Boolean).join(' '));

  return input.blueprints
    .filter((blueprint) => blueprint.status === 'active')
    .map((blueprint) => buildMatch(blueprint, tokens))
    .filter((match): match is BlueprintMatch => match !== undefined)
    .sort((left, right) => right.score - left.score || left.blueprint.id.localeCompare(right.blueprint.id));
}

function buildMatch(blueprint: BlueprintRecord, tokens: string[]): BlueprintMatch | undefined {
  if (tokens.length === 0) {
    return undefined;
  }

  let score = 0;
  const reasons: string[] = [];

  for (const pattern of blueprint.trigger.patterns) {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (normalizedPattern.length === 0) {
      continue;
    }

    if (tokens.join(' ').includes(normalizedPattern)) {
      score += 5;
      reasons.push(`pattern overlap: ${pattern}`);
    }
  }

  for (const token of tokens) {
    if (blueprint.tags.some((tag) => tag.toLowerCase().includes(token))) {
      score += 2;
      reasons.push(`tag overlap: ${token}`);
    }

    if (blueprint.title.toLowerCase().includes(token) || blueprint.goal.toLowerCase().includes(token)) {
      score += 1;
      reasons.push(`lexical overlap: ${token}`);
    }
  }

  if (score <= 0) {
    return undefined;
  }

  return {
    blueprint,
    score,
    reasons: [...new Set(reasons)]
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}
