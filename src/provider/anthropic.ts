import Anthropic from '@anthropic-ai/sdk';
import type {
  Message as AnthropicMessage,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool as AnthropicTool
} from '@anthropic-ai/sdk/resources/messages/messages';

import type { Message as RuntimeMessage } from '../core/types.js';
import type { Tool } from '../tools/registry.js';

import {
  normalizeProviderResponse,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResponseMetadata,
  type ToolCallRequest
} from './model.js';

export interface AnthropicProviderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

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
}): ProviderResponseMetadata {
  const inputTokens = response.usage?.input_tokens ?? undefined;
  const outputTokens = response.usage?.output_tokens ?? undefined;
  const cacheCreationInputTokens = response.usage?.cache_creation_input_tokens ?? undefined;
  const cacheReadInputTokens = response.usage?.cache_read_input_tokens ?? undefined;
  const totalTokens = typeof inputTokens === 'number' && typeof outputTokens === 'number'
    ? inputTokens + outputTokens
    : undefined;

  return {
    provider: 'anthropic',
    model: response.model,
    requestId: response.id,
    stopReason: response.stop_reason ?? undefined,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens
    }
  };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  return {
    name: 'anthropic',
    model: options.model,
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

      return normalizeProviderResponse({
        content: readAnthropicTextContent(response.content),
        toolCalls: extractAnthropicToolCalls(response.content),
        metadata: normalizeAnthropicResponseMetadata(response)
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

function isAnthropicToolUseBlock(value: unknown): value is { type: 'tool_use'; id: string; name: string; input: unknown } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'tool_use'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { name?: unknown }).name === 'string'
    && 'input' in value;
}
