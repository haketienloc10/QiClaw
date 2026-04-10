import type { Tool } from './tool.js';
import { shellTool } from './shell.js';

type GitInput = {
  args?: string[];
};

export const gitTool: Tool<GitInput> = {
  name: 'git',
  description: 'Run git commands inside the current working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: [],
    additionalProperties: false
  },
  async execute(input, context) {
    return shellTool.execute(
      {
        command: 'git',
        args: input.args ?? []
      },
      context
    );
  }
};
