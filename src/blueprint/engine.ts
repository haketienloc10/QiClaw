import type { RunAgentTurnResult } from '../agent/loop.js';
import { matchBlueprints } from './matcher.js';
import { applyBlueprintOutcome, deriveBlueprintOutcome } from './outcome.js';
import { renderBlueprintContext } from './render.js';
import { BlueprintStore } from './store.js';
import type { PersistedBlueprintRecord } from './types.js';

const DEFAULT_BLUEPRINT_CONTEXT_BUDGET_CHARS = 2_000;

export interface PrepareInteractiveBlueprintContextInput {
  userInput: string;
  historySummary?: string;
  budgetChars?: number;
}

export interface PrepareInteractiveBlueprintContextResult {
  blueprintText: string;
  matchedBlueprint?: PersistedBlueprintRecord;
}

export interface CaptureInteractiveBlueprintOutcomeInput {
  matchedBlueprint?: PersistedBlueprintRecord;
  result: RunAgentTurnResult;
  now?: string;
}

export async function prepareInteractiveBlueprintContext(
  input: PrepareInteractiveBlueprintContextInput
): Promise<PrepareInteractiveBlueprintContextResult> {
  const store = new BlueprintStore();
  await store.open();

  const matches = matchBlueprints({
    userInput: input.userInput,
    historySummary: input.historySummary,
    blueprints: await store.listActive()
  });
  const [topMatch] = matches;

  if (!topMatch) {
    return { blueprintText: '' };
  }

  return {
    blueprintText: renderBlueprintContext({
      matches: [topMatch],
      budgetChars: input.budgetChars ?? DEFAULT_BLUEPRINT_CONTEXT_BUDGET_CHARS
    }),
    matchedBlueprint: topMatch.blueprint as PersistedBlueprintRecord
  };
}

export async function captureInteractiveBlueprintOutcome(
  input: CaptureInteractiveBlueprintOutcomeInput
): Promise<void> {
  if (!input.matchedBlueprint) {
    return;
  }

  const store = new BlueprintStore();
  await store.open();

  const persistedBlueprint = await store.getById(input.matchedBlueprint.id);
  if (!persistedBlueprint) {
    return;
  }

  const updatedBlueprint = applyBlueprintOutcome({
    blueprint: persistedBlueprint,
    outcome: deriveBlueprintOutcome(input.result),
    now: input.now
  });

  await store.put(updatedBlueprint);
}
