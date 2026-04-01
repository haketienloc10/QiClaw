import { createProvider } from '../provider/factory.js';
import type { ModelProvider, ResolvedProviderConfig } from '../provider/model.js';
import { createNoopObserver, type TelemetryObserver } from '../telemetry/observer.js';
import { getBuiltinTools, type Tool } from '../tools/registry.js';

import { defaultAgentSpec } from './defaultAgentSpec.js';
import { getBuiltinAgentSpec } from './specRegistry.js';
import type { AgentCapabilityClass, AgentSpec } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

export interface AgentRuntime {
  provider: ModelProvider;
  availableTools: Tool[];
  cwd: string;
  observer: TelemetryObserver;
  agentSpec: AgentSpec;
  systemPrompt: string;
  maxToolRounds: number;
}

export interface CreateAgentRuntimeOptions extends ResolvedProviderConfig {
  cwd: string;
  observer?: TelemetryObserver;
  agentSpec?: AgentSpec;
  agentSpecName?: string;
}

const capabilityClassToToolNames: Record<AgentCapabilityClass, string[]> = {
  workspace_read: ['read_file'],
  workspace_write: ['edit_file'],
  workspace_search: ['search'],
  workspace_shell: ['shell']
};

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const agentSpec = options.agentSpec ?? (options.agentSpecName ? getBuiltinAgentSpec(options.agentSpecName) : defaultAgentSpec);
  const availableTools = filterToolsForSpec(getBuiltinTools(), agentSpec);

  return {
    provider: createProvider({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey
    }),
    availableTools,
    cwd: options.cwd,
    observer: options.observer ?? createNoopObserver(),
    agentSpec,
    systemPrompt: renderAgentSystemPrompt(agentSpec),
    maxToolRounds: agentSpec.completion.maxToolRounds
  };
}

function filterToolsForSpec(tools: Tool[], agentSpec: AgentSpec): Tool[] {
  const allowedToolNames = new Set(
    agentSpec.capabilities.allowedCapabilityClasses.flatMap((capabilityClass) => capabilityClassToToolNames[capabilityClass] ?? [])
  );

  return tools.filter((tool) => allowedToolNames.has(tool.name));
}
