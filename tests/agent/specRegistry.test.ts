import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentPackageManifest, AgentPromptFileName } from '../../src/agent/spec.js';

interface BuiltinFixtureInput {
  manifest: AgentPackageManifest;
  promptFiles?: Partial<Record<AgentPromptFileName, string>>;
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../../src/agent/packagePaths.js');
  vi.doUnmock('node:fs');
  await Promise.all(tempDirs.splice(0).map((directoryPath) => rm(directoryPath, { recursive: true, force: true })));
});

async function createBuiltinPackagesDirectory(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), 'agent-spec-registry-'));
  tempDirs.push(directoryPath);
  return directoryPath;
}

async function writeBuiltinPackageFixture(
  builtinPackagesDirectory: string,
  preset: string,
  fixture: BuiltinFixtureInput
): Promise<void> {
  const directoryPath = join(builtinPackagesDirectory, preset);
  await mkdir(directoryPath, { recursive: true });
  await writeFile(join(directoryPath, 'agent.json'), `${JSON.stringify(fixture.manifest, null, 2)}\n`);

  for (const [fileName, content] of Object.entries(fixture.promptFiles ?? {})) {
    await writeFile(join(directoryPath, fileName), content);
  }
}

async function importSpecRegistryWithBuiltinDirectory(
  builtinPackagesDirectory: string,
  options?: { failingPromptFilePath?: string }
) {
  vi.doMock('../../src/agent/packagePaths.js', () => ({
    getBuiltinAgentPackageDirectory: (preset: string) => join(builtinPackagesDirectory, preset)
  }));

  if (options?.failingPromptFilePath) {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();

      return {
        ...actual,
        readFileSync(filePath: string | Buffer | URL | number, encoding?: BufferEncoding) {
          const normalizedPath = typeof filePath === 'string' ? filePath : String(filePath);

          if (normalizedPath === options.failingPromptFilePath) {
            const error = new Error(`EACCES: permission denied, open '${normalizedPath}'`) as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          }

          return actual.readFileSync(filePath as never, encoding as never);
        }
      };
    });
  }

  return import('../../src/agent/specRegistry.js');
}

