import type { Message } from '../core/types.js';

export interface BuildPromptWithContextInput {
  baseSystemPrompt: string;
  memoryText?: string;
  skillsText?: string;
  historySummary?: string;
  history: Message[];
}

export interface PromptWithContext {
  systemPrompt: string;
  messages: Message[];
}

export function buildPromptWithContext(input: BuildPromptWithContextInput): PromptWithContext {
  const parts = [input.baseSystemPrompt, input.skillsText, input.historySummary].filter(isPresent);
  const systemPrompt = parts.join('\n\n');
  const memoryMessage = isPresent(input.memoryText)
    ? [{ role: 'user', content: input.memoryText } satisfies Message]
    : [];

  return {
    systemPrompt,
    messages: [{ role: 'system', content: systemPrompt }, ...memoryMessage, ...input.history]
  };
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
