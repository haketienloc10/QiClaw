import type { Message } from '../core/types.js';

export interface BuildPromptWithContextInput {
  baseSystemPrompt: string;
  memoryText?: string;
  blueprintText?: string;
  skillsText?: string;
  historySummary?: string;
  includeMemory?: boolean;
  includeBlueprints?: boolean;
  includeSkills?: boolean;
  includeHistorySummary?: boolean;
  history: Message[];
}

export interface PromptWithContext {
  systemPrompt: string;
  messages: Message[];
}

export function buildPromptWithContext(input: BuildPromptWithContextInput): PromptWithContext {
  const parts = [
    input.baseSystemPrompt,
    input.includeSkills === false ? undefined : input.skillsText,
    input.includeHistorySummary === false ? undefined : input.historySummary
  ].filter(isPresent);
  const systemPrompt = parts.join('\n\n');
  const memoryMessage = input.includeMemory === false || !isPresent(input.memoryText)
    ? []
    : [{ role: 'user', content: input.memoryText } satisfies Message];
  const blueprintMessage = input.includeBlueprints === false || !isPresent(input.blueprintText)
    ? []
    : [{ role: 'user', content: input.blueprintText } satisfies Message];

  return {
    systemPrompt,
    messages: [{ role: 'system', content: systemPrompt }, ...memoryMessage, ...blueprintMessage, ...input.history]
  };
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
