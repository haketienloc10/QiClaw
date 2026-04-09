import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDirectoryPath = dirname(fileURLToPath(import.meta.url));
const presetNamePattern = /^[a-z0-9_-]+$/;

export function getProjectAgentPackageDirectory(cwd: string, preset: string): string {
  return join(cwd, '.qiclaw', 'agents', validatePresetName(preset));
}

export function getUserAgentPackageDirectory(preset: string, homeDirectory: string = homedir()): string {
  return join(homeDirectory, '.qiclaw', 'agents', validatePresetName(preset));
}

export function getBuiltinAgentPackageDirectory(preset: string, builtinPackagesDirectory: string = join(agentDirectoryPath, 'builtin-packages')): string {
  return join(builtinPackagesDirectory, validatePresetName(preset));
}

function validatePresetName(preset: string): string {
  if (!presetNamePattern.test(preset)) {
    throw new Error(`Invalid agent preset name: "${preset}".`);
  }

  return preset;
}
