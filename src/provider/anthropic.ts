import Anthropic from '@anthropic-ai/sdk';
import type {
  Message as AnthropicMessage,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool as AnthropicTool
} from '@anthropic-ai/sdk/resources/messages/messages';

import type { Message as RuntimeMessage } from '../core/types.js';
import { buildTelemetryPreview } from '../telemetry/preview.js';
import {
  redactSensitiveTelemetryPreviewValue,
  redactSensitiveTelemetryValue
} from '../telemetry/redaction.js';
import type { Tool } from '../tools/registry.js';

import {
  normalizeProviderResponse,
  type ModelProvider,
  type NormalizedEvent,
  type ProviderDebugMetadata,
  type ProviderFinishSummary,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResponseMetrics,
  type ProviderUsageSummary,
  type ToolCallRequest
} from './model.js';

export interface AnthropicProviderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export const ANTHROPIC_STREAM_UNSUPPORTED_ERROR = 'Anthropic provider does not support streaming yet.';

export interface BuildAnthropicMessagesRequestInput {
  model: string;
  messages: RuntimeMessage[];
  availableTools: Tool[];
}

export function getAnthropicApiKey(apiKeyOverride?: string): string {
  const apiKey = apiKeyOverride ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY environment variable.');
  }

  return apiKey;
}

export function buildAnthropicMessagesRequest(
  input: BuildAnthropicMessagesRequestInput
): MessageCreateParamsNonStreaming {
  const { systemPrompt, conversation } = splitSystemPrompt(input.messages);

  return {
    model: input.model,
    max_tokens: 16_000,
    stream: false,
    system: systemPrompt,
    messages: conversation,
    tools: input.availableTools.map(toAnthropicTool)
  };
}

export function readAnthropicTextContent(content: unknown[]): string {
  return content
    .filter(isAnthropicTextBlock)
    .map((block) => block.text)
    .join('');
}

export function extractAnthropicToolCalls(content: unknown[]): ToolCallRequest[] {
  return content
    .filter(isAnthropicToolUseBlock)
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input
    }));
}

function countAnthropicContentBlocksByType(content: unknown[]): Record<string, number> {
  return content.reduce<Record<string, number>>((counts, block) => {
    const type = typeof block === 'object' && block !== null && 'type' in block
      ? String((block as { type?: unknown }).type)
      : 'unknown';

    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
}

export function normalizeAnthropicResponseMetadata(response: {
  id: string;
  model: string;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | null;
  content: unknown[];
}): {
  finish: ProviderFinishSummary;
  usage: ProviderUsageSummary;
  responseMetrics: ProviderResponseMetrics;
  debug: ProviderDebugMetadata;
} {
  const toolCalls = extractAnthropicToolCalls(response.content);
  const contentBlocksByType = countAnthropicContentBlocksByType(response.content);
  const inputTokens = response.usage?.input_tokens ?? undefined;
  const outputTokens = response.usage?.output_tokens ?? undefined;
  const totalTokens = typeof inputTokens === 'number' && typeof outputTokens === 'number'
    ? inputTokens + outputTokens
    : undefined;

  return {
    finish: {
      stopReason: response.stop_reason ?? undefined
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens
    },
    responseMetrics: {
      contentBlockCount: response.content.length,
      toolCallCount: toolCalls.length,
      hasTextOutput: readAnthropicTextContent(response.content).length > 0,
      contentBlocksByType
    },
    debug: {
      providerUsageRawRedacted: response.usage ? redactSensitiveTelemetryValue(response.usage) : undefined,
      providerStopDetails: response.stop_reason ? { stop_reason: response.stop_reason } : undefined,
      toolCallSummaries: toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name })),
      responseContentBlocksByType: contentBlocksByType,
      responsePreviewRedacted: buildTelemetryPreview(redactSensitiveTelemetryPreviewValue(response.content), 400)
    }
  };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  return {
    name: 'anthropic',
    model: options.model,
    async *stream(_request: ProviderRequest): AsyncIterable<NormalizedEvent> {
      throw new Error(ANTHROPIC_STREAM_UNSUPPORTED_ERROR);
    },
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const client = new Anthropic({
        apiKey: getAnthropicApiKey(options.apiKey),
        baseURL: options.baseUrl
      });
      const response: AnthropicMessage = await client.messages.create(buildAnthropicMessagesRequest({
        model: options.model,
        messages: request.messages,
        availableTools: request.availableTools
      }));

      const metadata = normalizeAnthropicResponseMetadata(response);
      const content = readAnthropicTextContent(response.content);
      const toolCalls = extractAnthropicToolCalls(response.content);

      if (!metadata.responseMetrics.hasTextOutput && toolCalls.length === 0) {
        throw new Error(`Anthropic response contained no usable output${metadata.finish.stopReason ? `: ${metadata.finish.stopReason}` : ''}`);
      }

      return normalizeProviderResponse({
        content,
        toolCalls,
        finish: metadata.finish,
        usage: metadata.usage,
        responseMetrics: metadata.responseMetrics,
        debug: metadata.debug
      });
    }
  };
}

function splitSystemPrompt(messages: RuntimeMessage[]): { systemPrompt: string | undefined; conversation: MessageParam[] } {
  const systemMessages = messages.filter((message) => message.role === 'system').map((message) => message.content);
  const systemPrompt = systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined;

  const conversation = messages.flatMap<MessageParam>((message) => {
    if (message.role === 'system') {
      return [];
    }

    if (message.role === 'tool') {
      if (!message.toolCallId) {
        throw new Error(`Tool message for ${message.name ?? 'unknown'} is missing toolCallId.`);
      }

      return [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content,
              is_error: message.isError ?? false
            }
          ]
        }
      ];
    }

    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      return [
        {
          role: 'assistant',
          content: [
            ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
            ...message.toolCalls.map((toolCall) => ({
              type: 'tool_use' as const,
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.input
            }))
          ]
        }
      ];
    }

    return [
      {
        role: message.role,
        content: message.content
      }
    ];
  });

  return { systemPrompt, conversation };
}

function toAnthropicTool(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  };
}

function isAnthropicTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return typeof value === 'object' && value !== null && 'type' in value && 'text' in value
    && (value as { type?: unknown }).type === 'text'
    && typeof (value as { text?: unknown }).text === 'string';
}

function isAnthropicToolUseBlock(value: unknown): value is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'tool_use'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { name?: unknown }).name === 'string'
    && typeof (value as { input?: unknown }).input === 'object'
    && (value as { input?: unknown }).input !== null
    && !Array.isArray((value as { input?: unknown }).input);
}
