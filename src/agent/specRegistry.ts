import { defaultAgentSpec } from './defaultAgentSpec.js';
import { readonlyAgentSpec } from './presets/readonlyAgentSpec.js';
import type { AgentSpec } from './spec.js';

const builtinAgentSpecs = {
  default: defaultAgentSpec,
  readonly: readonlyAgentSpec
} satisfies Record<string, AgentSpec>;

export type BuiltinAgentSpecName = keyof typeof builtinAgentSpecs;

export function getBuiltinAgentSpec(name: string): AgentSpec {
  const spec = builtinAgentSpecs[name as BuiltinAgentSpecName];

  if (!spec) {
    throw new Error(`Unknown agent spec: ${name}`);
  }

  return spec;
}

export function getDefaultAgentSpecName(): BuiltinAgentSpecName {
  return 'default';
}

export function listBuiltinAgentSpecNames(): BuiltinAgentSpecName[] {
  return Object.keys(builtinAgentSpecs) as BuiltinAgentSpecName[];
}
