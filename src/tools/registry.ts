import { editFileTool } from './editFile.js';
import { readFileTool } from './readFile.js';
import { searchTool } from './search.js';
import { shellExecTool, shellReadonlyTool } from './shell.js';
import type { Tool } from './tool.js';

const builtinTools = [readFileTool, editFileTool, searchTool, shellReadonlyTool, shellExecTool] as const;

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
