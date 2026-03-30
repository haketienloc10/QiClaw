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
}

export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
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
