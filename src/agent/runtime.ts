import { createProvider } from '../provider/factory.js';
import type { ModelProvider, ResolvedProviderConfig } from '../provider/model.js';
import { createNoopObserver, type TelemetryObserver } from '../telemetry/observer.js';
import { getBuiltinTools, type Tool } from '../tools/registry.js';

import { resolveBuiltinAgentPackage } from './specRegistry.js';
import type { AgentCapabilityClass, ResolvedAgentPackage } from './spec.js';
import { renderAgentSystemPrompt } from './specPrompt.js';

export interface AgentRuntime {
  provider: ModelProvider;
  availableTools: Tool[];
  cwd: string;
  observer: TelemetryObserver;
  resolvedPackage: ResolvedAgentPackage;
  systemPrompt: string;
  maxToolRounds: number;
}

export interface CreateAgentRuntimeOptions extends ResolvedProviderConfig {
  agentSpecName?: string;
  cwd: string;
  observer?: TelemetryObserver;
  resolvedPackage?: ResolvedAgentPackage;
}

const builtinToolNamesByCapabilityClass: Record<AgentCapabilityClass, string[]> = {
  read: ['file', 'shell', 'git', 'web_fetch'],
  write: ['file', 'shell', 'git']
};

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const resolvedPackage = options.resolvedPackage ?? resolveBuiltinAgentPackage(options.agentSpecName ?? 'default');
  const availableTools = filterToolsForSpec(getBuiltinTools(), resolvedPackage);

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
    resolvedPackage,
    systemPrompt: renderAgentSystemPrompt(resolvedPackage),
    maxToolRounds: resolvedPackage.effectivePolicy.maxToolRounds ?? 1
  };
}

function filterToolsForSpec(tools: Tool[], resolvedPackage: ResolvedAgentPackage): Tool[] {
  const allowedCapabilityClasses = resolvedPackage.effectivePolicy.allowedCapabilityClasses ?? [];
  const allowedToolNames = new Set(allowedCapabilityClasses.flatMap((capabilityClass) => builtinToolNamesByCapabilityClass[capabilityClass] ?? []));

  return tools.filter((tool) => allowedToolNames.has(tool.name));
}
