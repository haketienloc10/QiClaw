import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInput
} from 'openai/resources/responses/responses';

import type { Message } from '../core/types.js';
import type { Tool } from '../tools/registry.js';

import {
  normalizeProviderResponse,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResponseMetadata,
  type ToolCallRequest
} from './model.js';

export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface BuildOpenAIResponsesRequestInput {
  model: string;
  messages: Message[];
  availableTools: Tool[];
}

export function getOpenAIApiKey(apiKeyOverride?: string): string {
  const apiKey = apiKeyOverride ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable.');
  }

  return apiKey;
}

export function buildOpenAIResponsesRequest(
  input: BuildOpenAIResponsesRequestInput
): ResponseCreateParamsNonStreaming {
  const { instructions, conversation } = splitSystemPrompt(input.messages);

  return {
    model: input.model,
    stream: false,
    instructions,
    input: conversation,
    tools: input.availableTools.map(toOpenAIFunctionTool)
  };
}

export function readOpenAITextContent(output: unknown[]): string {
  return output
    .flatMap((item) => {
      if (!isOpenAIOutputMessage(item)) {
        return [];
      }

      return item.content
        .filter(isOpenAIOutputText)
        .map((part) => part.text);
    })
    .join('');
}

export function extractOpenAIToolCalls(output: unknown[]): ToolCallRequest[] {
  return output
    .filter(isOpenAIFunctionCall)
    .map((item) => ({
      id: item.call_id,
      name: item.name,
      input: parseOpenAIToolArguments(item.name, item.arguments)
    }));
}

export function normalizeOpenAIResponseMetadata(response: {
  id: string;
  model: string;
  status?: string | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
}): ProviderResponseMetadata {
  return {
    provider: 'openai',
    model: response.model,
    requestId: response.id,
    stopReason: response.status === 'incomplete' ? response.status : undefined,
    usage: {
      inputTokens: response.usage?.input_tokens ?? undefined,
      outputTokens: response.usage?.output_tokens ?? undefined,
      totalTokens: response.usage?.total_tokens ?? undefined
    }
  };
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  return {
    name: 'openai',
    model: options.model,
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const client = new OpenAI({
        apiKey: getOpenAIApiKey(options.apiKey),
        baseURL: options.baseUrl
      });
      const response: Response = await client.responses.create(buildOpenAIResponsesRequest({
        model: options.model,
        messages: request.messages,
        availableTools: request.availableTools
      }));

      return normalizeProviderResponse({
        content: readOpenAITextContent(response.output),
        toolCalls: extractOpenAIToolCalls(response.output),
        metadata: normalizeOpenAIResponseMetadata(response)
      });
    }
  };
}

function splitSystemPrompt(messages: Message[]): { instructions: string | undefined; conversation: ResponseInput } {
  const systemMessages = messages.filter((message) => message.role === 'system').map((message) => message.content);
  const instructions = systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined;

  const conversation = messages.flatMap<ResponseInput[number]>((message) => {
    if (message.role === 'system') {
      return [];
    }

    if (message.role === 'tool') {
      if (!message.toolCallId) {
        throw new Error(`Tool message for ${message.name ?? 'unknown'} is missing toolCallId.`);
      }

      return [
        {
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: message.content
        }
      ];
    }

    const conversationItems: ResponseInput = [
      message.role === 'assistant'
        ? {
            type: 'message',
            role: 'assistant',
            content: message.content
          }
        : {
            type: 'message',
            role: message.role,
            content: [
              {
                type: 'input_text',
                text: message.content
              }
            ]
          }
    ];

    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      conversationItems.push(
        ...message.toolCalls.map((toolCall) => ({
          type: 'function_call' as const,
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input)
        }))
      );
    }

    return conversationItems;
  });

  return { instructions, conversation };
}

function toOpenAIFunctionTool(tool: Tool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: usesStrictOpenAIToolSchema(tool.inputSchema)
  };
}

function usesStrictOpenAIToolSchema(inputSchema: Tool['inputSchema']): boolean {
  const propertyNames = Object.keys(inputSchema.properties);
  const requiredNames = inputSchema.required ?? [];

  return propertyNames.every((name) => requiredNames.includes(name));
}

function parseOpenAIToolArguments(toolName: string, argumentsValue: unknown): Record<string, unknown> {
  const parsedValue = parseOpenAIToolArgumentsValue(toolName, argumentsValue);

  if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) {
    throw new Error(`OpenAI function_call arguments for ${toolName} must parse to a non-null object.`);
  }

  return parsedValue as Record<string, unknown>;
}

function parseOpenAIToolArgumentsValue(toolName: string, argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== 'string') {
    return argumentsValue;
  }

  try {
    return JSON.parse(argumentsValue);
  } catch {
    throw new Error(`OpenAI function_call arguments for ${toolName} must be valid JSON.`);
  }
}

function isOpenAIOutputMessage(value: unknown): value is { type: 'message'; role: 'assistant'; content: unknown[] } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'message'
    && (value as { role?: unknown }).role === 'assistant'
    && Array.isArray((value as { content?: unknown }).content);
}

function isOpenAIOutputText(value: unknown): value is { type: 'output_text'; text: string } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'output_text'
    && typeof (value as { text?: unknown }).text === 'string';
}

function isOpenAIFunctionCall(value: unknown): value is { type: 'function_call'; call_id: string; name: string; arguments: unknown } {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'function_call'
    && typeof (value as { call_id?: unknown }).call_id === 'string'
    && typeof (value as { name?: unknown }).name === 'string'
    && 'arguments' in value;
}
