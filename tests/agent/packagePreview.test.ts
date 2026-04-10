import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { createAgentPackagePreview } from '../../src/agent/packagePreview.js';
import { resolveBuiltinAgentPackage } from '../../src/agent/specRegistry.js';
import type { ResolvedAgentPackage } from '../../src/agent/spec.js';
import { renderAgentSystemPrompt } from '../../src/agent/specPrompt.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const resolvedPackage: ResolvedAgentPackage = {
  preset: 'reviewer',
  sourceTier: 'project',
  extendsChain: ['reviewer', 'readonly'],
  packageChain: [
    {
      preset: 'reviewer',
      sourceTier: 'project',
      directoryPath: '/workspace/.qiclaw/agents/reviewer',
      manifestPath: '/workspace/.qiclaw/agents/reviewer/agent.json',
      manifest: {
        extends: 'readonly',
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 4,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': {
          filePath: '/workspace/.qiclaw/agents/reviewer/AGENT.md',
          content: 'Project reviewer override'
        },
        'STYLE.md': {
          filePath: '/workspace/.qiclaw/agents/reviewer/STYLE.md',
          content: 'Project style'
        },
        'USER.md': {
          filePath: '/workspace/.qiclaw/agents/reviewer/USER.md',
          content: 'Project user instructions'
        }
      }
    },
    {
      preset: 'readonly',
      sourceTier: 'builtin',
      directoryPath: '/builtin/readonly',
      manifestPath: '/builtin/readonly/agent.json',
      manifest: {
        policy: {
          allowedCapabilityClasses: ['read', 'search'],
          maxToolRounds: 6,
          mutationMode: 'none',
          includeSkills: true
        }
      },
      promptFiles: {
        'SOUL.md': {
          filePath: '/builtin/readonly/SOUL.md',
          content: 'Builtin soul'
        },
        'TOOLS.md': {
          filePath: '/builtin/readonly/TOOLS.md',
          content: 'Builtin tools'
        }
      }
    }
  ],
  effectivePolicy: {
    allowedCapabilityClasses: ['read'],
    maxToolRounds: 4,
    mutationMode: 'none',
    includeSkills: true
  },
  effectivePromptFiles: {
    'AGENT.md': {
      filePath: '/workspace/.qiclaw/agents/reviewer/AGENT.md',
      content: 'Project reviewer override'
    },
    'SOUL.md': {
      filePath: '/builtin/readonly/SOUL.md',
      content: 'Builtin soul'
    },
    'STYLE.md': {
      filePath: '/workspace/.qiclaw/agents/reviewer/STYLE.md',
      content: 'Project style'
    },
    'TOOLS.md': {
      filePath: '/builtin/readonly/TOOLS.md',
      content: 'Builtin tools'
    },
    'USER.md': {
      filePath: '/workspace/.qiclaw/agents/reviewer/USER.md',
      content: 'Project user instructions'
    }
  },
  resolvedFiles: [
    '/workspace/.qiclaw/agents/reviewer/agent.json',
    '/workspace/.qiclaw/agents/reviewer/AGENT.md',
    '/workspace/.qiclaw/agents/reviewer/STYLE.md',
    '/workspace/.qiclaw/agents/reviewer/USER.md',
    '/builtin/readonly/agent.json',
    '/builtin/readonly/SOUL.md',
    '/builtin/readonly/TOOLS.md'
  ]
};

