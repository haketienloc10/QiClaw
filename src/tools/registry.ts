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

export function formatToolActivityLabel(toolName: string, input: unknown): string | undefined {
  const tool = getTool(toolName);
  const formatted = tool?.formatActivityLabel?.(input)?.trim();
  if (formatted) {
    return formatted;
  }

  return formatFallbackToolActivityLabel(toolName, input);
}

function formatFallbackToolActivityLabel(toolName: string, input: unknown): string | undefined {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return undefined;
  }

  if (!input || typeof input !== 'object') {
    return trimmedToolName;
  }

  const action = readStringField(input, 'action');
  const path = readStringField(input, 'path');
  const url = readStringField(input, 'url');
  const query = readStringField(input, 'query') ?? readStringField(input, 'pattern');
  const commandLabel = formatCommandFields(input);

  const parts = [trimmedToolName];
  if (action) {
    parts.push(action);
  }

  const target = path ?? url ?? query ?? commandLabel;
  if (target) {
    parts.push(target);
  }

  return parts.join(' ');
}

function readStringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function formatCommandFields(input: unknown): string | undefined {
  const command = readStringField(input, 'command');
  if (!input || typeof input !== 'object') {
    return command;
  }

  const args = Array.isArray((input as { args?: unknown }).args)
    ? (input as { args: unknown[] }).args.filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)
    : [];
  const label = [command, ...args].filter((part): part is string => Boolean(part && part.length > 0)).join(' ').trim();

  return label.length > 0 ? label : undefined;
}
