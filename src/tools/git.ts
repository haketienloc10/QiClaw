import type { Tool } from './tool.js';
import { shellTool } from './shell.js';

type GitInput = {
  args?: string[];
};

function formatGitActivityLabel(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return 'git';
  }

  const args = Array.isArray((input as { args?: unknown }).args)
    ? (input as { args: unknown[] }).args.filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
    : [];
  const label = args.join(' ').trim();

  return label.length > 0 ? `git ${label}` : 'git';
}

export const gitTool: Tool<GitInput> = {
  name: 'git',
  description: 'Run git commands inside the current working directory.',
  formatActivityLabel: formatGitActivityLabel,
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
