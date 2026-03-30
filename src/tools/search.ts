import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Tool } from './tool.js';

type SearchInput = {
  pattern: string;
};

const skippedDirectoryNames = new Set(['.git', 'node_modules', 'dist', '.worktrees']);

async function searchDirectory(rootDir: string, pattern: string, matches: string[]): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectoryNames.has(entry.name)) {
      continue;
    }

    const fullPath = join(rootDir, entry.name);

    if (entry.isDirectory()) {
      await searchDirectory(fullPath, pattern, matches);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const content = await readFile(fullPath, 'utf8');

      if (content.includes(pattern)) {
        matches.push(fullPath);
      }
    } catch {
      // Ignore unreadable or binary-like files in this MVP implementation.
    }
  }
}

export const searchTool: Tool<SearchInput> = {
  name: 'search',
  description: 'Search for a literal text pattern under the current working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  async execute(input, context) {
    const rootDir = resolve(context.cwd);
    const matches: string[] = [];

    await searchDirectory(rootDir, input.pattern, matches);

    return {
      content: matches.join('\n')
    };
  }
};
