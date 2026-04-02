import { describe, expect, it } from 'vitest';

import { shellExecTool, shellReadonlyTool } from '../../src/tools/shell.js';

describe('shellReadonlyTool', () => {
  it('allows readonly git subcommands', async () => {
    await expect(shellReadonlyTool.execute({ command: 'git', args: ['status'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({
        command: 'git',
        args: ['status'],
        exitCode: 0
      })
    });
  });

  it('allows readonly date command', async () => {
    await expect(shellReadonlyTool.execute({ command: 'date' }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({
        command: 'date',
        args: [],
        exitCode: 0
      })
    });
  });

  it('allows core unix readonly commands', async () => {
    await expect(shellReadonlyTool.execute({ command: 'uname' }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'uname', args: [], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'whoami' }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'whoami', args: [], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'id' }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'id', args: [], exitCode: 0 })
    });
  });

  it('allows representative readonly inspection commands', async () => {
    await expect(shellReadonlyTool.execute({ command: 'grep', args: ['version', 'package.json'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'grep', args: ['version', 'package.json'], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'stat', args: ['package.json'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'stat', args: ['package.json'], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'ps' }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'ps', args: [], exitCode: 0 })
    });
  });

  it('rejects git subcommands that change repository state', async () => {
    await expect(shellReadonlyTool.execute({ command: 'git', args: ['reset', '--hard'] }, { cwd: process.cwd() })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('rejects find arguments that can execute or delete', async () => {
    await expect(shellReadonlyTool.execute({ command: 'find', args: ['.', '-delete'] }, { cwd: process.cwd() })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
    await expect(
      shellReadonlyTool.execute({ command: 'find', args: ['.', '-exec', 'rm', '{}', ';'] }, { cwd: process.cwd() })
    ).rejects.toThrow(/readonly shell command is not allowed/i);
  });

  it('rejects shell control operators in readonly args', async () => {
    await expect(shellReadonlyTool.execute({ command: 'ls', args: ['>'] }, { cwd: process.cwd() })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('allows readonly sed and awk invocations but rejects in-place sed edits', async () => {
    await expect(shellReadonlyTool.execute({ command: 'sed', args: ['-n', '1p', 'package.json'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'sed', args: ['-n', '1p', 'package.json'], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'awk', args: ['NR==1 { print $0 }', 'package.json'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'awk', args: ['NR==1 { print $0 }', 'package.json'], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'sed', args: ['-i', 's/a/b/', 'package.json'] }, { cwd: process.cwd() })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });

  it('allows readonly less and more invocations but rejects shell-like flags', async () => {
    await expect(shellReadonlyTool.execute({ command: 'less', args: ['--help'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'less', args: ['--help'], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'more', args: ['--help'] }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'more', args: ['--help'], exitCode: 0 })
    });
    await expect(shellReadonlyTool.execute({ command: 'less', args: ['-k', '/tmp/keys', 'package.json'] }, { cwd: process.cwd() })).rejects.toThrow(
      /readonly shell command is not allowed/i
    );
  });
});

describe('shellExecTool', () => {
  it('does not apply readonly command allowlist to shell_exec', async () => {
    await expect(shellExecTool.execute({ command: 'uname' }, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({
        command: 'uname',
        args: [],
        exitCode: 0
      })
    });
  });
});
