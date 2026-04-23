import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentRuntime } from '../../src/agent/runtime.js';
import { fileTool } from '../../src/tools/file.js';
import { gitTool } from '../../src/tools/git.js';
import { getBuiltinToolNames, getBuiltinTools, getTool, hasTool } from '../../src/tools/registry.js';
import * as shellToolModule from '../../src/tools/shell.js';
import { shellTool } from '../../src/tools/shell.js';
import { webFetchTool } from '../../src/tools/webFetch.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tool surface migration', () => {
  it('registers exactly the five migrated built-in tools', () => {
    expect(getBuiltinToolNames()).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
    expect(getBuiltinTools().map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
    expect(hasTool('file')).toBe(true);
    expect(hasTool('shell')).toBe(true);
    expect(hasTool('git')).toBe(true);
    expect(hasTool('web_fetch')).toBe(true);
    expect(hasTool('summary_tool')).toBe(true);
    expect(getTool('file')?.description).toMatch(/read|write|search|list/i);
  });

  it('uses the migrated default runtime tool surface', () => {
    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-compose'
    });

    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch']);
    expect(runtime.resolvedPackage?.effectivePolicy.allowedCapabilityClasses).toEqual(['read', 'write']);
  });

  it('uses the migrated readonly runtime tool surface', () => {
    const runtime = createAgentRuntime({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'anthropic-runtime-key',
      cwd: '/tmp/runtime-readonly',
      agentSpecName: 'readonly'
    });

    expect(runtime.availableTools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch']);
    expect(runtime.resolvedPackage?.effectivePolicy.allowedCapabilityClasses).toEqual(['read']);
  });

  it('supports file read and write actions within the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-actions-'));
    const editablePath = join(workspace, 'editable.txt');

    await writeFile(editablePath, 'alpha\nalpha\n', 'utf8');

    await expect(fileTool.execute({ action: 'read', path: 'editable.txt' } as never, { cwd: workspace })).resolves.toEqual({
      content: 'alpha\nalpha\n'
    });

    await fileTool.execute(
      { action: 'write', path: 'editable.txt', content: 'beta\nalpha\n' } as never,
      { cwd: workspace }
    );

    await expect(readFile(editablePath, 'utf8')).resolves.toBe('beta\nalpha\n');
  });

  it('rejects file write when mutation mode is readonly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-readonly-'));
    const editablePath = join(workspace, 'editable.txt');

    await writeFile(editablePath, 'alpha\n', 'utf8');

    await expect(
      fileTool.execute(
        { action: 'write', path: 'editable.txt', content: 'beta\n' } as never,
        { cwd: workspace, mutationMode: 'readonly' } as never
      )
    ).rejects.toThrow(/mutation mode|readonly|not allowed/i);
  });

  it('supports file search via the action-based surface', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-search-'));
    const srcDir = join(workspace, 'src');
    const nodeModulesDir = join(workspace, 'node_modules');
    const gitDir = join(workspace, '.git');
    const distDir = join(workspace, 'dist');
    const worktreesDir = join(workspace, '.worktrees');
    const matchPath = join(srcDir, 'match.txt');

    await mkdir(srcDir, { recursive: true });
    await mkdir(nodeModulesDir, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(worktreesDir, { recursive: true });

    await writeFile(matchPath, 'alpha\nbeta\nneedle here\ngamma\ndelta', 'utf8');
    await writeFile(join(nodeModulesDir, 'ignored.txt'), 'needle in dependency', 'utf8');
    await writeFile(join(gitDir, 'ignored.txt'), 'needle in git dir', 'utf8');
    await writeFile(join(distDir, 'ignored.txt'), 'needle in build output', 'utf8');
    await writeFile(join(worktreesDir, 'ignored.txt'), 'needle in nested worktree', 'utf8');

    const result = await fileTool.execute({ action: 'search', pattern: 'needle' } as never, { cwd: workspace });
    const data = result.data as {
      totalMatches: number;
      totalFiles: number;
      returnedMatches: number;
      returnedFiles: number;
      files: Array<{ path: string; relativePath: string }>;
    };

    expect(result.content).toContain('Found 1 match in 1 file');
    expect(result.content).toContain(matchPath);
    expect(result.content).not.toContain('ignored.txt');
    expect(data).toMatchObject({
      totalMatches: 1,
      totalFiles: 1,
      returnedMatches: 1,
      returnedFiles: 1,
      files: [{ path: matchPath, relativePath: 'src/match.txt' }]
    });
  });

  it('lets git use the dedicated tool surface', async () => {
    await expect(gitTool.execute({ args: ['status', '--short'] } as never, { cwd: process.cwd() })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'git', args: ['status', '--short'], exitCode: 0 })
    });
  });

  it('lets shell use the unified execution surface', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-shell-'));

    await expect(shellTool.execute({ command: 'uname' }, { cwd: workspace })).resolves.toMatchObject({
      data: expect.objectContaining({ command: 'uname', args: [], exitCode: 0 })
    });
  });

  it('lets web_fetch return fetched response metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('example body')
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(webFetchTool.execute({ url: 'https://example.com' } as never, { cwd: process.cwd() })).resolves.toEqual({
      content: 'example body',
      data: {
        url: 'https://example.com',
        status: 200,
        ok: true
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.com/');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('rejects unsafe web_fetch urls and oversized responses', async () => {
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      redirected: false,
      url: 'https://example.com/large',
      text: vi.fn().mockResolvedValue('x'.repeat(2_000_001))
    });
    const dnsLookupMock = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    vi.doMock('node:dns/promises', () => ({ lookup: dnsLookupMock }));
    vi.stubGlobal('fetch', fetchMock);

    const { webFetchTool: mockedWebFetchTool } = await import('../../src/tools/webFetch.js');

    await expect(mockedWebFetchTool.execute({ url: 'file:///etc/passwd' } as never, { cwd: process.cwd() })).rejects.toThrow(/http|https|url/i);
    await expect(mockedWebFetchTool.execute({ url: 'http://127.0.0.1' } as never, { cwd: process.cwd() })).rejects.toThrow(/not allowed|private|local/i);
    await expect(mockedWebFetchTool.execute({ url: 'http://169.254.1.10' } as never, { cwd: process.cwd() })).rejects.toThrow(/not allowed|private|local/i);
    await expect(mockedWebFetchTool.execute({ url: 'https://example.com/large' } as never, { cwd: process.cwd() })).rejects.toThrow(/too large|size/i);
  });

  it('re-validates redirect targets for web_fetch', async () => {
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      redirected: true,
      url: 'http://127.0.0.1/internal',
      text: vi.fn().mockResolvedValue('redirect body')
    });
    const dnsLookupMock = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    vi.doMock('node:dns/promises', () => ({ lookup: dnsLookupMock }));
    vi.stubGlobal('fetch', fetchMock);

    const { webFetchTool: mockedWebFetchTool } = await import('../../src/tools/webFetch.js');

    await expect(mockedWebFetchTool.execute({ url: 'https://example.com/redirect' } as never, { cwd: process.cwd() })).rejects.toThrow(/not allowed|private|local/i);
  });

  it('blocks redirect targets whose hostname resolves to private IPs', async () => {
    vi.resetModules();

    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      ok: false,
      redirected: true,
      url: 'https://public-redirect.example/internal',
      text: vi.fn().mockResolvedValue('redirect body')
    });
    const dnsLookupMock = vi.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }]);

    vi.doMock('node:dns/promises', () => ({ lookup: dnsLookupMock }));
    vi.stubGlobal('fetch', fetchMock);

    const { webFetchTool: mockedWebFetchTool } = await import('../../src/tools/webFetch.js');

    await expect(mockedWebFetchTool.execute({ url: 'https://example.com/redirect' } as never, { cwd: process.cwd() })).rejects.toThrow(/not allowed|private|local/i);
    expect(dnsLookupMock).toHaveBeenNthCalledWith(1, 'example.com', { all: true, order: 'verbatim' });
    expect(dnsLookupMock).toHaveBeenNthCalledWith(2, 'public-redirect.example', { all: true, order: 'verbatim' });
  });

  it('rejects localhost-style web_fetch urls including IPv6 loopback', async () => {
    await expect(webFetchTool.execute({ url: 'http://service.localhost' } as never, { cwd: process.cwd() })).rejects.toThrow(/not allowed|private|local/i);
    await expect(webFetchTool.execute({ url: 'http://[::1]' } as never, { cwd: process.cwd() })).rejects.toThrow(/not allowed|private|local/i);
  });

  it('supports file list and falls back to grep when rg is unavailable during file search', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-search-fallback-'));
    const filePath = join(workspace, 'match.txt');

    await writeFile(
      filePath,
      Array.from({ length: 40 }, (_, index) => `needle line ${index + 1} ${'x'.repeat(20)}`).join('\n'),
      'utf8'
    );

    const shellSpy = vi.spyOn(shellToolModule.shellTool, 'execute')
      .mockRejectedValueOnce(new Error('Command failed: rg\nExit code: ENOENT'))
      .mockResolvedValueOnce({
        content: Array.from({ length: 40 }, (_, index) => `${filePath}:${index + 1}:needle line ${index + 1} ${'x'.repeat(20)}`).join('\n')
      });

    const listResult = await fileTool.execute({ action: 'list', path: '.' } as never, { cwd: workspace });
    expect(listResult.content).toContain('file\tmatch.txt');

    const result = await fileTool.execute({ action: 'search', pattern: 'needle', maxMatches: 5 } as never, { cwd: workspace });
    const data = result.data as { totalMatches: number; returnedMatches: number; truncated: boolean; truncationReason?: string };

    expect(shellSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'rg' }), { cwd: workspace });
    expect(shellSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'grep' }), { cwd: workspace });
    expect(result.content).toContain(filePath);
    expect(data).toMatchObject({
      totalMatches: 40,
      returnedMatches: 5,
      truncated: true,
      truncationReason: 'maxMatches'
    });
  });

  it('returns zero matches instead of throwing when search finds nothing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-search-empty-'));
    await writeFile(join(workspace, 'sample.txt'), 'alpha\nbeta\n', 'utf8');

    const shellSpy = vi.spyOn(shellToolModule.shellTool, 'execute')
      .mockRejectedValueOnce(new Error('Command failed: rg --json --context 2 --glob !node_modules/** --glob !.git/** --glob !dist/** --glob !.claude/** missing .\nExit code: 1'));

    await expect(fileTool.execute({ action: 'search', pattern: 'missing' } as never, { cwd: workspace })).resolves.toMatchObject({
      data: expect.objectContaining({ totalMatches: 0, returnedMatches: 0, returnedFiles: 0, truncated: false })
    });

    shellSpy.mockRestore();
  });

  it('passes patterns after -- and applies ignore flags to fallback grep', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-search-flags-'));

    const shellSpy = vi.spyOn(shellToolModule.shellTool, 'execute')
      .mockRejectedValueOnce(new Error('Command failed: rg\nExit code: ENOENT'))
      .mockResolvedValueOnce({ content: '' });

    await fileTool.execute({ action: 'search', pattern: '-n literal' } as never, { cwd: workspace });

    expect(shellSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: 'rg',
        args: expect.arrayContaining(['--', '-n literal', '.'])
      }),
      { cwd: workspace }
    );
    expect(shellSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'grep',
        args: expect.arrayContaining(['--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=.claude', '--exclude-dir=.worktrees', '--', '-n literal', '.'])
      }),
      { cwd: workspace }
    );

    shellSpy.mockRestore();
  });

  it('rejects invalid file actions and missing required fields with clear errors', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-file-validation-'));

    await expect(fileTool.execute({ action: 'unknown' } as never, { cwd: workspace })).rejects.toThrow(/unsupported|invalid file action/i);
    await expect(fileTool.execute({ action: 'read' } as never, { cwd: workspace })).rejects.toThrow(/path.*required/i);
    await expect(fileTool.execute({ action: 'write', path: 'note.txt' } as never, { cwd: workspace, mutationMode: 'workspace-write' } as never)).rejects.toThrow(/content.*required/i);
  });
});
