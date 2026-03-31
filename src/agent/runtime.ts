import { createProvider } from '../provider/factory.js';
import type { ModelProvider, ResolvedProviderConfig } from '../provider/model.js';
import { createNoopObserver, type TelemetryObserver } from '../telemetry/observer.js';
import { getBuiltinTools, type Tool } from '../tools/registry.js';

export interface AgentRuntime {
  provider: ModelProvider;
  availableTools: Tool[];
  cwd: string;
  observer: TelemetryObserver;
}

export interface CreateAgentRuntimeOptions extends ResolvedProviderConfig {
  cwd: string;
  observer?: TelemetryObserver;
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  return {
    provider: createProvider({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey
    }),
    availableTools: getBuiltinTools(),
    cwd: options.cwd,
    observer: options.observer ?? createNoopObserver()
  };
}
