import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInput
} from 'openai/resources/responses/responses';

import type { Message } from '../core/types.js';
import { buildTelemetryPreview } from '../telemetry/preview.js';
import {
  redactSensitiveTelemetryPreviewValue,
  redactSensitiveTelemetryValue
} from '../telemetry/redaction.js';
import type { Tool } from '../tools/registry.js';

import {
  normalizeProviderResponse,
  type ModelProvider,
  type ProviderDebugMetadata,
  type ProviderFinishSummary,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResponseMetrics,
  type ProviderUsageSummary,
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

function countOpenAIOutputBlocksByType(output: unknown[]): Record<string, number> {
  return output.reduce<Record<string, number>>((counts, item) => {
    const type = typeof item === 'object' && item !== null && 'type' in item
      ? String((item as { type?: unknown }).type)
      : 'unknown';

    counts[type] = (counts[type] ?? 0) + 1;

    if (type === 'message' && Array.isArray((item as { content?: unknown }).content)) {
      for (const part of (item as { content: unknown[] }).content) {
        const partType = typeof part === 'object' && part !== null && 'type' in part
          ? String((part as { type?: unknown }).type)
          : 'unknown';
        counts[partType] = (counts[partType] ?? 0) + 1;
      }
    }

    return counts;
  }, {});
}

function redactOpenAIOutputForPreview(output: unknown[]): unknown[] {
  return output.map((item) => {
    if (!isOpenAIFunctionCall(item) || typeof item.arguments !== 'string') {
      return redactSensitiveTelemetryPreviewValue(item);
    }

    const redactedItem = redactSensitiveTelemetryPreviewValue(item) as Record<string, unknown>;

    try {
      redactedItem.arguments = JSON.stringify(redactSensitiveTelemetryPreviewValue(JSON.parse(item.arguments)));
    } catch {
      redactedItem.arguments = item.arguments;
    }

    return redactedItem;
  });
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
  output: unknown[];
  incomplete_details?: {
    reason?: string | null;
  } | null;
}): {
  finish: ProviderFinishSummary;
  usage: ProviderUsageSummary;
  responseMetrics: ProviderResponseMetrics;
  debug: ProviderDebugMetadata;
} {
  const toolCalls = extractOpenAIToolCalls(response.output);
  const contentBlocksByType = countOpenAIOutputBlocksByType(response.output);

  return {
    finish: {
      stopReason: response.incomplete_details?.reason ?? undefined
    },
    usage: {
      inputTokens: response.usage?.input_tokens ?? undefined,
      outputTokens: response.usage?.output_tokens ?? undefined,
      totalTokens: response.usage?.total_tokens ?? undefined
    },
    responseMetrics: {
      contentBlockCount: response.output.length,
      toolCallCount: toolCalls.length,
      hasTextOutput: readOpenAITextContent(response.output).length > 0,
      contentBlocksByType
    },
    debug: {
      providerUsageRawRedacted: response.usage ? redactSensitiveTelemetryValue(response.usage) : undefined,
      providerStopDetails: response.incomplete_details
        ? {
            incomplete_details: response.incomplete_details
          }
        : undefined,
      toolCallSummaries: toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name })),
      responseContentBlocksByType: contentBlocksByType,
      responsePreviewRedacted: buildTelemetryPreview(redactOpenAIOutputForPreview(response.output), 400)
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

      const metadata = normalizeOpenAIResponseMetadata(response);

      return normalizeProviderResponse({
        content: readOpenAITextContent(response.output),
        toolCalls: extractOpenAIToolCalls(response.output),
        finish: metadata.finish,
        usage: metadata.usage,
        responseMetrics: metadata.responseMetrics,
        debug: metadata.debug
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
