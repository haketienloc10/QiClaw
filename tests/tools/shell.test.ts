import { describe, expect, it, vi } from 'vitest';

import { shellTool } from '../../src/tools/shell.js';

describe('shellTool', () => {
  it('allows readonly git subcommands', async () => {
    await expect(shellTool.execute({ command: 'git', args: ['status'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({
        command: 'git',
        args: ['status'],
        exitCode: 0
      })
    });
  });

  it('allows readonly date command', async () => {
    await expect(shellTool.execute({ command: 'date' }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({
        command: 'date',
        args: [],
        exitCode: 0
      })
    });
  });

  it('allows core unix readonly commands', async () => {
    await expect(shellTool.execute({ command: 'uname' }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'uname', args: [], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'whoami' }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'whoami', args: [], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'id' }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'id', args: [], exitCode: 0 })
    });
  });

  it('allows representative readonly inspection commands', async () => {
    await expect(shellTool.execute({ command: 'grep', args: ['version', 'package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'grep', args: ['version', 'package.json'], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'stat', args: ['package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'stat', args: ['package.json'], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'ps' }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'ps', args: [], exitCode: 0 })
    });
  });

  it('rejects git subcommands that change repository state', async () => {
    await expect(shellTool.execute({ command: 'git', args: ['reset', '--hard'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'git', args: ['branch', 'new-name'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'git', args: ['branch', '-f', 'main'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'git', args: ['remote', 'add', 'origin', 'https://example.com/repo.git'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('rejects find arguments that can execute or delete', async () => {
    await expect(shellTool.execute({ command: 'find', args: ['.', '-delete'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(
      shellTool.execute({ command: 'find', args: ['.', '-exec', 'rm', '{}', ';'] }, { cwd: process.cwd(), mutationMode: 'none' })
    ).rejects.toThrow(/readonly shell command is not allowed/i);
  });

  it('rejects shell control operators in readonly args', async () => {
    await expect(shellTool.execute({ command: 'ls', args: ['>'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('allows readonly sed invocations but rejects in-place sed edits and awk execution', async () => {
    await expect(shellTool.execute({ command: 'sed', args: ['-n', '1p', 'package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'sed', args: ['-n', '1p', 'package.json'], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'awk', args: ['NR==1 { print $0 }', 'package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'sed', args: ['-i', 's/a/b/', 'package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('rejects env-based readonly bypass attempts', async () => {
    await expect(shellTool.execute({ command: 'env', args: ['sh', '-c', 'pwd'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'env', args: ['awk', 'NR==1 { print $0 }', 'package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('blocks git readonly commands with mutating flags after allowed subcommands', async () => {
    await expect(shellTool.execute({ command: 'git', args: ['remote', 'set-url', 'origin', 'https://example.com/repo.git'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'git', args: ['branch', '--create-reflog', 'topic'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'git', args: ['diff', '--output=/tmp/git-diff.txt'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(shellTool.execute({ command: 'git', args: ['-c', 'core.editor=vim', 'status'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('executes allowed readonly git inspection commands without spawning disallowed ones', async () => {
    const execSpy = vi.spyOn(process, 'cwd');
    await expect(shellTool.execute({ command: 'git', args: ['log', '--oneline', '-1'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'git', args: ['log', '--oneline', '-1'], exitCode: 0 })
    });
    expect(execSpy).toHaveBeenCalled();
    execSpy.mockRestore();
  });

  it('allows readonly less and more invocations but rejects shell-like flags', async () => {
    await expect(shellTool.execute({ command: 'less', args: ['--help'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'less', args: ['--help'], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'more', args: ['--help'] }, { cwd: process.cwd(), mutationMode: 'none' })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'more', args: ['--help'], exitCode: 0 })
    });
    await expect(shellTool.execute({ command: 'less', args: ['-k', '/tmp/keys', 'package.json'] }, { cwd: process.cwd(), mutationMode: 'none' })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });
});

it('allows non-readonly commands when mutation mode permits them', async () => {
  await expect(shellTool.execute({ command: 'uname' }, { cwd: process.cwd(), mutationMode: 'workspace-write' })).resolves.toMatchObject({
    data: expect.objectContaining({
      command: 'uname',
      args: [],
      exitCode: 0
    })
  });
});
