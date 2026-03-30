import { createAnthropicProvider } from '../provider/anthropic.js';
import type { ModelProvider } from '../provider/model.js';
import { createNoopObserver, type TelemetryObserver } from '../telemetry/observer.js';
import { getBuiltinTools, type Tool } from '../tools/registry.js';

export interface AgentRuntime {
  provider: ModelProvider;
  availableTools: Tool[];
  cwd: string;
  observer: TelemetryObserver;
}

export interface CreateAgentRuntimeOptions {
  model: string;
  cwd: string;
  observer?: TelemetryObserver;
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  return {
    provider: createAnthropicProvider({ model: options.model }),
    availableTools: getBuiltinTools(),
    cwd: options.cwd,
    observer: options.observer ?? createNoopObserver()
  };
}