describe('packagePreview', () => {
  it('returns the preview model with the runtime-rendered prompt and section file sources', () => {
    expect(createAgentPackagePreview(resolvedPackage)).toEqual({
      preset: 'reviewer',
      sourceTier: 'project',
      extendsChain: ['reviewer', 'readonly'],
      promptFiles: [
        {
          fileName: 'AGENT.md',
          filePath: '/workspace/.qiclaw/agents/reviewer/AGENT.md'
        },
        {
          fileName: 'STYLE.md',
          filePath: '/workspace/.qiclaw/agents/reviewer/STYLE.md'
        },
        {
          fileName: 'USER.md',
          filePath: '/workspace/.qiclaw/agents/reviewer/USER.md'
        },
        {
          fileName: 'SOUL.md',
          filePath: '/builtin/readonly/SOUL.md'
        },
        {
          fileName: 'TOOLS.md',
          filePath: '/builtin/readonly/TOOLS.md'
        }
      ],
      resolvedFiles: [
        '/workspace/.qiclaw/agents/reviewer/agent.json',
        '/workspace/.qiclaw/agents/reviewer/AGENT.md',
        '/workspace/.qiclaw/agents/reviewer/STYLE.md',
        '/workspace/.qiclaw/agents/reviewer/USER.md',
        '/builtin/readonly/agent.json',
        '/builtin/readonly/SOUL.md',
        '/builtin/readonly/TOOLS.md'
      ],
      effectiveRuntimePolicy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 4,
        mutationMode: 'none',
        includeSkills: true
      },
      renderedPromptText: renderAgentSystemPrompt(resolvedPackage)
    });
  });

  it('includes the same runtime-rendered sections and constraints summary as production in explicit render order', () => {
    const renderedPromptText = createAgentPackagePreview(resolvedPackage).renderedPromptText;

    const agentIndex = renderedPromptText.indexOf('AGENT.md\nProject reviewer override');
    const soulIndex = renderedPromptText.indexOf('SOUL.md\nBuiltin soul');
    const styleIndex = renderedPromptText.indexOf('STYLE.md\nProject style');
    const toolsIndex = renderedPromptText.indexOf('TOOLS.md\nBuiltin tools');
    const userIndex = renderedPromptText.indexOf('USER.md\nProject user instructions');
    const constraintsIndex = renderedPromptText.indexOf('Runtime constraints summary');

    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(soulIndex).toBeGreaterThan(agentIndex);
    expect(styleIndex).toBeGreaterThan(soulIndex);
    expect(toolsIndex).toBeGreaterThan(styleIndex);
    expect(userIndex).toBeGreaterThan(toolsIndex);
    expect(constraintsIndex).toBeGreaterThan(userIndex);
    expect(renderedPromptText).toContain('- Allowed capability classes: read');
    expect(renderedPromptText).toContain('- Max tool rounds: 4');
    expect(renderedPromptText).toContain('- Mutation mode: none');
  });

  it('renders builtin previews from resolved package sections and runtime policy instead of legacy bridge prose', () => {
    const resolved = resolveBuiltinAgentPackage('default');
    const preview = createAgentPackagePreview(resolved);

    expect(resolved.resolvedFiles.some((filePath) => filePath.includes('/src/agent/builtin-packages/default/agent.json'))).toBe(true);
    expect(resolved.resolvedFiles.some((filePath) => filePath.includes('/src/agent/builtin-packages/default/AGENT.md'))).toBe(true);
    expect(preview.effectiveRuntimePolicy.allowedCapabilityClasses).toEqual(['read', 'write']);
    expect(preview.effectiveRuntimePolicy.maxToolRounds).toBe(10);
    expect(preview.effectiveRuntimePolicy.mutationMode).toBe('workspace-write');
    expect(preview.renderedPromptText).toContain('Runtime constraints summary');
    expect(preview.renderedPromptText).toContain('- Allowed capability classes: read, write');
    expect(preview.renderedPromptText).toContain('- Max tool rounds: 10');
    expect(preview.renderedPromptText).toContain('- Mutation mode: workspace-write');
    expect(preview.renderedPromptText).not.toContain('CHECKLIST.md');
    expect(preview.renderedPromptText).not.toContain('Completion mode:');
  });

  it('resolves the readonly builtin package from disk and keeps the extends bridge through default', () => {
    const resolved = resolveBuiltinAgentPackage('readonly');

    expect(resolved.extendsChain).toEqual(['readonly', 'default']);
    expect(resolved.resolvedFiles.some((filePath) => filePath.includes('/src/agent/builtin-packages/readonly/agent.json'))).toBe(true);
    expect(resolved.resolvedFiles.some((filePath) => filePath.includes('/src/agent/builtin-packages/default/AGENT.md'))).toBe(true);
    expect(resolved.effectivePromptFiles['AGENT.md']?.filePath).toContain('/src/agent/builtin-packages/readonly/AGENT.md');
    expect(resolved.effectivePromptFiles['USER.md']?.filePath).toContain('/src/agent/builtin-packages/readonly/USER.md');
  });

  it('resolves builtin package assets from dist output when loading the built registry module', async () => {
    await execa('npm', ['run', 'build'], { cwd: workspaceRoot });

    const builtRegistryModuleUrl = pathToFileURL(resolve(workspaceRoot, 'dist', 'agent', 'specRegistry.js')).href;
    const { resolveBuiltinAgentPackage: resolveBuiltBuiltinAgentPackage } = await import(builtRegistryModuleUrl);

    const resolved = resolveBuiltBuiltinAgentPackage('readonly');

    expect(resolved.extendsChain).toEqual(['readonly', 'default']);
    expect(resolved.resolvedFiles.some((filePath: string) => filePath.includes('/dist/agent/builtin-packages/readonly/agent.json'))).toBe(true);
    expect(resolved.resolvedFiles.some((filePath: string) => filePath.includes('/dist/agent/builtin-packages/default/AGENT.md'))).toBe(true);
    expect(resolved.effectivePromptFiles['AGENT.md']?.filePath).toContain('/dist/agent/builtin-packages/readonly/AGENT.md');
    expect(resolved.effectivePromptFiles['TOOLS.md']?.filePath).toContain('/dist/agent/builtin-packages/readonly/TOOLS.md');
  }, 15000);
});
