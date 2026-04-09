import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentPackageManifest, AgentPromptSlotFileName } from '../../src/agent/spec.js';

interface BuiltinFixtureInput {
  manifest: AgentPackageManifest;
  promptFiles?: Partial<Record<AgentPromptSlotFileName, string>>;
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

  it('derives the default builtin AgentSpec bridge fields from literal expected values', async () => {
    const { getBuiltinAgentSpec } = await import('../../src/agent/specRegistry.js');
    const spec = getBuiltinAgentSpec('default');

    expect(spec.identity).toMatchObject({
      purpose: 'Handle a single bounded task inside the QiClaw CLI runtime.',
      behavioralFraming: 'Be concise, tool-using, evidence-aware, and scoped to the requested task.'
    });
    expect(spec.policies.toolUsePolicy).toBe(
      'Use tools when the task depends on observed project state instead of relying on unsupported assumptions.'
    );
    expect(spec.completion.completionMode).toBe('Single-turn task completion with evidence-aware verification.');
    expect(spec.completion.doneCriteriaShape).toBe(
      'Return a non-empty final answer and provide tool evidence when the task requires inspection.'
    );
    expect(spec.completion.evidenceRequirement).toBe('Use direct project evidence for inspection-style claims.');
    expect(spec.completion.stopVsDoneDistinction).toBe(
      'A provider stop is not enough unless the final answer satisfies verification criteria.'
    );
    expect(spec.completion.maxToolRounds).toBe(10);
    expect(spec.diagnosticsProfile).toEqual({
      diagnosticsParticipationLevel: 'normal',
      traceabilityExpectation: 'Keep runtime telemetry traceable without exposing unnecessary host details.',
      redactionSensitivity: 'standard'
    });
    expect(spec.capabilities.allowedCapabilityClasses).toEqual(['read', 'write', 'search', 'exec_readonly', 'execute']);
  });

  it('derives the readonly builtin AgentSpec bridge fields from literal expected values', async () => {
    const { getBuiltinAgentSpec, resolveBuiltinAgentPackage } = await import('../../src/agent/specRegistry.js');
    const spec = getBuiltinAgentSpec('readonly');
    const resolved = resolveBuiltinAgentPackage('readonly');

    expect(spec.identity.purpose).toBe('Inspect the project surface and report findings without making edits.');
    expect(spec.capabilities.allowedCapabilityClasses).toEqual(['read', 'search', 'exec_readonly']);
    expect(spec.policies.mutationPolicy).toBe('Do not mutate the project surface.');
    expect(spec.policies.toolUsePolicy).toBe(
      'Use read and search tools to gather project evidence before making inspection claims.'
    );
    expect(spec.completion.completionMode).toBe('Single-turn read-only inspection with strict evidence-aware verification.');
    expect(spec.completion.doneCriteriaShape).toBe(
      'Return a substantive final answer grounded in direct project inspection evidence.'
    );
    expect(spec.completion.evidenceRequirement).toBe(
      'Use successful read/search tool results for inspection-style claims.'
    );
    expect(spec.completion.stopVsDoneDistinction).toBe(
      'A provider stop is insufficient unless the answer is substantive and consistent with the observed tool results.'
    );
    expect(spec.completion.requiresToolEvidence).toBe(true);
    expect(spec.completion.maxToolRounds).toBe(6);
    expect(resolved.extendsChain).toEqual(['readonly', 'default']);
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
      await expect(readFile(join(directoryPath, 'default', 'CHECKLIST.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(directoryPath, 'readonly', 'CHECKLIST.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(directoryPath, 'default', 'USER.md'), 'utf8')).resolves.toContain('Default user instructions');
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

    expect(() => resolveBuiltinAgentPackage('default')).toThrow('Base package "default" must provide AGENT.md.');
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

  it('rethrows unexpected prompt read errors instead of masking them as missing files', async () => {
    const builtinPackagesDirectory = await createBuiltinPackagesDirectory();
    const failingPromptFilePath = join(builtinPackagesDirectory, 'default', 'AGENT.md');

    await writeBuiltinPackageFixture(builtinPackagesDirectory, 'default', {
      manifest: {
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

    const { getBuiltinAgentSpec } = await importSpecRegistryWithBuiltinDirectory(builtinPackagesDirectory, {
      failingPromptFilePath
    });

    expect(() => getBuiltinAgentSpec('default')).toThrow(`EACCES: permission denied, open '${failingPromptFilePath}'`);
  });
});
