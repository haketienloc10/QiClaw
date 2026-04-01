import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExecFileException } from 'node:child_process';

import type { Tool, ToolResult } from './tool.js';

const execFileAsync = promisify(execFile);
const READONLY_COMMAND_ALLOWLIST = new Set(['cat', 'git', 'head', 'ls', 'pwd', 'tail', 'which']);

type ShellInput = {
  command: string;
  args?: string[];
};

type ShellMode = 'readonly' | 'exec';

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

function ensureReadonlyCommandAllowed(command: string): void {
  if (READONLY_COMMAND_ALLOWLIST.has(command)) {
    return;
  }

  throw new Error(`Readonly shell command is not allowed: ${command}`);
}

async function executeShell(input: ShellInput, cwd: string): Promise<ToolResult> {
  const args = input.args ?? [];

  try {
    const result = await execFileAsync(input.command, args, {
      cwd,
      encoding: 'utf8'
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    return {
      content: [stdout, stderr].filter(Boolean).join(''),
      data: {
        command: input.command,
        args,
        stdout,
        stderr,
        exitCode: 0
      }
    };
  } catch (error) {
    throw formatShellFailure(input.command, args, error as ExecFileException & { stdout?: string; stderr?: string });
  }
}

function createShellTool(name: 'shell_readonly' | 'shell_exec', description: string, mode: ShellMode): Tool<ShellInput> {
  return {
    name,
    description,
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
      if (mode === 'readonly') {
        ensureReadonlyCommandAllowed(input.command);
      }

      return executeShell(input, context.cwd);
    }
  };
}

export const shellReadonlyTool = createShellTool(
  'shell_readonly',
  'Run a single read-only program with optional arguments inside the current working directory.',
  'readonly'
);

export const shellExecTool = createShellTool(
  'shell_exec',
  'Run a single program with optional arguments inside the current working directory.',
  'exec'
);
