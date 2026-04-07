import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import { shellReadonlyTool } from './shell.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';

interface SearchInput {
  pattern?: string;
  query?: string;
  maxMatches?: number;
  maxResults?: number;
  includeContext?: boolean;
}

interface SearchLine {
  lineNumber: number;
  text: string;
  isMatch: boolean;
}

interface SearchSnippet {
  startLine: number;
  endLine: number;
  matches: Array<{ lineNumber: number; line: string }>;
  lines: SearchLine[];
}

interface SearchFileData {
  path: string;
  relativePath: string;
  snippets: SearchSnippet[];
}

interface SearchResultData {
  pattern: string;
  totalMatches: number;
  totalFiles: number;
  returnedMatches: number;
  returnedFiles: number;
  truncated: boolean;
  truncationReason?: 'maxMatches';
  files: SearchFileData[];
}

const DEFAULT_MAX_MATCHES = 15;
const CONTEXT_LINES = 2;
const MAX_CONTENT_CHARS = 18_000;
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist', '.claude', '.worktrees']);

export const searchTool: Tool<SearchInput> = {
  name: 'search',
  description: 'Search the workspace for matching text and return structured snippets with context.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text or regex to search for.' },
      maxMatches: { type: 'number', description: 'Maximum number of matches to return.' },
      query: { type: 'string', description: 'Alias for pattern.' },
      maxResults: { type: 'number', description: 'Alias for maxMatches.' },
      includeContext: { type: 'boolean', description: 'Reserved compatibility flag.' }
    },
    required: [],
    additionalProperties: false
  },
  async execute(input, context) {
    const pattern = input.pattern ?? input.query ?? '';
    const maxMatches = input.maxMatches ?? input.maxResults ?? DEFAULT_MAX_MATCHES;

    if (pattern.trim().length === 0) {
      return { content: 'Error: Missing "pattern" parameter' };
    }

    const rgArgs = ['--json', '--context', String(CONTEXT_LINES), '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!dist/**', '--glob', '!.claude/**', pattern, '.'];

    try {
      const rgResult = await shellReadonlyTool.execute({ command: 'rg', args: rgArgs }, context);
      return buildStructuredSearchResult(pattern, String(rgResult.content ?? ''), context, maxMatches);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT/i.test(message) || !/\brg\b/i.test(message)) {
        throw error;
      }

      const grepArgs = ['-R', '-n', pattern, '.'];
      const grepResult = await shellReadonlyTool.execute({ command: 'grep', args: grepArgs }, context);
      return buildStructuredSearchResult(pattern, String(grepResult.content ?? ''), context, maxMatches);
    }
  }
};

function buildStructuredSearchResult(
  pattern: string,
  rawOutput: string,
  context: ToolContext,
  maxMatches: number
): ToolResult {
  const workspaceRoot = resolve(context.cwd);
  const parsed = rawOutput.trim().startsWith('{')
    ? parseRipgrepJson(rawOutput, workspaceRoot)
    : parseGrepText(rawOutput, workspaceRoot);

  const totalMatches = parsed.totalMatches;
  const totalFiles = parsed.files.length;
  const limitedFiles = limitFiles(parsed.files, maxMatches);
  const returnedMatches = limitedFiles.reduce((sum, file) => {
    return sum + file.snippets.reduce((snippetSum, snippet) => snippetSum + snippet.matches.length, 0);
  }, 0);
  const truncated = returnedMatches < totalMatches;

  const data: SearchResultData = {
    pattern,
    totalMatches,
    totalFiles,
    returnedMatches,
    returnedFiles: limitedFiles.length,
    truncated,
    truncationReason: truncated ? 'maxMatches' : undefined,
    files: limitedFiles
  };

  const content = formatSearchContent(data);
  return { content: content.slice(0, MAX_CONTENT_CHARS), data };
}

function parseRipgrepJson(rawOutput: string, workspaceRoot: string): { totalMatches: number; files: SearchFileData[] } {
  const files = new Map<string, SearchFileData>();

  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== 'match') {
      continue;
    }

    const filePath = resolve(workspaceRoot, String(entry.data?.path?.text ?? ''));
    if (shouldIgnorePath(filePath, workspaceRoot)) {
      continue;
    }

    const lineNumber = Number(entry.data?.line_number ?? 0);
    const text = String(entry.data?.lines?.text ?? '').replace(/\n$/, '');
    addMatch(files, workspaceRoot, filePath, lineNumber, text);
  }

  return finalizeFiles(files);
}

function parseGrepText(rawOutput: string, workspaceRoot: string): { totalMatches: number; files: SearchFileData[] } {
  const files = new Map<string, SearchFileData>();

  for (const rawLine of rawOutput.split('\n')) {
    if (!rawLine.trim()) {
      continue;
    }

    const match = rawLine.match(/^(.*?):(\d+):(.*)$/);
    if (!match) {
      continue;
    }

    const [, rawPath, rawLineNumber, rawText] = match;
    const filePath = resolve(workspaceRoot, rawPath);
    if (shouldIgnorePath(filePath, workspaceRoot)) {
      continue;
    }

    addMatch(files, workspaceRoot, filePath, Number(rawLineNumber), rawText);
  }

  return finalizeFiles(files);
}

function addMatch(
  files: Map<string, SearchFileData>,
  workspaceRoot: string,
  filePath: string,
  lineNumber: number,
  text: string
): void {
  let file = files.get(filePath);
  if (!file) {
    file = {
      path: filePath,
      relativePath: relative(workspaceRoot, filePath) || basename(filePath),
      snippets: []
    };
    files.set(filePath, file);
  }

  mergeMatchIntoSnippets(file.snippets, lineNumber, text);
}

