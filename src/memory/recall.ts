import type { MemoryKind, MemoryRecord } from './memoryTypes.js';

const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'Fact',
  procedure: 'Procedure',
  failure: 'Failure'
};

const COMPACT_MEMORY_MAX_BUDGET_CHARS = 120;

export interface RenderRecalledMemoriesOptions {
  budgetChars?: number;
}

export function shouldUseCompactMemoryRendering(compactText: string, budgetChars: number): boolean {
  return budgetChars <= COMPACT_MEMORY_MAX_BUDGET_CHARS && compactText.length <= budgetChars;
}

export function renderRecalledMemories(memories: MemoryRecord[], options: RenderRecalledMemoriesOptions = {}): string {
  if (memories.length === 0) {
    return '';
  }

  const lines = memories.map((memory) => `- ${MEMORY_KIND_LABELS[memory.kind]}: ${memory.content}`);
  const compactText = ['Mem:', ...lines].join('\n');
  const budgetChars = options.budgetChars ?? Number.POSITIVE_INFINITY;

  if (shouldUseCompactMemoryRendering(compactText, budgetChars)) {
    return compactText;
  }

  return ['Memory:', ...lines].join('\n');
}