describe('specRegistry builtin parity', () => {
  it('exposes the expected builtin names and default preset', async () => {
    const { getDefaultAgentSpecName, listBuiltinAgentSpecNames } = await import('../../src/agent/specRegistry.js');

    expect(getDefaultAgentSpecName()).toBe('default');
    expect(listBuiltinAgentSpecNames()).toEqual(['default', 'readonly']);
  });

  it('resolves builtin packages directly from package files without legacy AgentSpec derivation', async () => {
    const { resolveBuiltinAgentPackage } = await import('../../src/agent/specRegistry.js');
    const resolved = resolveBuiltinAgentPackage('default');

    expect(resolved.preset).toBe('default');
    expect(resolved.extendsChain).toEqual(['default']);
    expect(resolved.effectivePromptOrder).toEqual(['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'USER.md']);
    expect(resolved.effectivePromptFiles['AGENT.md']?.content).toContain('# AGENTS.md - Your Workspace');
    expect(resolved.effectivePromptFiles['USER.md']?.content).toContain('# USER.md - About Your Human');
    expect(resolved.effectivePolicy.allowedCapabilityClasses).toEqual(['read', 'write']);
    expect(resolved.effectivePolicy.maxToolRounds).toBe(10);
  });

  it('keeps builtin inheritance in resolved packages without AgentSpec bridge metadata', async () => {
    const { resolveBuiltinAgentPackage } = await import('../../src/agent/specRegistry.js');
    const resolved = resolveBuiltinAgentPackage('readonly');

    expect(resolved.extendsChain).toEqual(['readonly', 'default']);
    expect(resolved.effectivePromptOrder).toEqual(['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'USER.md']);
    expect(resolved.effectivePromptFiles['AGENT.md']?.content).toContain('Inspect the project surface and report findings without making edits.');
    expect(resolved.effectivePromptFiles['USER.md']?.content).toContain('Readonly user instructions');
    expect(resolved.effectivePolicy.allowedCapabilityClasses).toEqual(['read']);
    expect(resolved.effectivePolicy.requiresToolEvidence).toBe(true);
    expect(resolved.effectivePolicy.maxToolRounds).toBe(6);
  });
});

describe('specRegistry builtin validation', () => {
  it('loads builtin assets from source and dist without CHECKLIST.md leftovers', async () => {
    const projectRoot = resolve(join(import.meta.dirname, '..', '..'));
    const directories = [
      join(projectRoot, 'src', 'agent', 'builtin-packages'),
      join(projectRoot, 'dist', 'agent', 'builtin-packages')
    ];

    for (const directoryPath of directories) {
      if (!existsSync(directoryPath)) {
        continue;
      }

      await expect(readFile(join(directoryPath, 'default', 'CHECKLIST.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(directoryPath, 'readonly', 'CHECKLIST.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(directoryPath, 'default', 'USER.md'), 'utf8')).resolves.toContain('# USER.md - About Your Human');
      await expect(readFile(join(directoryPath, 'readonly', 'USER.md'), 'utf8')).resolves.toContain('Readonly user instructions');
    }
  });

  it('validates loaded builtin packages before resolving them', async () => {
    const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
      manifest: {
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'SOUL.md': 'Behavioral framing: Minimal\nSafety stance: Minimal\nEscalation policy: Minimal',
        'STYLE.md': 'Operating surface: Minimal',
        'TOOLS.md': 'Tool-use policy: Minimal',
        'USER.md': 'Minimal user instructions'
      }
    });
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'readonly', {
      manifest: {
        extends: 'default',
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': 'Purpose: Readonly\nScope boundary: Readonly',
        'SOUL.md': 'Behavioral framing: Readonly\nSafety stance: Readonly\nEscalation policy: Readonly',
        'STYLE.md': 'Operating surface: Readonly',
        'TOOLS.md': 'Tool-use policy: Readonly',
        'USER.md': 'Readonly user instructions'
      }
    });

    const { resolveBuiltinAgentPackage } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory);

    expect(() => resolveBuiltinAgentPackage('default')).toThrow('Base package "default" must declare at least one prompt file in agent.json.');
  });

  it('detects builtin extends cycles in the sync registry path', async () => {
    const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
      manifest: {
        extends: 'readonly',
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': 'Purpose: Default\nScope boundary: Default',
        'SOUL.md': 'Behavioral framing: Default\nSafety stance: Default\nEscalation policy: Default',
        'STYLE.md': 'Operating surface: Default',
        'TOOLS.md': 'Tool-use policy: Default',
        'USER.md': 'Default user instructions'
      }
    });
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'readonly', {
      manifest: {
        extends: 'default',
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': 'Purpose: Readonly\nScope boundary: Readonly',
        'SOUL.md': 'Behavioral framing: Readonly\nSafety stance: Readonly\nEscalation policy: Readonly',
        'STYLE.md': 'Operating surface: Readonly',
        'TOOLS.md': 'Tool-use policy: Readonly',
        'USER.md': 'Readonly user instructions'
      }
    });

    const { resolveBuiltinAgentPackage } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory);

    expect(() => resolveBuiltinAgentPackage('default')).toThrow(
      'Detected agent package extends cycle: default -> readonly -> default'
    );
  });

  it('ignores discovered markdown files that are not listed in builtin manifests', async () => {
    const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
      manifest: {
        promptFiles: ['AGENT.md', 'USER.md'],
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': 'Purpose: Default\nScope boundary: Default',
        'USER.md': 'Default user instructions',
        'STYLE.md': 'Unlisted builtin markdown should not enter effective prompt order'
      }
    });
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'readonly', {
      manifest: {
        extends: 'default',
        promptFiles: ['TOOLS.md'],
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'TOOLS.md': 'Readonly tool instructions'
      }
    });

    const { resolveBuiltinAgentPackage } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory);
    const resolved = resolveBuiltinAgentPackage('readonly');

    expect(resolved.effectivePromptOrder).toEqual(['AGENT.md', 'USER.md', 'TOOLS.md']);
    expect(resolved.effectivePromptFiles['STYLE.md']?.content).toBe(
      'Unlisted builtin markdown should not enter effective prompt order'
    );
  });

  it('rethrows unexpected prompt read errors instead of masking them as missing files', async () => {
    const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
    const failingPromptFilePath = join(builtinPackagesDirectory, 'default', 'AGENT.md');

    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
      manifest: {
        promptFiles: ['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'USER.md'],
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': 'Purpose: Default\nScope boundary: Default',
        'SOUL.md': 'Behavioral framing: Default\nSafety stance: Default\nEscalation policy: Default',
        'STYLE.md': 'Operating surface: Default',
        'TOOLS.md': 'Tool-use policy: Default',
        'USER.md': 'Default user instructions'
      }
    });
    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'readonly', {
      manifest: {
        extends: 'default',
        promptFiles: ['AGENT.md', 'SOUL.md', 'STYLE.md', 'TOOLS.md', 'USER.md'],
        policy: {
          allowedCapabilityClasses: ['read'],
          maxToolRounds: 2,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': 'Purpose: Readonly\nScope boundary: Readonly',
        'SOUL.md': 'Behavioral framing: Readonly\nSafety stance: Readonly\nEscalation policy: Readonly',
        'STYLE.md': 'Operating surface: Readonly',
        'TOOLS.md': 'Tool-use policy: Readonly',
        'USER.md': 'Readonly user instructions'
      }
    });

    const { resolveBuiltinAgentPackage } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory, {
      failingPromptFilePath
    });

    expect(() => resolveBuiltinAgentPackage('default')).toThrow(`EACCES: permission denied, open '${failingPromptFilePath}'`);
  });
});