function mergeMatchIntoSnippets(snippets: SearchSnippet[], lineNumber: number, text: string): void {
  const startLine = Math.max(1, lineNumber - CONTEXT_LINES);
  const endLine = lineNumber + CONTEXT_LINES;
  const overlapping = snippets.filter((snippet) => startLine <= snippet.endLine + 1 && endLine >= snippet.startLine - 1);

  if (overlapping.length === 0) {
    snippets.push(createSnippet(lineNumber, text));
    snippets.sort((a, b) => a.startLine - b.startLine);
    return;
  }

  const target = overlapping[0]!;
  target.startLine = Math.min(target.startLine, startLine);
  target.endLine = Math.max(target.endLine, endLine);
  if (!target.matches.some((match) => match.lineNumber === lineNumber)) {
    target.matches.push({ lineNumber, line: text });
    target.matches.sort((a, b) => a.lineNumber - b.lineNumber);
  }

  for (const snippet of overlapping.slice(1)) {
    target.startLine = Math.min(target.startLine, snippet.startLine);
    target.endLine = Math.max(target.endLine, snippet.endLine);
    for (const match of snippet.matches) {
      if (!target.matches.some((existing) => existing.lineNumber === match.lineNumber)) {
        target.matches.push(match);
      }
    }
    snippets.splice(snippets.indexOf(snippet), 1);
  }

  target.matches.sort((a, b) => a.lineNumber - b.lineNumber);
  target.lines = buildSnippetLines(target.startLine, target.endLine, target.matches);
  snippets.sort((a, b) => a.startLine - b.startLine);
}

function createSnippet(lineNumber: number, text: string): SearchSnippet {
  const startLine = Math.max(1, lineNumber - CONTEXT_LINES);
  const endLine = lineNumber + CONTEXT_LINES;
  const matches = [{ lineNumber, line: text }];

  return {
    startLine,
    endLine,
    matches,
    lines: buildSnippetLines(startLine, endLine, matches)
  };
}

function buildSnippetLines(
  startLine: number,
  endLine: number,
  matches: Array<{ lineNumber: number; line: string }>,
  fileContents?: string[]
): SearchLine[] {
  const matchMap = new Map(matches.map((match) => [match.lineNumber, match.line]));
  const lines: SearchLine[] = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    lines.push({
      lineNumber,
      text: matchMap.get(lineNumber) ?? fileContents?.[lineNumber - 1] ?? `line ${lineNumber}`,
      isMatch: matchMap.has(lineNumber)
    });
  }

  return lines;
}

function finalizeFiles(files: Map<string, SearchFileData>): { totalMatches: number; files: SearchFileData[] } {
  const fileList = Array.from(files.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  for (const file of fileList) {
    file.snippets.sort((a, b) => a.startLine - b.startLine);
    const fileContents = readWorkspaceFileLines(file.path);
    for (const snippet of file.snippets) {
      snippet.lines = buildSnippetLines(snippet.startLine, snippet.endLine, snippet.matches, fileContents);
    }
  }

  const totalMatches = fileList.reduce(
    (sum, file) => sum + file.snippets.reduce((snippetSum, snippet) => snippetSum + snippet.matches.length, 0),
    0
  );

  return { totalMatches, files: fileList };
}

function limitFiles(files: SearchFileData[], maxMatches: number): SearchFileData[] {
  let remaining = maxMatches;
  const limited: SearchFileData[] = [];

  for (const file of files) {
    if (remaining <= 0) {
      break;
    }

    const snippets: SearchSnippet[] = [];
    for (const snippet of file.snippets) {
      if (remaining <= 0) {
        break;
      }

      if (snippet.matches.length <= remaining) {
        snippets.push(snippet);
        remaining -= snippet.matches.length;
        continue;
      }

      const keptMatches = snippet.matches.slice(0, remaining);
      const startLine = Math.min(...keptMatches.map((match) => match.lineNumber)) - CONTEXT_LINES;
      const endLine = Math.max(...keptMatches.map((match) => match.lineNumber)) + CONTEXT_LINES;
      const boundedStartLine = Math.max(1, startLine);
      const fileContents = readWorkspaceFileLines(file.path);
      snippets.push({
        startLine: boundedStartLine,
        endLine,
        matches: keptMatches,
        lines: buildSnippetLines(boundedStartLine, endLine, keptMatches, fileContents)
      });
      remaining = 0;
    }

    if (snippets.length > 0) {
      limited.push({ ...file, snippets });
    }
  }

  return limited;
}

function shouldIgnorePath(filePath: string, workspaceRoot: string): boolean {
  const relativePath = relative(workspaceRoot, filePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return false;
  }

  return relativePath.split(/[\\/]+/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

function readWorkspaceFileLines(filePath: string): string[] | undefined {
  try {
    return readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

function formatSearchContent(data: SearchResultData): string {
  if (data.totalMatches === 0) {
    return JSON.stringify(
      {
        summary: `No matches for pattern: "${data.pattern}"`,
        totalMatches: 0,
        files: [],
        suggestedFiles: []
      },
      null,
      2
    );
  }

  const lines = [
    `Found ${data.returnedMatches} match${data.returnedMatches === 1 ? '' : 'es'} in ${data.returnedFiles} file${data.returnedFiles === 1 ? '' : 's'}`
  ];

  for (const file of data.files) {
    lines.push(file.path);
    for (const snippet of file.snippets) {
      for (const line of snippet.lines) {
        lines.push(`${line.lineNumber}: ${line.text}`);
      }
    }
  }

  if (data.truncated) {
    lines.push(`Results truncated, showing first ${data.returnedMatches} matches.`);
  }

  return lines.join('\n');
}
