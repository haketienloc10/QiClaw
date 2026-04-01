import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Tool } from './tool.js';

type SearchInput = {
  pattern: string;
};

const skippedDirectoryNames = new Set(['.git', 'node_modules', 'dist', '.worktrees']);
const contextLinesBefore = 2;
const contextLinesAfter = 2;

type LineRange = {
  start: number;
  end: number;
};

function mergeOverlappingRanges(ranges: LineRange[]): LineRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  const mergedRanges: LineRange[] = [sortedRanges[0]!];

  for (const range of sortedRanges.slice(1)) {
    const previousRange = mergedRanges.at(-1)!;

    if (range.start <= previousRange.end + 1) {
      previousRange.end = Math.max(previousRange.end, range.end);
      continue;
    }

    mergedRanges.push({ ...range });
  }

  return mergedRanges;
}

function formatMatchBlock(fullPath: string, content: string, pattern: string): string | null {
  const lines = content.split(/\r?\n/);
  const ranges: LineRange[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.includes(pattern)) {
      continue;
    }

    ranges.push({
      start: Math.max(0, index - contextLinesBefore),
      end: Math.min(lines.length - 1, index + contextLinesAfter)
    });
  }

  if (ranges.length === 0) {
    return null;
  }

  const mergedRanges = mergeOverlappingRanges(ranges);
  const snippets = mergedRanges.map((range) => {
    const snippetLines: string[] = [];

    for (let index = range.start; index <= range.end; index += 1) {
      snippetLines.push(`${index + 1}: ${lines[index]}`);
    }

    return snippetLines.join('\n');
  });

  return `${fullPath}\n${snippets.join('\n--\n')}`;
}

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
      const matchBlock = formatMatchBlock(fullPath, content, pattern);

      if (matchBlock) {
        matches.push(matchBlock);
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
      content: matches.join('\n\n')
    };
  }
};
