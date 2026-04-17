import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentPackage } from '../../src/agent/packageResolver.js';
import { validateResolvedAgentPackage } from '../../src/agent/packageValidator.js';

import { copyFixtureTree, writePackageFixture } from './packageTestUtils.js';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agent-packages');
const sharedQiclawPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'agent', 'shared', 'QICLAW.md');

describe('packageResolver', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('prefers project packages over user and builtin packages, then merges inheritance by prompt file name and policy', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    const homeDirectory = join(tempDir, 'home');
    const builtinPackagesDirectory = join(tempDir, 'builtin-packages');
    await mkdir(cwd, { recursive: true });

    await copyFixtureTree(join(fixtureRoot, 'project', 'reviewer'), join(cwd, '.qiclaw', 'agents', 'reviewer'));
    await copyFixtureTree(join(fixtureRoot, 'user', 'reviewer'), join(homeDirectory, '.qiclaw', 'agents', 'reviewer'));
    await copyFixtureTree(join(fixtureRoot, 'builtin', 'readonly'), join(builtinPackagesDirectory, 'readonly'));

    await expect(resolveAgentPackage('reviewer', { cwd, homeDirectory, builtinPackagesDirectory })).resolves.toMatchObject({
      preset: 'reviewer',
      sourceTier: 'project',
      extendsChain: ['reviewer', 'readonly'],
      effectivePolicy: {
        allowedCapabilityClasses: ['read'],
        maxToolRounds: 4,
        mutationMode: 'none',
        includeSkills: true,
        includeMemory: true
      },
      effectiveCompletion: {
        completionMode: 'runtime-policy',
        doneCriteriaShape: 'checklist-driven',
        evidenceRequirement: 'explicit',
        stopVsDoneDistinction: 'done-vs-stop'
      },
      effectivePromptFiles: {
        'QICLAW.md': {
          filePath: sharedQiclawPath,
          content: '# QICLAW.md\n\nHãy ưu tiên các quy tắc và dữ kiện đặc thù của QiClaw trước các hướng dẫn prompt chung khác khi chúng cùng áp dụng.\n'
        },
        'AGENT.md': {
          content: 'Project reviewer override\n'
        },
        'SOUL.md': {
          content: 'Builtin soul\n'
        },
        'STYLE.md': {
          content: 'Project style\n'
        }
      }
    });

    const resolved = await resolveAgentPackage('reviewer', { cwd, homeDirectory, builtinPackagesDirectory });
    expect(resolved.effectivePromptOrder).toEqual(['QICLAW.md', 'AGENT.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'STYLE.md']);
    expect(resolved.resolvedFiles).toEqual([
      sharedQiclawPath,
      join(cwd, '.qiclaw', 'agents', 'reviewer', 'agent.json'),
      join(cwd, '.qiclaw', 'agents', 'reviewer', 'AGENT.md'),
      join(cwd, '.qiclaw', 'agents', 'reviewer', 'STYLE.md'),
      join(cwd, '.qiclaw', 'agents', 'reviewer', 'TOOLS.md'),
      join(cwd, '.qiclaw', 'agents', 'reviewer', 'USER.md'),
      join(builtinPackagesDirectory, 'readonly', 'agent.json'),
      join(builtinPackagesDirectory, 'readonly', 'AGENT.md'),
      join(builtinPackagesDirectory, 'readonly', 'SOUL.md'),
      join(builtinPackagesDirectory, 'readonly', 'TOOLS.md'),
      join(builtinPackagesDirectory, 'readonly', 'USER.md')
    ]);
  });

  it('resolves USER.md from the user package when no project package overrides it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    const homeDirectory = join(tempDir, 'home');
    const builtinPackagesDirectory = join(tempDir, 'builtin-packages');
    await mkdir(cwd, { recursive: true });

    await copyFixtureTree(join(fixtureRoot, 'user', 'reviewer'), join(homeDirectory, '.qiclaw', 'agents', 'reviewer'));
    await copyFixtureTree(join(fixtureRoot, 'builtin', 'readonly'), join(builtinPackagesDirectory, 'readonly'));

    const resolved = await resolveAgentPackage('reviewer', { cwd, homeDirectory, builtinPackagesDirectory });

    expect(resolved.sourceTier).toBe('user');
    expect(resolved.effectivePromptFiles['USER.md']).toMatchObject({
      filePath: join(homeDirectory, '.qiclaw', 'agents', 'reviewer', 'USER.md'),
      content: 'Base reviewer user instructions\n'
    });
  });

  it('uses manifest promptFiles order by appending child entries after parent entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    const builtinPackagesDirectory = join(tempDir, 'builtin-packages');
    await mkdir(cwd, { recursive: true });

    await writePackageFixture(join(builtinPackagesDirectory, 'base'), {
      manifest: {
        promptFiles: ['SOUL.md', 'AGENT.md']
      },
      sections: {
        'AGENT.md': 'Base agent\n',
        'SOUL.md': 'Base soul\n',
        'USER.md': 'Base user\n'
      }
    });
    await writePackageFixture(join(cwd, '.qiclaw', 'agents', 'child'), {
      manifest: {
        extends: 'base',
        promptFiles: ['STYLE.md', 'AGENT.md']
      },
      sections: {
        'AGENT.md': 'Child agent\n',
        'STYLE.md': 'Child style\n'
      }
    });

    const resolved = await resolveAgentPackage('child', { cwd, homeDirectory: join(tempDir, 'home'), builtinPackagesDirectory });

    expect(resolved.effectivePromptOrder).toEqual(['QICLAW.md', 'SOUL.md', 'AGENT.md', 'STYLE.md']);
    expect(resolved.effectivePromptFiles).toMatchObject({
      'SOUL.md': {
        filePath: join(builtinPackagesDirectory, 'base', 'SOUL.md'),
        content: 'Base soul\n'
      },
      'AGENT.md': {
        filePath: join(cwd, '.qiclaw', 'agents', 'child', 'AGENT.md'),
        content: 'Child agent\n'
      },
      'STYLE.md': {
        filePath: join(cwd, '.qiclaw', 'agents', 'child', 'STYLE.md'),
        content: 'Child style\n'
      }
    });
  });

  it('prepends shared QICLAW.md for package chains and keeps the shared path stable in resolvedFiles', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    const homeDirectory = join(tempDir, 'home');
    const builtinPackagesDirectory = join(tempDir, 'builtin-packages');
    await mkdir(cwd, { recursive: true });

    await writePackageFixture(join(builtinPackagesDirectory, 'base'), {
      manifest: {
        promptFiles: ['SOUL.md', 'AGENT.md']
      },
      sections: {
        'AGENT.md': 'Base agent\n',
        'SOUL.md': 'Base soul\n'
      }
    });
    await writePackageFixture(join(homeDirectory, '.qiclaw', 'agents', 'reviewer-base'), {
      manifest: {
        extends: 'base',
        promptFiles: ['USER.md']
      },
      sections: {
        'USER.md': 'User reviewer instructions\n'
      }
    });
    await writePackageFixture(join(cwd, '.qiclaw', 'agents', 'reviewer'), {
      manifest: {
        extends: 'reviewer-base',
        promptFiles: ['STYLE.md']
      },
      sections: {
        'STYLE.md': 'Project reviewer style\n'
      }
    });

    const resolved = await resolveAgentPackage('reviewer', { cwd, homeDirectory, builtinPackagesDirectory });
    const sharedQiclawPaths = resolved.resolvedFiles.filter((filePath) => filePath === sharedQiclawPath);

    expect(resolved.effectivePromptOrder).toEqual(['QICLAW.md', 'SOUL.md', 'AGENT.md', 'USER.md', 'STYLE.md']);
    expect(resolved.effectivePromptFiles['QICLAW.md']).toMatchObject({
      filePath: sharedQiclawPath,
      content: '# QICLAW.md\n\nHãy ưu tiên các quy tắc và dữ kiện đặc thù của QiClaw trước các hướng dẫn prompt chung khác khi chúng cùng áp dụng.\n'
    });
    expect(sharedQiclawPaths).toEqual([sharedQiclawPath]);
  });

  it('fails when a base package manifest does not declare any prompt files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    await mkdir(cwd, { recursive: true });

    await writePackageFixture(join(cwd, '.qiclaw', 'agents', 'reviewer'), {
      manifest: {
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      sections: {
        'AGENT.md': 'Base agent\n',
        'USER.md': 'Base user\n'
      }
    });

    await expect(resolveAgentPackage('reviewer', { cwd, homeDirectory: join(tempDir, 'home'), builtinPackagesDirectory: join(tempDir, 'builtin-packages') })).rejects.toThrow(
      'Base package "reviewer" must declare at least one prompt file in agent.json.'
    );
  });

  it('fails when a manifest references a prompt file that does not exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    await mkdir(cwd, { recursive: true });

    await writePackageFixture(join(cwd, '.qiclaw', 'agents', 'reviewer'), {
      manifest: {
        promptFiles: ['AGENT.md', 'MISSING.md'],
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      sections: {
        'AGENT.md': 'Base agent\n',
        'USER.md': 'Base user\n'
      }
    });

    await expect(resolveAgentPackage('reviewer', { cwd, homeDirectory: join(tempDir, 'home'), builtinPackagesDirectory: join(tempDir, 'builtin-packages') })).rejects.toThrow(
      'Agent package "reviewer" references missing prompt file "MISSING.md" in agent.json.'
    );
  });

  it('fails when a package directory defines QICLAW.md instead of using the shared prompt file', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    await mkdir(cwd, { recursive: true });

    await writePackageFixture(join(cwd, '.qiclaw', 'agents', 'reviewer'), {
      manifest: {
        promptFiles: ['AGENT.md'],
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      sections: {
        'AGENT.md': 'Base agent\n',
        'QICLAW.md': 'Package-local qiclaw\n'
      }
    });

    await expect(resolveAgentPackage('reviewer', { cwd, homeDirectory: join(tempDir, 'home'), builtinPackagesDirectory: join(tempDir, 'builtin-packages') })).rejects.toThrow(
      'Agent package "reviewer" must not define reserved shared prompt file "QICLAW.md" inside the package directory.'
    );
  });

  it('fails resolved validation when effective prompt order is empty or references a missing effective prompt file', () => {
    expect(
      validateResolvedAgentPackage({
        preset: 'reviewer',
        sourceTier: 'project',
        extendsChain: ['reviewer'],
        packageChain: [],
        effectivePolicy: {},
        effectiveCompletion: undefined,
        effectiveDiagnostics: undefined,
        effectivePromptOrder: [],
        effectivePromptFiles: {},
        resolvedFiles: []
      })
    ).toContain('Agent package "reviewer" must resolve at least one prompt file.');

    expect(
      validateResolvedAgentPackage({
        preset: 'reviewer',
        sourceTier: 'project',
        extendsChain: ['reviewer'],
        packageChain: [],
        effectivePolicy: {},
        effectiveCompletion: undefined,
        effectiveDiagnostics: undefined,
        effectivePromptOrder: ['AGENT.md'],
        effectivePromptFiles: {},
        resolvedFiles: []
      })
    ).toContain('Agent package "reviewer" resolved prompt order references missing prompt file "AGENT.md".');

    expect(
      validateResolvedAgentPackage({
        preset: 'reviewer',
        sourceTier: 'project',
        extendsChain: ['reviewer'],
        packageChain: [],
        effectivePolicy: {},
        effectiveCompletion: undefined,
        effectiveDiagnostics: undefined,
        effectivePromptOrder: ['AGENT.md', 'QICLAW.md'],
        effectivePromptFiles: {
          'AGENT.md': {
            filePath: '/tmp/AGENT.md',
            content: 'Agent\n'
          },
          'QICLAW.md': {
            filePath: '/tmp/QICLAW.md',
            content: 'Qiclaw\n'
          }
        },
        resolvedFiles: ['/tmp/AGENT.md', '/tmp/QICLAW.md']
      })
    ).toContain('Agent package "reviewer" must place "QICLAW.md" first in resolved prompt order when the shared prompt file is present.');
  });

  it('fails when an extends target cannot be resolved from any source tier', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    await mkdir(cwd, { recursive: true });

    await copyFixtureTree(join(fixtureRoot, 'project', 'missing-base'), join(cwd, '.qiclaw', 'agents', 'reviewer'));

    await expect(resolveAgentPackage('reviewer', { cwd, homeDirectory: join(tempDir, 'home'), builtinPackagesDirectory: join(tempDir, 'builtin-packages') })).rejects.toThrow(
      'Agent package "reviewer" extends unknown package "ghost-base".'
    );
  });

  it('fails when extends introduces a cycle', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-resolver-'));
    tempDirs.push(tempDir);

    const cwd = join(tempDir, 'workspace');
    await mkdir(cwd, { recursive: true });

    await copyFixtureTree(join(fixtureRoot, 'project', 'cycle-alpha'), join(cwd, '.qiclaw', 'agents', 'cycle-alpha'));
    await copyFixtureTree(join(fixtureRoot, 'project', 'cycle-beta'), join(cwd, '.qiclaw', 'agents', 'cycle-beta'));

    await expect(resolveAgentPackage('cycle-alpha', { cwd, homeDirectory: join(tempDir, 'home'), builtinPackagesDirectory: join(tempDir, 'builtin-packages') })).rejects.toThrow(
      'Detected agent package extends cycle: cycle-alpha -> cycle-beta -> cycle-alpha'
    );
  });
});
