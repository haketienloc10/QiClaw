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
const READONLY_GIT_BRANCH_FLAG_ALLOWLIST = new Set([
  '-a',
  '-r',
  '--all',
  '--remotes',
  '--show-current',
  '--list',
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
  '--column',
  '--omit-empty',
  '--ignore-case',
  '--color',
  '--no-color'
]);
const READONLY_GIT_REMOTE_FLAG_ALLOWLIST = new Set(['-v', '--verbose']);
const READONLY_GIT_REMOTE_ACTION_ALLOWLIST = new Set(['show']);
const READONLY_GIT_GLOBAL_FLAG_DENYLIST = new Set(['-c', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace']);
const READONLY_GIT_DIFF_FLAG_DENYLIST = new Set(['--output']);
const READONLY_FIND_DENYLIST = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);
const READONLY_SED_DENYLIST = new Set(['-i', '--in-place']);
const READONLY_LESS_DENYLIST = new Set(['-K', '-k', '--lesskey-src', '--lesskey']);
const READONLY_MORE_DENYLIST = new Set(['-p']);

type ShellInput = {
  command: string;
  args?: string[];
};


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

function isGitBranchReadonlyFlag(arg: string): boolean {
  if (READONLY_GIT_BRANCH_FLAG_ALLOWLIST.has(arg)) {
    return true;
  }

  return Array.from(READONLY_GIT_BRANCH_FLAG_ALLOWLIST).some((flag) => arg.startsWith(`${flag}=`));
}

function validateReadonlyGitBranchArgs(args: string[]): void {
  const branchArgs = args.slice(1);

  if (branchArgs.length === 0) {
    return;
  }

  for (const arg of branchArgs) {
    if (!arg.startsWith('-')) {
      throwReadonlyCommandNotAllowed('git', args);
    }

    if (!isGitBranchReadonlyFlag(arg)) {
      throwReadonlyCommandNotAllowed('git', args);
    }
  }
}

function validateReadonlyGitRemoteArgs(args: string[]): void {
  const remoteArgs = args.slice(1);

  if (remoteArgs.length === 0) {
    return;
  }

  const firstNonFlagArg = remoteArgs.find((arg) => !arg.startsWith('-'));
  if (!firstNonFlagArg) {
    if (remoteArgs.every((arg) => READONLY_GIT_REMOTE_FLAG_ALLOWLIST.has(arg))) {
      return;
    }
    throwReadonlyCommandNotAllowed('git', args);
  }

  if (!READONLY_GIT_REMOTE_ACTION_ALLOWLIST.has(firstNonFlagArg)) {
    throwReadonlyCommandNotAllowed('git', args);
  }

  for (const arg of remoteArgs) {
    if (arg === firstNonFlagArg) {
      continue;
    }
    if (arg.startsWith('-') && !READONLY_GIT_REMOTE_FLAG_ALLOWLIST.has(arg)) {
      throwReadonlyCommandNotAllowed('git', args);
    }
  }
}

function findReadonlyGitSubcommandIndex(args: string[]): number {
  const subcommandIndex = args.findIndex((arg, index) => {
    if (index > 0 && args[index - 1] === '--') {
      return false;
    }

    return !arg.startsWith('-');
  });

  if (subcommandIndex === -1) {
    throwReadonlyCommandNotAllowed('git', args);
  }

  return subcommandIndex;
}

function validateReadonlyGitDiffArgs(args: string[], diffArgs: string[]): void {
  for (let index = 0; index < diffArgs.length; index += 1) {
    const arg = diffArgs[index];

    if (READONLY_GIT_DIFF_FLAG_DENYLIST.has(arg) || Array.from(READONLY_GIT_DIFF_FLAG_DENYLIST).some((flag) => arg.startsWith(`${flag}=`))) {
      throwReadonlyCommandNotAllowed('git', args);
    }
  }
}

function validateReadonlyGitArgs(args: string[]): void {
  const subcommandIndex = findReadonlyGitSubcommandIndex(args);
  const subcommand = args[subcommandIndex];

  if (!READONLY_GIT_SUBCOMMAND_ALLOWLIST.has(subcommand)) {
    throwReadonlyCommandNotAllowed('git', args);
  }

  const leadingArgs = args.slice(0, subcommandIndex);
  if (leadingArgs.some((arg) => READONLY_GIT_GLOBAL_FLAG_DENYLIST.has(arg))) {
    throwReadonlyCommandNotAllowed('git', args);
  }

  const subcommandArgs = args.slice(subcommandIndex);

  if (subcommand === 'branch') {
    validateReadonlyGitBranchArgs(subcommandArgs);
    return;
  }

  if (subcommand === 'remote') {
    validateReadonlyGitRemoteArgs(subcommandArgs);
    return;
  }

  if (subcommand === 'diff') {
    validateReadonlyGitDiffArgs(args, subcommandArgs.slice(1));
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

function validateReadonlyEnvArgs(args: string[]): void {
  const commandIndex = args.findIndex((arg) => !arg.includes('=') || arg.startsWith('='));

  if (commandIndex === -1) {
    return;
  }

  const nestedCommand = args[commandIndex];
  const nestedArgs = args.slice(commandIndex + 1);

  validateReadonlyInvocation(nestedCommand, nestedArgs);
}

function validateReadonlyInvocation(command: string, args: string[]): void {
  if (args.some((arg) => SHELL_CONTROL_OPERATOR_TOKENS.has(arg))) {
    throwReadonlyCommandNotAllowed(command, args);
  }

  if (command === 'env') {
    validateReadonlyEnvArgs(args);
    return;
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
    throwReadonlyCommandNotAllowed(command, args);
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

    if (context.mutationMode === 'none' || context.mutationMode === 'readonly') {
      validateReadonlyInvocation(input.command, args);
    }

    return executeShell({ ...input, args }, context.cwd);
  }
};
