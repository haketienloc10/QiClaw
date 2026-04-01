import type { MemoryKind, MemoryRecord } from './memoryTypes.js';

const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'Fact',
  procedure: 'Procedure',
  failure: 'Failure'
};

export function renderRecalledMemories(memories: MemoryRecord[]): string {
  if (memories.length === 0) {
    return '';
  }

  return [
    'Memory:',
    ...memories.map((memory) => `- ${MEMORY_KIND_LABELS[memory.kind]}: ${memory.content} (source: ${memory.source})`)
  ].join('\n');
}
