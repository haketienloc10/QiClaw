import { readFile } from 'node:fs/promises';

import { resolveWorkspacePath, type Tool } from './tool.js';

type ReadFileInput = {
  path: string;
  startLine?: number;
  endLine?: number;
};

const MAX_READ_SIZE = 32 * 1024;

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

export const readFileTool: Tool<ReadFileInput> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file relative to the current working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      startLine: { type: 'number' },
      endLine: { type: 'number' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async execute(input, context) {
    const targetPath = resolveWorkspacePath(context.cwd, input.path);
    const content = await readFile(targetPath, 'utf8');

    return {
      content: truncateContent(readLineRange(content, input.startLine, input.endLine))
    };
  }
};
