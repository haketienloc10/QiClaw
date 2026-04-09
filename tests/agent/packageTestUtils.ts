import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentPackageManifest, AgentPromptSlotFileName } from '../../src/agent/spec.js';

export interface PackageFixtureInput {
  manifest?: AgentPackageManifest;
  sections?: Partial<Record<AgentPromptSlotFileName, string>>;
}

export async function writePackageFixture(directoryPath: string, fixture: PackageFixtureInput): Promise<void> {
  await mkdir(directoryPath, { recursive: true });

  if (fixture.manifest) {
    await writeFile(join(directoryPath, 'agent.json'), `${JSON.stringify(fixture.manifest, null, 2)}\n`);
  }

  for (const [fileName, content] of Object.entries(fixture.sections ?? {})) {
    await writeFile(join(directoryPath, fileName), content);
  }
}

export async function copyFixtureTree(sourceDirectoryPath: string, targetDirectoryPath: string): Promise<void> {
  await mkdir(dirname(targetDirectoryPath), { recursive: true });
  await cp(sourceDirectoryPath, targetDirectoryPath, { recursive: true });
}

export async function writeRawFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

export async function readFixtureFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}
