import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentPackage } from '../../src/agent/spec.js';

const mockedDefaultResolvedPackage: ResolvedAgentPackage = {
  preset: 'default',
  sourceTier: 'builtin',
  extendsChain: ['default'],
  packageChain: [],
  effectivePolicy: {
    allowedCapabilityClasses: ['read', 'search'],
    maxToolRounds: 2,
    mutationMode: 'none'
  },
  effectiveCompletion: {
    completionMode: 'Single-turn task completion.',
    doneCriteriaShape: 'Return an answer.',
    evidenceRequirement: 'Use direct evidence when needed.',
    stopVsDoneDistinction: 'A provider stop is not enough.'
  },
  effectivePromptOrder: ['AGENT.md'],
  effectivePromptFiles: {
    'AGENT.md': {
      filePath: '/builtin/default/AGENT.md',
      content: 'Purpose: Default runtime\nScope boundary: Default runtime'
    }
  },
  resolvedFiles: ['/builtin/default/agent.json', '/builtin/default/AGENT.md']
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../src/agent/specRegistry.js');
});

describe('createAgentRuntime', () => {
  it('resolves the named builtin package directly when no resolved package is provided', async () => {
    const resolveBuiltinAgentPackage = vi.fn(() => mockedDefaultResolvedPackage);
    vi.doMock('../../src/agent/specRegistry.js', () => ({
      resolveBuiltinAgentPackage
    }));

    const { createAgentRuntime } = await import('../../src/agent/runtime.js');
    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-default',
      agentSpecName: 'readonly'
    });

    expect(resolveBuiltinAgentPackage).toHaveBeenCalledWith('readonly');
    expect(runtime.resolvedPackage).toBe(mockedDefaultResolvedPackage);
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'search']);
    expect(runtime.maxToolRounds).toBe(2);
  });

  it('builds from a provided resolved package without agent spec metadata', async () => {
    const { resolveBuiltinAgentPackage } = await import('../../src/agent/specRegistry.js');
    const { createAgentRuntime } = await import('../../src/agent/runtime.js');
    const resolvedPackage = resolveBuiltinAgentPackage('readonly');

    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-readonly',
      resolvedPackage
    });

    expect(runtime.cwd).toBe('/tmp/runtime-readonly');
    expect(runtime.resolvedPackage).toBe(resolvedPackage);
    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['read_file', 'search', 'shell_readonly']);
    expect(runtime.maxToolRounds).toBe(6);
  });
});
