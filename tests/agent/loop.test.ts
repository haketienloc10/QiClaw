import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { dispatchToolCall } from '../../src/agent/dispatcher.js';
import { createAnthropicProvider } from '../../src/provider/anthropic.js';
import type { ProviderResponse, ToolCallRequest } from '../../src/provider/model.js';
import { editFileTool } from '../../src/tools/editFile.js';
import { getBuiltinToolNames, getBuiltinTools, getTool, hasTool, type Tool, type ToolContext } from '../../src/tools/registry.js';
import { readFileTool } from '../../src/tools/readFile.js';
import { searchTool } from '../../src/tools/search.js';
import { shellTool } from '../../src/tools/shell.js';

describe('tool registry', () => {
  it('registers the built-in tool names in a stable order', () => {
    expect(getBuiltinToolNames()).toEqual(['read_file', 'edit_file', 'search', 'shell']);
  });

  it('supports tool lookup by name', () => {
    expect(hasTool('read_file')).toBe(true);
    expect(hasTool('edit_file')).toBe(true);
    expect(hasTool('search')).toBe(true);
    expect(hasTool('shell')).toBe(true);
    expect(hasTool('missing_tool')).toBe(false);

    expect(getTool('missing_tool')).toBeUndefined();
  });

  it('returns tool contracts with handlers for each built-in tool', () => {
    const toolNames = getBuiltinToolNames();

    for (const name of toolNames) {
      const tool = getTool(name);

      expect(tool).toBeDefined();
      expect(tool?.name).toBe(name);
      expect(tool?.description).toBeTypeOf('string');
      expect(tool?.inputSchema).toBeDefined();
      expect(tool?.execute).toBeTypeOf('function');
    }
  });
});

describe('tool contract', () => {
  it('lets a tool return structured text output', async () => {
    const calls: Array<{ cwd: string; input: { value: string } }> = [];
    const context: ToolContext = {
      cwd: '/tmp/worktree'
    };

    const tool: Tool<{ value: string }> = {
      name: 'demo_tool',
      description: 'Returns the provided value',
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' }
        },
        required: ['value'],
        additionalProperties: false
      },
      async execute(input, runtimeContext) {
        calls.push({ cwd: runtimeContext.cwd, input });

        return {
          content: `value=${input.value}`
        };
      }
    };

    const result = await tool.execute({ value: 'ok' }, context);

    expect(calls).toEqual([
      {
        cwd: '/tmp/worktree',
        input: { value: 'ok' }
      }
    ]);
    expect(result).toEqual({
      content: 'value=ok'
    });
  });
});

describe('provider and dispatcher', () => {
  it('exposes a minimal provider contract with a stable name and model id', async () => {
    const provider = createAnthropicProvider({ model: 'claude-sonnet-4-20250514' });

    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-sonnet-4-20250514');

    const response = await provider.generate({
      messages: [{ role: 'user', content: 'Read README.md' }],
      availableTools: getBuiltinTools()
    });

    expect(response).toEqual({
      message: {
        role: 'assistant',
        content: 'Anthropic provider stub: no live API call configured.'
      },
      toolCalls: []
    } satisfies ProviderResponse);
  });

  it('dispatches a successful tool call into a normalized tool result message', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-success-'));
    await writeFile(join(workspace, 'note.txt'), 'hello dispatcher', 'utf8');

    const toolCall: ToolCallRequest = {
      id: 'call-read-1',
      name: 'read_file',
      input: { path: 'note.txt' }
    };

    await expect(dispatchToolCall(toolCall, { cwd: workspace })).resolves.toEqual({
      role: 'tool',
      name: 'read_file',
      toolCallId: 'call-read-1',
      content: 'hello dispatcher',
      isError: false
    });
  });

  it('normalizes missing tools as dispatcher errors instead of throwing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-missing-tool-'));

    await expect(
      dispatchToolCall(
        {
          id: 'call-missing-1',
          name: 'missing_tool',
          input: {}
        },
        { cwd: workspace }
      )
    ).resolves.toEqual({
      role: 'tool',
      name: 'missing_tool',
      toolCallId: 'call-missing-1',
      content: 'Tool not found: missing_tool',
      isError: true
    });
  });

  it('normalizes tool execution failures into tool error messages', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dispatcher-tool-error-'));

    await expect(
      dispatchToolCall(
        {
          id: 'call-read-missing-file',
          name: 'read_file',
          input: { path: 'missing.txt' }
        },
        { cwd: workspace }
      )
    ).resolves.toEqual({
      role: 'tool',
      name: 'read_file',
      toolCallId: 'call-read-missing-file',
      content: expect.stringMatching(/missing\.txt/i),
      isError: true
    });
  });
});

