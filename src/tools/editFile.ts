import { readFile, writeFile } from 'node:fs/promises';

import { resolveWorkspacePath, type Tool } from './tool.js';

type EditFileInput = {
  path: string;
  oldText: string;
  newText: string;
};

export const editFileTool: Tool<EditFileInput> = {
  name: 'edit_file',
  description: 'Replace the first matching text block in a UTF-8 text file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' }
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false
  },
  async execute(input, context) {
    const targetPath = resolveWorkspacePath(context.cwd, input.path);
    const existingContent = await readFile(targetPath, 'utf8');

    if (!existingContent.includes(input.oldText)) {
      throw new Error(`Text to replace was not found in ${input.path}`);
    }

    const updatedContent = existingContent.replace(input.oldText, input.newText);
    await writeFile(targetPath, updatedContent, 'utf8');

    return {
      content: `Updated ${input.path}`
    };
  }
};
