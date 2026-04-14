import { gitTool } from '../tools/git.js';
import { shellTool } from '../tools/shell.js';
import type { ToolContext } from '../tools/tool.js';
import type { TranscriptCell } from './tuiProtocol.js';

export type DirectCommandRequest =
  | { type: 'diff' }
  | { type: 'shell'; command: string; args: string[] };

export interface DirectCommandResult {
  transcriptCells: TranscriptCell[];
  footer?: string;
}

export async function runDirectCommand(request: DirectCommandRequest, cwd: string): Promise<DirectCommandResult> {
  if (request.type === 'diff') {
    return runDiffCommand(cwd);
  }

  return runShellDirectCommand(request.command, request.args, cwd);
}

async function runDiffCommand(cwd: string): Promise<DirectCommandResult> {
  const context: ToolContext = { cwd, mutationMode: 'readonly' };
  const [statusResult, diffResult] = await Promise.all([
    gitTool.execute({ args: ['status', '--short', '--branch'] }, context),
    gitTool.execute({ args: ['diff', '--stat', '--patch'] }, context)
  ]);

  return {
    transcriptCells: [
      {
        id: 'direct-diff-status',
        kind: 'status',
        title: 'Git status',
        text: statusResult.content.trim() || 'Working tree clean.'
      },
      {
        id: 'direct-diff-patch',
        kind: 'diff',
        title: 'Git diff',
        text: diffResult.content.trim() || 'No unstaged diff.'
      }
    ],
    footer: 'Rendered /diff from safe git status and git diff.'
  };
}

async function runShellDirectCommand(command: string, args: string[], cwd: string): Promise<DirectCommandResult> {
  const result = await shellTool.execute({ command, args }, { cwd, mutationMode: 'readonly' });

  return {
    transcriptCells: [
      {
        id: `shell-${command}-${args.join('-') || 'noargs'}`,
        kind: 'shell',
        title: [command, ...args].join(' '),
        text: result.content.trim() || '(no output)'
      }
    ],
    footer: 'shell completed'
  };
}
