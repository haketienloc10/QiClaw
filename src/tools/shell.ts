import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExecFileException } from 'node:child_process';

import type { Tool, ToolResult } from './tool.js';

const execFileAsync = promisify(execFile);
const SHELL_CONTROL_OPERATOR_TOKENS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '<<']);
const READONLY_SIMPLE_COMMAND_ALLOWLIST = new Set([
  'basename',
  'cat',
  'date',
  'df',
  'dirname',
  'echo',
  'env',
  'file',
  'free',
  'grep',
  'head',
  'id',
  'jq',
  'less',
  'ls',
  'more',
  'printenv',
  'ps',
  'pwd',
  'realpath',
  'rg',
  'sort',
  'stat',
  'tail',
  'tree',
  'uname',
  'uptime',
  'wc',
  'which',
  'whoami'
]);
const READONLY_GIT_SUBCOMMAND_ALLOWLIST = new Set([
  'branch',
  'describe',
  'diff',
  'log',
  'remote',
  'rev-parse',
  'show',
  'status',
  'symbolic-ref'
]);
const READONLY_GIT_BRANCH_DENYLIST = new Set(['-d', '-D', '-m', '-M', '--delete', '--move']);
const READONLY_FIND_DENYLIST = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const READONLY_SED_DENYLIST = new Set(['-i', '--in-place']);
const READONLY_LESS_DENYLIST = new Set(['-K', '-k', '--lesskey-src', '--lesskey']);
const READONLY_MORE_DENYLIST = new Set(['-p']);

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

function throwReadonlyCommandNotAllowed(command: string, args: string[]): never {
  const commandLine = [command, ...args].join(' ').trim();

  throw new Error(`Readonly shell command is not allowed: ${commandLine || command}`);
}

function validateReadonlyGitArgs(args: string[]): void {
  const subcommand = args[0];

  if (!subcommand || !READONLY_GIT_SUBCOMMAND_ALLOWLIST.has(subcommand)) {
    throwReadonlyCommandNotAllowed('git', args);
  }

  if (subcommand === 'branch' && args.some((arg) => READONLY_GIT_BRANCH_DENYLIST.has(arg))) {
    throwReadonlyCommandNotAllowed('git', args);
  }
}

function validateReadonlyFindArgs(args: string[]): void {
  if (args.some((arg) => READONLY_FIND_DENYLIST.has(arg))) {
    throwReadonlyCommandNotAllowed('find', args);
  }
}

function validateReadonlySedArgs(args: string[]): void {
  if (args.some((arg) => READONLY_SED_DENYLIST.has(arg) || arg.startsWith('-i'))) {
    throwReadonlyCommandNotAllowed('sed', args);
  }
}

function validateReadonlyLessArgs(args: string[]): void {
  if (args.some((arg) => READONLY_LESS_DENYLIST.has(arg))) {
    throwReadonlyCommandNotAllowed('less', args);
  }
}

function validateReadonlyMoreArgs(args: string[]): void {
  if (args.some((arg) => READONLY_MORE_DENYLIST.has(arg))) {
    throwReadonlyCommandNotAllowed('more', args);
  }
}

function validateReadonlyInvocation(command: string, args: string[]): void {
  if (args.some((arg) => SHELL_CONTROL_OPERATOR_TOKENS.has(arg))) {
    throwReadonlyCommandNotAllowed(command, args);
  }

  if (command === 'git') {
    validateReadonlyGitArgs(args);
    return;
  }

  if (command === 'find') {
    validateReadonlyFindArgs(args);
    return;
  }

  if (command === 'sed') {
    validateReadonlySedArgs(args);
    return;
  }

  if (command === 'less') {
    validateReadonlyLessArgs(args);
    return;
  }

  if (command === 'more') {
    validateReadonlyMoreArgs(args);
    return;
  }

  if (command === 'awk') {
    return;
  }

  if (READONLY_SIMPLE_COMMAND_ALLOWLIST.has(command)) {
    return;
  }

  throwReadonlyCommandNotAllowed(command, args);
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
      const args = input.args ?? [];

      if (mode === 'readonly') {
        validateReadonlyInvocation(input.command, args);
      }

      return executeShell({ ...input, args }, context.cwd);
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
