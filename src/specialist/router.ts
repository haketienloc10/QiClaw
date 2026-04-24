import { getSpecialistDefinitions } from './registry.js';
import type { SpecialistRouteDecision } from './types.js';

export function routeSpecialist(userInput: string): SpecialistRouteDecision {
  const trimmedInput = userInput.trim();
  if (trimmedInput.length === 0) {
    return { kind: 'main' };
  }

  for (const definition of getSpecialistDefinitions()) {
    if (trimmedInput.toLowerCase().startsWith(definition.slashCommand)) {
      return {
        kind: 'specialist',
        specialist: definition.kind,
        reason: 'explicit',
        matchedRule: definition.slashCommand,
        normalizedInput: trimmedInput.slice(definition.slashCommand.length).trim() || trimmedInput
      };
    }
  }

  const priorityOrderedDefinitions = ['review', 'debug', 'research'].map((kind) =>
    getSpecialistDefinitions().find((definition) => definition.kind === kind)
  ).filter((definition) => definition !== undefined);

  for (const definition of priorityOrderedDefinitions) {
    const matchedPattern = definition.heuristicPatterns.find((pattern) => pattern.test(trimmedInput));
    if (matchedPattern) {
      return {
        kind: 'specialist',
        specialist: definition.kind,
        reason: 'heuristic',
        matchedRule: matchedPattern.source,
        normalizedInput: trimmedInput
      };
    }
  }

  return { kind: 'main' };
}
