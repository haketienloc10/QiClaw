import { describe, expect, it } from 'vitest';

import { renderAgentSystemPrompt } from '../../src/agent/specPrompt.js';
import type { ResolvedAgentPackage } from '../../src/agent/spec.js';

const resolvedPackage: ResolvedAgentPackage = {
  preset: 'demo',
  sourceTier: 'builtin',
  extendsChain: ['demo'],
  packageChain: [],
  effectivePolicy: {
    allowedCapabilityClasses: ['read'],
    maxToolRounds: 1,
    mutationMode: 'none'
  },
  effectiveCompletion: undefined,
  effectiveDiagnostics: undefined,
  effectivePromptFiles: {
    'base.md': {
      filePath: '/tmp/base.md',
      content: '# Base'
    },
    'repo.md': {
      filePath: '/tmp/repo.md',
      content: '# Repo'
    }
  },
  effectivePromptOrder: ['base.md', 'repo.md'],
  resolvedFiles: ['/tmp/base.md', '/tmp/repo.md']
};

describe('renderAgentSystemPrompt', () => {
  it('renders prompt file contents strictly in effective prompt order before runtime constraints', () => {
    const rendered = renderAgentSystemPrompt(resolvedPackage);

    expect(rendered).not.toContain('base.md');
    expect(rendered).not.toContain('repo.md');
    expect(rendered).toContain('# Base\n\n# Repo');

    const baseIndex = rendered.indexOf('# Base');
    const repoIndex = rendered.indexOf('# Repo');
    const constraintsIndex = rendered.indexOf('Runtime constraints summary');

    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(repoIndex).toBeGreaterThan(baseIndex);
    expect(constraintsIndex).toBeGreaterThan(repoIndex);
  });
});
