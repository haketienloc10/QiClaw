import type { MemoryEmbeddingConfig } from './memoryEmbeddingConfig.js';

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

const embeddingCache = new Map<string, number[][]>();

export function resetEmbeddingCache(): void {
  embeddingCache.clear();
}

export async function embedTexts(
  memoryConfig: MemoryEmbeddingConfig,
  input: string | string[]
): Promise<number[][]> {
  const cacheKey = buildCacheKey(memoryConfig, input);
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    return cached.map((embedding) => [...embedding]);
  }

  const response = await fetch(new URL('/api/embed', ensureTrailingSlash(memoryConfig.baseUrl)), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: memoryConfig.model,
      input
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama embed request failed with status ${response.status}`);
  }

  const payload = await response.json() as OllamaEmbedResponse;
  if (!Array.isArray(payload.embeddings)) {
    throw new Error('Ollama embed response missing embeddings');
  }

  const embeddings = payload.embeddings.map((embedding) => {
    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number')) {
      throw new Error('Ollama embed response returned invalid embedding values');
    }

    return [...embedding];
  });

  embeddingCache.set(cacheKey, embeddings.map((embedding) => [...embedding]));
  return embeddings;
}

function buildCacheKey(memoryConfig: MemoryEmbeddingConfig, input: string | string[]): string {
  return JSON.stringify({
    baseUrl: memoryConfig.baseUrl,
    model: memoryConfig.model,
    input
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