describe('built-in tool behavior', () => {
  it('keeps read_file inside the workspace root', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'tool-parent-'));
    const workspace = join(parentDir, 'workspace');
    const allowedPath = join(workspace, 'allowed.txt');
    const outsidePath = join(parentDir, 'outside.txt');

    await mkdir(workspace, { recursive: true });
    await writeFile(allowedPath, 'inside', 'utf8');
    await writeFile(outsidePath, 'outside', 'utf8');

    await expect(readFileTool.execute({ path: 'allowed.txt' }, { cwd: workspace })).resolves.toEqual({
      content: 'inside'
    });

    await expect(readFileTool.execute({ path: '../outside.txt' }, { cwd: workspace })).rejects.toThrow(
      /workspace/i
    );
    await expect(readFileTool.execute({ path: outsidePath }, { cwd: workspace })).rejects.toThrow(/workspace/i);
  });

  it('keeps edit_file inside the workspace root and replaces only the first match', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-workspace-'));
    const editablePath = join(workspace, 'editable.txt');
    const outsidePath = join(tmpdir(), `outside-edit-${Date.now()}.txt`);

    await writeFile(editablePath, 'alpha\nalpha\n', 'utf8');
    await writeFile(outsidePath, 'blocked', 'utf8');

    await editFileTool.execute(
      {
        path: 'editable.txt',
        oldText: 'alpha',
        newText: 'beta'
      },
      { cwd: workspace }
    );

    await expect(readFile(editablePath, 'utf8')).resolves.toBe('beta\nalpha\n');
    await expect(editFileTool.execute({ path: outsidePath, oldText: 'blocked', newText: 'open' }, { cwd: workspace }))
      .rejects.toThrow(/workspace/i);
  });

  it('skips obvious irrelevant directories while searching and reports matches as they are found', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-search-'));
    const srcDir = join(workspace, 'src');
    const nodeModulesDir = join(workspace, 'node_modules');
    const gitDir = join(workspace, '.git');
    const distDir = join(workspace, 'dist');
    const worktreesDir = join(workspace, '.worktrees');

    await mkdir(srcDir, { recursive: true });
    await mkdir(nodeModulesDir, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await mkdir(worktreesDir, { recursive: true });

    await writeFile(join(srcDir, 'match.txt'), 'needle here', 'utf8');
    await writeFile(join(nodeModulesDir, 'ignored.txt'), 'needle in dependency', 'utf8');
    await writeFile(join(gitDir, 'ignored.txt'), 'needle in git dir', 'utf8');
    await writeFile(join(distDir, 'ignored.txt'), 'needle in build output', 'utf8');
    await writeFile(join(worktreesDir, 'ignored.txt'), 'needle in nested worktree', 'utf8');

    const result = await searchTool.execute({ pattern: 'needle' }, { cwd: workspace });

    expect(result.content).toBe(join(srcDir, 'match.txt'));
  });

  it('wraps shell failures with command, exit code, stdout, and stderr', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tool-shell-'));

    await expect(
      shellTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/exit code:\s*7/i);

    await expect(
      shellTool.execute(
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);']
        },
        { cwd: workspace }
      )
    ).rejects.toThrow(/stdout:\s*out[\s\S]*stderr:\s*err/i);
  });
});
