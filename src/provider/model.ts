import type { Message } from '../core/types.js';
import type { Tool, ToolResult } from '../tools/tool.js';

export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultMessage extends Message {
  role: 'tool';
  name: string;
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type ProviderId = 'anthropic' | 'openai';

export interface ResolvedProviderConfig {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ProviderRequest {
  messages: Message[];
  availableTools: Tool[];
}

export interface ProviderResponse {
  message: Message;
  toolCalls: ToolCallRequest[];
}

export interface ProviderResponseNormalizationInput {
  content?: string | null;
  toolCalls?: ToolCallRequest[];
}

export interface ModelProvider {
  name: string;
  model: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export function normalizeProviderResponse(input: ProviderResponseNormalizationInput): ProviderResponse {
  const toolCalls = input.toolCalls ?? [];

  return {
    message: {
      role: 'assistant',
      content: input.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    },
    toolCalls
  };
}

export function toToolResultMessage(toolCall: ToolCallRequest, result: ToolResult): ToolResultMessage {
  return {
    role: 'tool',
    name: toolCall.name,
    toolCallId: toolCall.id,
    content: result.content,
    isError: false
  };
}

export function toToolErrorMessage(toolCall: ToolCallRequest, error: unknown): ToolResultMessage {
  return {
    role: 'tool',
    name: toolCall.name,
    toolCallId: toolCall.id,
    content: error instanceof Error ? error.message : String(error),
    isError: true
  };
}
