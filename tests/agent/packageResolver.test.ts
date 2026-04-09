import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentPackage } from '../../src/agent/packageResolver.js';

import { copyFixtureTree } from './packageTestUtils.js';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agent-packages');

describe('packageResolver', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('prefers project packages over user and builtin packages, then merges inheritance by slot and policy', async () => {
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
    expect(resolved.resolvedFiles).toEqual([
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
