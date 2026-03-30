export type MemoryKind = 'fact' | 'procedure' | 'failure';

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  content: string;
  source: string;
  createdAt: string;
}

export interface SaveMemoryInput {
  kind: MemoryKind;
  content: string;
  source: string;
  createdAt?: string;
}
