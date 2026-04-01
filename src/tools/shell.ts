import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExecFileException } from 'node:child_process';

import type { Tool } from './tool.js';

const execFileAsync = promisify(execFile);

function formatShellFailure(command: string, args: string[], error: ExecFileException & { stdout?: string; stderr?: string }): Error {
  const commandLine = [command, ...args].join(' ');
  const details = [
    `Command failed: ${commandLine}`,
    `Exit code: ${error.code ?? 'unknown'}`,
    `Stdout: ${error.stdout ?? ''}`,
    `Stderr: ${error.stderr ?? ''}`
  ];

  return new Error(details.join('\n'));
}

type ShellInput = {
  command: string;
  args?: string[];
};

export const shellTool: Tool<ShellInput> = {
  name: 'shell',
  description: 'Run a single program with optional arguments inside the current working directory.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  async execute(input, context) {
    const args = input.args ?? [];

    try {
      const result = await execFileAsync(input.command, args, {
        cwd: context.cwd,
        encoding: 'utf8'
      });

      return {
        content: [result.stdout, result.stderr].filter(Boolean).join('')
      };
    } catch (error) {
      throw formatShellFailure(input.command, args, error as ExecFileException & { stdout?: string; stderr?: string });
    }
  }
};
