import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentPackageFromDirectory } from '../../src/agent/packageLoader.js';

import { copyFixtureTree, writePackageFixture, writeRawFile } from './packageTestUtils.js';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agent-packages');

describe('packageLoader', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('loads agent.json and normalizes prompt section line endings without trimming authored markdown', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-loader-'));
    tempDirs.push(tempDir);

    const packageDir = join(tempDir, 'reviewer');
    await writePackageFixture(packageDir, {
      manifest: {
        extends: 'readonly',
        policy: {
          allowedCapabilityClasses: ['read', 'search'],
          maxToolRounds: 4,
          mutationMode: 'none'
        }
      },
      sections: {
        'AGENT.md': '\r\nYou are the reviewer.\r\nStay focused.\r\n',
        'STYLE.md': 'Use short bullets.\n'
      }
    });

    await expect(loadAgentPackageFromDirectory(packageDir, { preset: 'reviewer', sourceTier: 'project' })).resolves.toEqual({
      preset: 'reviewer',
      sourceTier: 'project',
      directoryPath: packageDir,
      manifestPath: join(packageDir, 'agent.json'),
      manifest: {
        extends: 'readonly',
        policy: {
          allowedCapabilityClasses: ['read', 'search'],
          maxToolRounds: 4,
          mutationMode: 'none'
        }
      },
      promptFiles: {
        'AGENT.md': {
          filePath: join(packageDir, 'AGENT.md'),
          content: '\nYou are the reviewer.\nStay focused.\n'
        },
        'STYLE.md': {
          filePath: join(packageDir, 'STYLE.md'),
          content: 'Use short bullets.\n'
        }
      }
    });
  });

  it('returns a package shape with a missing manifest so validator can report it', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-loader-'));
    tempDirs.push(tempDir);

    const packageDir = join(tempDir, 'broken');
    await copyFixtureTree(join(fixtureRoot, 'project', 'no-manifest'), packageDir);

    const loaded = await loadAgentPackageFromDirectory(packageDir, { preset: 'broken', sourceTier: 'project' });

    expect(loaded.manifest).toBeUndefined();
    expect(loaded.promptFiles['AGENT.md']).toEqual({
      filePath: join(packageDir, 'AGENT.md'),
      content: 'Present but missing agent manifest.\n'
    });
  });

  it('rejects manifests whose top-level runtime shape is malformed', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-loader-'));
    tempDirs.push(tempDir);

    const packageDir = join(tempDir, 'malformed');
    await copyFixtureTree(join(fixtureRoot, 'project', 'invalid-manifest'), packageDir);

    await expect(loadAgentPackageFromDirectory(packageDir, { preset: 'malformed', sourceTier: 'project' })).rejects.toThrow(
      'Agent package "malformed" has invalid manifest in'
    );
  });

  it('rejects top-level falsy manifest payloads that are not objects', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-package-loader-'));
    tempDirs.push(tempDir);

    for (const [preset, payload] of [
      ['null-manifest', null],
      ['false-manifest', false]
    ] as const) {
      const packageDir = join(tempDir, preset);
      await writePackageFixture(packageDir, {
        sections: {
          'AGENT.md': 'Falsy manifest fixture.\n'
        }
      });
      await writeRawFile(join(packageDir, 'agent.json'), `${JSON.stringify(payload)}\n`);

      await expect(loadAgentPackageFromDirectory(packageDir, { preset, sourceTier: 'project' })).rejects.toThrow(
        `Agent package "${preset}" has invalid manifest in`
      );
    }
  });
});
