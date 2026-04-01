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

export interface ProviderUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderFinishSummary {
  stopReason?: string;
}

export interface ProviderResponseMetrics {
  contentBlockCount: number;
  toolCallCount: number;
  hasTextOutput: boolean;
  contentBlocksByType?: Record<string, number>;
}

export interface ProviderToolCallSummary {
  id: string;
  name: string;
}

export interface ProviderDebugMetadata {
  providerUsageRawRedacted?: unknown;
  providerStopDetails?: unknown;
  toolCallSummaries?: ProviderToolCallSummary[];
  responseContentBlocksByType?: Record<string, number>;
  responsePreviewRedacted?: string;
}

export interface ProviderResponse {
  message: Message;
  toolCalls: ToolCallRequest[];
  finish?: ProviderFinishSummary;
  usage?: ProviderUsageSummary;
  responseMetrics?: ProviderResponseMetrics;
  debug?: ProviderDebugMetadata;
}

export interface ProviderResponseNormalizationInput {
  content?: string | null;
  toolCalls?: ToolCallRequest[];
  finish?: ProviderFinishSummary;
  usage?: ProviderUsageSummary;
  responseMetrics?: ProviderResponseMetrics;
  debug?: ProviderDebugMetadata;
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
    toolCalls,
    finish: input.finish,
    usage: input.usage,
    responseMetrics: input.responseMetrics,
    debug: input.debug
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
