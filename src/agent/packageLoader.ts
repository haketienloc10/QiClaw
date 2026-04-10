import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateManifestShape } from './packageValidator.js';
import type {
  AgentPackageSourceTier,
  AgentPromptFile,
  AgentPromptFileName,
  LoadedAgentPackage
} from './spec.js';

export async function loadAgentPackageFromDirectory(
  directoryPath: string,
  options: { preset: string; sourceTier: AgentPackageSourceTier }
): Promise<LoadedAgentPackage> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const promptFiles: Record<AgentPromptFileName, AgentPromptFile> = {};
  let manifest: LoadedAgentPackage['manifest'];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === 'agent.json') {
      const manifestPath = join(directoryPath, entry.name);
      const raw = await readFile(manifestPath, 'utf8');
      const parsedManifest = JSON.parse(normalizeLineEndings(raw)) as LoadedAgentPackage['manifest'];
      const manifestErrors = validateManifestShape(options.preset, parsedManifest);

      if (manifestErrors.length > 0) {
        throw new Error(`Agent package "${options.preset}" has invalid manifest in ${manifestPath}.\n${manifestErrors.join('\n')}`);
      }

      manifest = parsedManifest;
      continue;
    }

    if (!isMarkdownFile(entry.name)) {
      continue;
    }

    const filePath = join(directoryPath, entry.name);
    const raw = await readFile(filePath, 'utf8');
    promptFiles[entry.name] = {
      filePath,
      content: normalizeMarkdownContent(raw)
    };
  }

  return {
    preset: options.preset,
    sourceTier: options.sourceTier,
    directoryPath,
    manifestPath: join(directoryPath, 'agent.json'),
    manifest,
    promptFiles
  };
}

function isMarkdownFile(fileName: string): fileName is AgentPromptFileName {
  return fileName.endsWith('.md');
}

function normalizeMarkdownContent(value: string): string {
  return normalizeLineEndings(value);
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}
