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

export interface ToolAccessPolicy {
  allowedCapabilityClasses?: AgentCapabilityClass[];
  allowedToolNames?: string[];
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const resolvedPackage = options.resolvedPackage ?? resolveBuiltinAgentPackage(options.agentSpecName ?? 'default');
  const availableTools = filterToolsByPolicy(getBuiltinTools(), {
    allowedCapabilityClasses: resolvedPackage.effectivePolicy.allowedCapabilityClasses
  });

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

export function filterToolsByPolicy(tools: Tool[], policy: ToolAccessPolicy): Tool[] {
  const allowedCapabilityClasses = policy.allowedCapabilityClasses ?? [];
  const allowedToolNames = new Set([
    ...allowedCapabilityClasses.flatMap((capabilityClass) => builtinToolNamesByCapabilityClass[capabilityClass] ?? []),
    ...(policy.allowedToolNames ?? [])
  ]);

  return tools.filter((tool) => allowedToolNames.has(tool.name));
}

