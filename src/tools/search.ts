import { resolve, relative } from 'node:path';

import { readFileTool } from './readFile.js';
import { shellReadonlyTool } from './shell.js';
import type { Tool } from './tool.js';

type SearchInput = {
  pattern: string;
};

type ParsedMatch = {
  filePath: string;
  lineNumber: number;
};

const SEARCH_OUTPUT_CHAR_LIMIT = 12_000;
const SEARCH_OUTPUT_LINE_LIMIT = 200;
const CONTEXT_LINES_BEFORE = 2;
const CONTEXT_LINES_AFTER = 2;
const skippedGlobs = ['!.git/**', '!node_modules/**', '!dist/**', '!.worktrees/**'];

function buildSearchInvocation(commandName: 'rg' | 'grep', pattern: string) {
  if (commandName === 'rg') {
    return {
      command: 'rg' as const,
      args: ['-n', '--no-heading', ...skippedGlobs.flatMap((glob) => ['-g', glob]), pattern, '.']
    };
  }

  return {
    command: 'grep' as const,
    args: ['-R', '-n', '--binary-files=without-match', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.worktrees', pattern, '.']
  };
}

function isCommandMissingError(error: unknown, commandName: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes(`command failed: ${commandName}`) && message.includes('enoent');
}

function parseSearchMatches(rawOutput: string, cwd: string): ParsedMatch[] {
  return rawOutput
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) {
        return null;
      }

      const [, rawPath, rawLineNumber] = match;
      return {
        filePath: resolve(cwd, rawPath),
        lineNumber: Number(rawLineNumber)
      } satisfies ParsedMatch;
    })
    .filter((match): match is ParsedMatch => match !== null);
}

function mergeOverlappingRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) {
    return [];
  }

  const sortedRanges = [...ranges].sort((left, right) => left.start - right.start);
  const merged = [sortedRanges[0]!];

  for (const range of sortedRanges.slice(1)) {
    const previous = merged.at(-1)!;
    if (range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

async function formatSearchMatches(matches: ParsedMatch[], cwd: string): Promise<string> {
  if (matches.length === 0) {
    return 'No matches found.';
  }

  const matchesByFile = new Map<string, ParsedMatch[]>();
  for (const match of matches) {
    const fileMatches = matchesByFile.get(match.filePath) ?? [];
    fileMatches.push(match);
    matchesByFile.set(match.filePath, fileMatches);
  }

  const blocks: string[] = [];

  for (const [filePath, fileMatches] of matchesByFile) {
    const ranges = mergeOverlappingRanges(
      fileMatches.map((match) => ({
        start: Math.max(1, match.lineNumber - CONTEXT_LINES_BEFORE),
        end: match.lineNumber + CONTEXT_LINES_AFTER
      }))
    );

    const snippetLines: string[] = [filePath];
    const relativePath = relative(cwd, filePath) || filePath;

    for (const range of ranges) {
      const snippet = await readFileTool.execute(
        {
          path: relativePath,
          startLine: range.start,
          endLine: range.end
        },
        { cwd }
      );
      snippetLines.push(snippet.content);
    }

    blocks.push(snippetLines.join('\n'));
  }

  const combined = blocks.join('\n\n');
  if (combined.length <= SEARCH_OUTPUT_CHAR_LIMIT && combined.split(/\r?\n/).length <= SEARCH_OUTPUT_LINE_LIMIT) {
    return combined;
  }

  const limitedLines = combined.split(/\r?\n/).slice(0, SEARCH_OUTPUT_LINE_LIMIT).join('\n');
  const truncated = limitedLines.slice(0, SEARCH_OUTPUT_CHAR_LIMIT);
  return `${truncated}\n… limit reached, truncated output`;
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
    const commands: Array<'rg' | 'grep'> = ['rg', 'grep'];
    let lastError: unknown;

    for (const commandName of commands) {
      try {
        const invocation = buildSearchInvocation(commandName, input.pattern);
        const result = await shellReadonlyTool.execute(invocation, context);
        const matches = parseSearchMatches(result.content, context.cwd);
        return {
          content: await formatSearchMatches(matches, context.cwd)
        };
      } catch (error) {
        lastError = error;
        if (commandName === 'rg' && isCommandMissingError(error, 'rg')) {
          continue;
        }

        if (error instanceof Error && /exit code:\s*1/i.test(error.message)) {
          return {
            content: 'No matches found.'
          };
        }

        throw error;
      }
    }

    if (lastError instanceof Error && /exit code:\s*1/i.test(lastError.message)) {
      return {
        content: 'No matches found.'
      };
    }

    throw lastError instanceof Error ? lastError : new Error(`Search failed for pattern: ${input.pattern}`);
  }
};
