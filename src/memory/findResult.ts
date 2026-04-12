export interface MemoryFindHit {
  id: string;
  doc_id: string;
  score: number;
  uri: string;
  title: string;
  text: string;
  snippet: string;
  track: string;
  kind: string;
  tags: string[];
  timestamp: string;
}

export interface MemoryFindResult {
  query: string;
  engine: string;
  hits: MemoryFindHit[];
  total_hits: number;
  context: string;
  next_cursor: string | null;
  took_ms: number;
}
