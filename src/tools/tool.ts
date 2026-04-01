import { relative, resolve, sep } from 'node:path';

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  content: string;
  data?: unknown;
}

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}

export function serializeToolResult(result: ToolResult): string {
  if (result.data === undefined) {
    return result.content;
  }

  return JSON.stringify({
    content: result.content,
    data: result.data
  });
}

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const workspaceRoot = resolve(cwd);
  const targetPath = resolve(workspaceRoot, inputPath);
  const relativePath = relative(workspaceRoot, targetPath);

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path must stay within the workspace: ${inputPath}`);
  }

  return targetPath;
}
