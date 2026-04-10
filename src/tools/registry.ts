import { fileTool } from './file.js';
import { gitTool } from './git.js';
import { shellTool } from './shell.js';
import { summaryTool } from './summary.js';
import type { Tool } from './tool.js';
import { webFetchTool } from './webFetch.js';

const builtinTools = [fileTool, shellTool, gitTool, webFetchTool, summaryTool] as const;

const toolsByName = new Map<string, Tool>(builtinTools.map((tool) => [tool.name, tool]));

export type { Tool, ToolContext, ToolResult } from './tool.js';

export function getBuiltinToolNames(): string[] {
  return builtinTools.map((tool) => tool.name);
}

export function getBuiltinTools(): Tool[] {
  return [...builtinTools];
}

export function hasTool(name: string): boolean {
  return toolsByName.has(name);
}

export function getTool(name: string): Tool | undefined {
  return toolsByName.get(name);
}
