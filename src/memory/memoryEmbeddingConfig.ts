export interface MemoryEmbeddingConfig {
  provider: 'ollama';
  model: string;
  baseUrl: string;
}

const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export function resolveMemoryEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): MemoryEmbeddingConfig | undefined {
  const provider = env.QICLAW_MEMORY_PROVIDER?.trim();

  if (!provider) {
    return undefined;
  }

  if (provider !== 'ollama') {
    throw new Error(`Unsupported memory embedding provider: ${provider}`);
  }

  return {
    provider: 'ollama',
    model: env.QICLAW_MEMORY_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
    baseUrl: env.QICLAW_MEMORY_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL
  };
}

export function createMemoryEmbeddingIdentity(config: MemoryEmbeddingConfig, dimension?: number): {
  provider: string;
  model: string;
  dimension?: number;
} {
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof dimension === 'number' ? { dimension } : {})
  };
}
