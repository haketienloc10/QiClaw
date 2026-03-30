import { readFile } from 'node:fs/promises';

import { resolveWorkspacePath, type Tool } from './tool.js';

type ReadFileInput = {
  path: string;
};

export const readFileTool: Tool<ReadFileInput> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file relative to the current working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' }
    },
    required: ['path'],
    additionalProperties: false
  },
  async execute(input, context) {
    const targetPath = resolveWorkspacePath(context.cwd, input.path);
    const content = await readFile(targetPath, 'utf8');

    return {
      content
    };
  }
};
