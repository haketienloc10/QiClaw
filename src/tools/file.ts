import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import { readdir } from 'node:fs/promises';

import { resolveWorkspacePath, type Tool, type ToolContext, type ToolResult } from './tool.js';
import { shellTool } from './shell.js';

type FileReadInput = {
  action: 'read';
  path: string;
  startLine?: number;
  endLine?: number;
};

type FileWriteInput = {
  action: 'write';
  path: string;
  content: string;
};

type FileSearchInput = {
  action: 'search';
  pattern?: string;
  query?: string;
  maxMatches?: number;
  maxResults?: number;
  includeContext?: boolean;
};

type FileListInput = {
  action: 'list';
  path?: string;
};

type FileInput = FileReadInput | FileWriteInput | FileSearchInput | FileListInput;

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

const MAX_READ_SIZE = 32 * 1024;
const DEFAULT_MAX_MATCHES = 15;
const CONTEXT_LINES = 2;
const MAX_CONTENT_CHARS = 18_000;
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist', '.claude', '.worktrees']);
const SEARCH_GLOB_EXCLUDES = ['!node_modules/**', '!.git/**', '!dist/**', '!.claude/**', '!.worktrees/**'] as const;
const GREP_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.claude', '.worktrees'] as const;

function truncateContent(content: string): string {
  if (content.length <= MAX_READ_SIZE) {
    return content;
  }

  return `${content.slice(0, MAX_READ_SIZE)}\n... [file truncated]`;
}

function readLineRange(content: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.max(start, endLine ?? lines.length);
  const selected = lines.slice(start - 1, end);

  return selected.map((line, index) => `${start + index}: ${line}`).join('\n');
}

function assertMutationAllowed(context: ToolContext, action: 'write'): void {
  if (context.mutationMode === 'none' || context.mutationMode === 'readonly') {
    throw new Error(`File action "${action}" is not allowed when mutation mode is ${context.mutationMode}.`);
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`File action field "${fieldName}" is required and must be a non-empty string.`);
  }
  return value;
}

function requireOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`File action field "${fieldName}" must be a number when provided.`);
  }
  return value;
}

function normalizeFileInput(input: FileInput): FileInput {
  if (input.action === 'read') {
    return {
      action: 'read',
      path: requireString((input as { path?: unknown }).path, 'path'),
      startLine: requireOptionalNumber((input as { startLine?: unknown }).startLine, 'startLine'),
      endLine: requireOptionalNumber((input as { endLine?: unknown }).endLine, 'endLine')
    };
  }

  if (input.action === 'write') {
    return {
      action: 'write',
      path: requireString((input as { path?: unknown }).path, 'path'),
      content: requireString((input as { content?: unknown }).content, 'content')
    };
  }

  if (input.action === 'search') {
    return {
      action: 'search',
      pattern: typeof input.pattern === 'string' ? input.pattern : undefined,
      query: typeof input.query === 'string' ? input.query : undefined,
      maxMatches: requireOptionalNumber((input as { maxMatches?: unknown }).maxMatches, 'maxMatches'),
      maxResults: requireOptionalNumber((input as { maxResults?: unknown }).maxResults, 'maxResults'),
      includeContext: typeof input.includeContext === 'boolean' ? input.includeContext : undefined
    };
  }

  if (input.action === 'list') {
    return {
      action: 'list',
      path: input.path === undefined ? undefined : requireString((input as { path?: unknown }).path, 'path')
    };
  }

  throw new Error(`Invalid file action: ${(input as { action?: string }).action ?? 'unknown'}`);
}

function isNoMatchSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return /Command failed:[\s\S]*\b(rg|grep)\b/i.test(message) && /Exit code:\s*1\b/i.test(message);
}

function isCommandMissingError(error: unknown, command: 'rg' | 'grep'): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /enoent/i.test(error.message) && new RegExp(`\\b${command}\\b`, 'i').test(error.message);
}

async function executeRead(input: FileReadInput, context: ToolContext): Promise<ToolResult> {
  const targetPath = resolveWorkspacePath(context.cwd, input.path);
  const content = await readFile(targetPath, 'utf8');

  return {
    content: truncateContent(readLineRange(content, input.startLine, input.endLine))
  };
}

async function executeWrite(input: FileWriteInput, context: ToolContext): Promise<ToolResult> {
  assertMutationAllowed(context, 'write');
  const targetPath = resolveWorkspacePath(context.cwd, input.path);
  await writeFile(targetPath, input.content, 'utf8');

  return {
    content: `Wrote ${input.path}`
  };
}

async function executeList(input: FileListInput, context: ToolContext): Promise<ToolResult> {
  const targetPath = resolveWorkspacePath(context.cwd, input.path ?? '.');
  const entries = await readdir(targetPath, { withFileTypes: true });
  const data = entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    content: data.map((entry) => `${entry.type}\t${entry.name}`).join('\n'),
    data: {
      path: input.path ?? '.',
      entries: data
    }
  };
}

async function executeSearch(input: FileSearchInput, context: ToolContext): Promise<ToolResult> {
  const pattern = input.pattern ?? input.query ?? '';
  const maxMatches = input.maxMatches ?? input.maxResults ?? DEFAULT_MAX_MATCHES;

  if (pattern.trim().length === 0) {
    return buildStructuredSearchResult(pattern, '', context, maxMatches);
  }

  const rgArgs = ['--json', '--context', String(CONTEXT_LINES), ...SEARCH_GLOB_EXCLUDES.flatMap((glob) => ['--glob', glob]), '--', pattern, '.'];

  try {
    const rgResult = await shellTool.execute({ command: 'rg', args: rgArgs }, context);
    return buildStructuredSearchResult(pattern, String(rgResult.content ?? ''), context, maxMatches);
  } catch (error) {
    if (isNoMatchSearchError(error)) {
      return buildStructuredSearchResult(pattern, '', context, maxMatches);
    }

    if (!isCommandMissingError(error, 'rg')) {
      throw error;
    }

    const grepArgs = ['-R', '-n', ...GREP_EXCLUDE_DIRS.map((dir) => `--exclude-dir=${dir}`), '--', pattern, '.'];

    try {
      const grepResult = await shellTool.execute({ command: 'grep', args: grepArgs }, context);
      return buildStructuredSearchResult(pattern, String(grepResult.content ?? ''), context, maxMatches);
    } catch (grepError) {
      if (isNoMatchSearchError(grepError)) {
        return buildStructuredSearchResult(pattern, '', context, maxMatches);
      }
      throw grepError;
    }
  }
}

export const fileTool: Tool<FileInput> = {
  name: 'file',
  description: 'Read, write, search, or list workspace files using an action-based interface.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      path: { type: 'string' },
      startLine: { type: 'number' },
      endLine: { type: 'number' },
      content: { type: 'string' },
      pattern: { type: 'string' },
      query: { type: 'string' },
      maxMatches: { type: 'number' },
      maxResults: { type: 'number' },
      includeContext: { type: 'boolean' }
    },
    required: ['action'],
    additionalProperties: false
  },
  async execute(input, context) {
    const normalizedInput = normalizeFileInput(input);

    if (normalizedInput.action === 'read') {
      return executeRead(normalizedInput, context);
    }

    if (normalizedInput.action === 'write') {
      return executeWrite(normalizedInput, context);
    }

    if (normalizedInput.action === 'search') {
      return executeSearch(normalizedInput, context);
    }

    if (normalizedInput.action === 'list') {
      return executeList(normalizedInput, context);
    }

    throw new Error(`Unsupported file action: ${(normalizedInput as { action?: string }).action ?? 'unknown'}`);
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
