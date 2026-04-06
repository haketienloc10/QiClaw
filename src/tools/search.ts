import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { shellReadonlyTool } from './shell.js';
import type { Tool } from './tool.js';

type SearchInput = {
  pattern: string;
  contextLines?: number;
  maxMatches?: number;
  maxFiles?: number;
};

type ParsedMatch = {
  filePath: string;
  relativePath: string;
  lineNumber: number;
  line: string;
};

type SearchLine = {
  lineNumber: number;
  text: string;
  isMatch: boolean;
};

type SearchSnippet = {
  startLine: number;
  endLine: number;
  matches: Array<{
    lineNumber: number;
    line: string;
  }>;
  lines: SearchLine[];
};

type SearchResultFile = {
  path: string;
  relativePath: string;
  matchCount: number;
  snippets: SearchSnippet[];
};

type SearchResultData = {
  pattern: string;
  totalMatches: number;
  totalFiles: number;
  returnedMatches: number;
  returnedFiles: number;
  truncated: boolean;
  truncationReason?: 'maxMatches' | 'maxFiles' | 'charLimit' | 'lineLimit';
  files: SearchResultFile[];
};

const SEARCH_OUTPUT_CHAR_LIMIT = 12_000;
const SEARCH_OUTPUT_LINE_LIMIT = 200;
const DEFAULT_CONTEXT_LINES = 2;
const MIN_CONTEXT_LINES = 0;
const MAX_CONTEXT_LINES = 10;
const DEFAULT_MAX_MATCHES = 100;
const MIN_MAX_MATCHES = 1;
const MAX_MAX_MATCHES = 500;
const DEFAULT_MAX_FILES = 50;
const MIN_MAX_FILES = 1;
const MAX_MAX_FILES = 200;
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

      const [, rawPath, rawLineNumber, rawLine] = match;
      const filePath = resolve(cwd, rawPath);
      return {
        filePath,
        relativePath: relative(cwd, filePath) || filePath,
        lineNumber: Number(rawLineNumber),
        line: rawLine
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

function clampOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function groupMatchesByFile(matches: ParsedMatch[]): Map<string, ParsedMatch[]> {
  const matchesByFile = new Map<string, ParsedMatch[]>();
  for (const match of matches) {
    const fileMatches = matchesByFile.get(match.filePath) ?? [];
    fileMatches.push(match);
    matchesByFile.set(match.filePath, fileMatches);
  }

  return matchesByFile;
}

function limitMatches(matches: ParsedMatch[], maxMatches: number, maxFiles: number): ParsedMatch[] {
  const limitedMatches: ParsedMatch[] = [];
  const includedFiles = new Set<string>();

  for (const match of matches) {
    if (!includedFiles.has(match.filePath)) {
      if (includedFiles.size >= maxFiles) {
        break;
      }

      includedFiles.add(match.filePath);
    }

    if (limitedMatches.length >= maxMatches) {
      break;
    }

    limitedMatches.push(match);
  }

  return limitedMatches;
}

async function buildSearchResultData(matches: ParsedMatch[], input: SearchInput, cwd: string): Promise<SearchResultData> {
  const contextLines = clampOption(input.contextLines, DEFAULT_CONTEXT_LINES, MIN_CONTEXT_LINES, MAX_CONTEXT_LINES);
  const maxMatches = clampOption(input.maxMatches, DEFAULT_MAX_MATCHES, MIN_MAX_MATCHES, MAX_MAX_MATCHES);
  const maxFiles = clampOption(input.maxFiles, DEFAULT_MAX_FILES, MIN_MAX_FILES, MAX_MAX_FILES);
  const totalFiles = groupMatchesByFile(matches).size;
  const limitedMatches = limitMatches(matches, maxMatches, maxFiles);
  const limitedFiles = groupMatchesByFile(limitedMatches);
  const truncated = limitedMatches.length < matches.length || limitedFiles.size < totalFiles;
  const files: SearchResultFile[] = [];

  for (const [filePath, fileMatches] of limitedFiles) {
    const fileContent = await readFile(filePath, 'utf8');
    const fileLines = fileContent.split(/\r?\n/);
    const matchLineNumbers = new Set(fileMatches.map((match) => match.lineNumber));
    const ranges = mergeOverlappingRanges(
      fileMatches.map((match) => ({
        start: Math.max(1, match.lineNumber - contextLines),
        end: Math.min(fileLines.length, match.lineNumber + contextLines)
      }))
    );

    const snippets = ranges.map((range) => ({
      startLine: range.start,
      endLine: range.end,
      matches: fileMatches
        .filter((match) => match.lineNumber >= range.start && match.lineNumber <= range.end)
        .map((match) => ({ lineNumber: match.lineNumber, line: match.line })),
      lines: fileLines.slice(range.start - 1, range.end).map((text, index) => {
        const lineNumber = range.start + index;
        return {
          lineNumber,
          text,
          isMatch: matchLineNumbers.has(lineNumber)
        };
      })
    }));

    files.push({
      path: filePath,
      relativePath: fileMatches[0]!.relativePath,
      matchCount: fileMatches.length,
      snippets
    });
  }

  return {
    pattern: input.pattern,
    totalMatches: matches.length,
    totalFiles,
    returnedMatches: limitedMatches.length,
    returnedFiles: limitedFiles.size,
    truncated,
    ...(truncated ? { truncationReason: limitedFiles.size < totalFiles ? 'maxFiles' as const : 'maxMatches' as const } : {}),
    files
  };
}

function formatSearchResult(data: SearchResultData): string {
  if (data.totalMatches === 0) {
    return `No matches found for "${data.pattern}".`;
  }

  const summary = data.truncated
    ? `Found ${pluralize(data.totalMatches, 'match', 'matches')} in ${pluralize(data.totalFiles, 'file', 'files')} for "${data.pattern}"; showing ${pluralize(data.returnedMatches, 'match', 'matches')} in ${pluralize(data.returnedFiles, 'file', 'files')}. Results truncated by ${data.truncationReason}.`
    : `Found ${pluralize(data.totalMatches, 'match', 'matches')} in ${pluralize(data.totalFiles, 'file', 'files')} for "${data.pattern}".`;
  const blocks = data.files.map((file) => {
    const snippetBlocks = file.snippets.map((snippet) => snippet.lines.map((line) => `${line.lineNumber}: ${line.text}`).join('\n'));
    return [file.path, ...snippetBlocks].join('\n');
  });
  const combined = [summary, ...blocks].join('\n\n');

  if (combined.length <= SEARCH_OUTPUT_CHAR_LIMIT && combined.split(/\r?\n/).length <= SEARCH_OUTPUT_LINE_LIMIT) {
    return combined;
  }

  const limitedLines = combined.split(/\r?\n/).slice(0, SEARCH_OUTPUT_LINE_LIMIT).join('\n');
  const truncated = limitedLines.slice(0, SEARCH_OUTPUT_CHAR_LIMIT);
  return `${truncated}\n… limit reached, truncated output`;
}

function emptySearchResultData(pattern: string): SearchResultData {
  return {
    pattern,
    totalMatches: 0,
    totalFiles: 0,
    returnedMatches: 0,
    returnedFiles: 0,
    truncated: false,
    files: []
  };
}

async function buildSearchToolResult(input: SearchInput, cwd: string, matches: ParsedMatch[]) {
  const data = matches.length === 0
    ? emptySearchResultData(input.pattern)
    : await buildSearchResultData(matches, input, cwd);

  return {
    content: formatSearchResult(data),
    data
  };
}

export const searchTool: Tool<SearchInput> = {
  name: 'search',
  description: 'Search for a text pattern under the current working directory and return structured context snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      contextLines: { type: 'number' },
      maxMatches: { type: 'number' },
      maxFiles: { type: 'number' }
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
        return buildSearchToolResult(input, context.cwd, matches);
      } catch (error) {
        lastError = error;
        if (commandName === 'rg' && isCommandMissingError(error, 'rg')) {
          continue;
        }

        if (error instanceof Error && /exit code:\s*1/i.test(error.message)) {
          return buildSearchToolResult(input, context.cwd, []);
        }

        throw error;
      }
    }

    if (lastError instanceof Error && /exit code:\s*1/i.test(lastError.message)) {
      return buildSearchToolResult(input, context.cwd, []);
    }

    throw lastError instanceof Error ? lastError : new Error(`Search failed for pattern: ${input.pattern}`);
  }
};
