import type { BlueprintMatch } from './types.js';

export function renderBlueprintContext(input: {
  matches: BlueprintMatch[];
  budgetChars: number;
}): string {
  if (input.matches.length === 0 || input.budgetChars <= 0) {
    return '';
  }

  const [topMatch] = input.matches;
  const blueprint = topMatch.blueprint;
  const lines = [
    'Blueprint:',
    `- Title: ${blueprint.title}`,
    `- Goal: ${blueprint.goal}`
  ];

  if (blueprint.steps.length > 0) {
    lines.push('- Steps:');
    for (const [index, step] of blueprint.steps.entries()) {
      lines.push(`  ${index + 1}. ${step.title} — ${step.instruction}`);
    }
  }

  if (blueprint.expectedEvidence.length > 0) {
    lines.push('- Evidence:');
    for (const evidence of blueprint.expectedEvidence) {
      lines.push(`  - ${evidence.description}`);
    }
  }

  if (blueprint.failureModes.length > 0) {
    lines.push('- Failure modes:');
    for (const failureMode of blueprint.failureModes) {
      lines.push(`  - ${failureMode.title}${failureMode.mitigation ? ` — ${failureMode.mitigation}` : ''}`);
    }
  }

  const rendered = `${lines.join('\n')}\n`;
  return rendered.length <= input.budgetChars ? rendered : `${rendered.slice(0, Math.max(0, input.budgetChars - 1)).trimEnd()}…`;
}
