import type { Message } from '../core/types.js';
import { serializeToolResult, type Tool, type ToolResult } from '../tools/tool.js';

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
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
  cacheReadInputTokens?: number;
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

export type NormalizedEvent =
  | { type: 'start'; provider: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'finish';
      finish?: ProviderFinishSummary;
      usage?: ProviderUsageSummary;
      responseMetrics?: ProviderResponseMetrics;
      debug?: ProviderDebugMetadata;
    }
  | { type: 'error'; error: unknown };

export interface ModelProvider {
  name: string;
  model: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest): AsyncIterable<NormalizedEvent>;
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

export async function collectProviderStream(
  stream: AsyncIterable<NormalizedEvent>
): Promise<ProviderResponse> {
  let sawStart = false;
  let sawTerminal = false;
  let finish: ProviderFinishSummary | undefined;
  let usage: ProviderUsageSummary | undefined;
  let responseMetrics: ProviderResponseMetrics | undefined;
  let debug: ProviderDebugMetadata | undefined;
  const textParts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  const streamedToolCallIds = new Set<string>();

  for await (const event of stream) {
    if (sawTerminal) {
      throw new Error('Provider stream emitted events after terminal event.');
    }

    switch (event.type) {
      case 'start':
        if (sawStart) {
          throw new Error('Provider stream emitted more than one start event.');
        }
        sawStart = true;
        break;
      case 'text_delta':
        if (!sawStart) {
          throw new Error('Provider stream emitted text_delta before start event.');
        }
        textParts.push(event.text);
        break;
      case 'tool_call':
        if (!sawStart) {
          throw new Error('Provider stream emitted tool_call before start event.');
        }
        if (streamedToolCallIds.has(event.id)) {
          break;
        }
        streamedToolCallIds.add(event.id);
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        break;
      case 'finish':
        if (!sawStart) {
          throw new Error('Provider stream ended without a start event.');
        }
        sawTerminal = true;
        finish = event.finish;
        usage = event.usage;
        responseMetrics = event.responseMetrics;
        debug = event.debug;
        break;
      case 'error':
        if (!sawStart) {
          throw new Error('Provider stream ended without a start event.');
        }
        sawTerminal = true;
        throw event.error instanceof Error
          ? event.error
          : new Error(`Provider stream failed: ${String(event.error)}`);
      default:
        throw new Error(`Unknown provider event type: ${String((event as { type?: unknown }).type)}`);
    }
  }

  if (!sawTerminal) {
    throw new Error('Provider stream ended without finish or error event.');
  }

  const content = textParts.join('');

  if (content.length === 0 && toolCalls.length === 0) {
    throw new Error('Provider stream contained no usable output.');
  }

  const normalizedResponseMetrics = responseMetrics
    ? {
        ...responseMetrics,
        toolCallCount: toolCalls.length
      }
    : undefined;

  return normalizeProviderResponse({
    content,
    toolCalls,
    finish,
    usage,
    responseMetrics: normalizedResponseMetrics,
    debug
  });
}

export function toToolResultMessage(toolCall: ToolCallRequest, result: ToolResult): ToolResultMessage {
  return {
    role: 'tool',
    name: toolCall.name,
    toolCallId: toolCall.id,
    content: serializeToolResult(result),
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
