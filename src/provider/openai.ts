import OpenAI from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent
} from 'openai/resources/responses/responses';

import type { Message } from '../core/types.js';
import { buildTelemetryPreview } from '../telemetry/preview.js';
import {
  redactSensitiveTelemetryPreviewValue,
  redactSensitiveTelemetryValue
} from '../telemetry/redaction.js';
import type { Tool } from '../tools/registry.js';

import {
  collectProviderStream,
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

export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  createClient?: () => OpenAI;
}

export interface BuildOpenAIResponsesRequestInput {
  model: string;
  messages: Message[];
  availableTools: Tool[];
  stream?: boolean;
}

export function getOpenAIApiKey(apiKeyOverride?: string): string {
  const apiKey = apiKeyOverride ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable.');
  }

  return apiKey;
}

function createOpenAIClient(options: OpenAIProviderOptions): OpenAI {
  return options.createClient?.() ?? new OpenAI({
    apiKey: getOpenAIApiKey(options.apiKey),
    baseURL: options.baseUrl
  });
}

export function buildOpenAIResponsesRequest(
  input: BuildOpenAIResponsesRequestInput
): ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming {
  const { instructions, conversation } = splitSystemPrompt(input.messages);

  return {
    model: input.model,
    stream: input.stream ?? false,
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

export interface OpenAIResponsePayload {
  id: string;
  model: string;
  status?: string | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    prompt_tokens_details?: {
      cached_tokens?: number | null;
    } | null;
  } | null;
  output: unknown[];
  incomplete_details?: {
    reason?: string | null;
  } | null;
}

export function normalizeOpenAIResponseMetadata(response: OpenAIResponsePayload): {
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
      totalTokens: response.usage?.total_tokens ?? undefined,
      cacheReadInputTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? undefined
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

export function toOpenAINormalizedEventsFromResponse(response: OpenAIResponsePayload): NormalizedEvent[] {
  const metadata = normalizeOpenAIResponseMetadata(response);
  const events: NormalizedEvent[] = [
    { type: 'start', provider: 'openai', model: response.model }
  ];

  const text = readOpenAITextContent(response.output);
  if (text.length > 0) {
    events.push({ type: 'text_delta', text });
  }

  for (const toolCall of extractOpenAIToolCalls(response.output)) {
    events.push({
      type: 'tool_call',
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input
    });
  }

  events.push({
    type: 'finish',
    finish: metadata.finish,
    usage: metadata.usage,
    responseMetrics: metadata.responseMetrics,
    debug: metadata.debug
  });

  return events;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  return {
    name: 'openai',
    model: options.model,
    async *stream(request: ProviderRequest): AsyncIterable<NormalizedEvent> {
      const client = createOpenAIClient(options);
      const stream = await client.responses.create(buildOpenAIResponsesRequest({
        model: options.model,
        messages: request.messages,
        availableTools: request.availableTools,
        stream: true
      })) as AsyncIterable<ResponseStreamEvent>;

      let sawStart = false;
      let completedResponse: Response | undefined;
      const emittedToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

      for await (const event of stream) {
        switch (event.type) {
          case 'response.created':
            if (!sawStart) {
              sawStart = true;
              yield {
                type: 'start',
                provider: 'openai',
                model: event.response.model
              };
            }
            break;
          case 'response.output_text.delta':
            if (event.delta) {
              yield { type: 'text_delta', text: event.delta };
            }
            break;
          case 'response.output_item.done':
            if (event.item.type === 'function_call' && !emittedToolCalls.has(event.item.call_id)) {
              const input = parseOpenAIToolArguments(event.item.name, event.item.arguments);
              emittedToolCalls.set(event.item.call_id, {
                name: event.item.name,
                input
              });
              yield {
                type: 'tool_call',
                id: event.item.call_id,
                name: event.item.name,
                input
              };
            }
            break;
          case 'response.failed': {
            const statusDetail = event.response.status ? `: ${event.response.status}` : '.';
            yield {
              type: 'error',
              error: new Error(`OpenAI response stream failed${statusDetail}`)
            };
            return;
          }
          case 'response.incomplete':
            completedResponse = event.response;
            break;
          case 'response.completed':
            completedResponse = event.response;
            break;
          default:
            if (!isIgnorableOpenAIResponseStreamEvent(event.type)) {
              throw new Error(`Unsupported OpenAI response stream event: ${event.type}`);
            }
        }
      }

      if (!completedResponse) {
        throw new Error('OpenAI stream ended without response.completed event.');
      }

      for (const event of toOpenAINormalizedEventsFromResponse(completedResponse)) {
        if (event.type === 'start') {
          if (!sawStart) {
            yield event;
          }
          continue;
        }

        if (event.type === 'text_delta') {
          continue;
        }

        if (event.type === 'tool_call') {
          const emittedToolCall = emittedToolCalls.get(event.id);
          if (!emittedToolCall) {
            yield event;
            continue;
          }

          if (emittedToolCall.name !== event.name || !areToolCallInputsEqual(emittedToolCall.input, event.input)) {
            throw new Error(`OpenAI stream completed with mismatched tool_call for call_id ${event.id}.`);
          }

          continue;
        }

        yield event;
      }
    },
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      return collectProviderStream(this.stream!(request));
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

function areToolCallInputsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isIgnorableOpenAIResponseStreamEvent(eventType: ResponseStreamEvent['type']): boolean {
  return eventType === 'response.queued'
    || eventType === 'response.in_progress'
    || eventType === 'response.output_text.done'
    || eventType === 'response.function_call_arguments.delta'
    || eventType === 'response.function_call_arguments.done'
    || eventType === 'response.content_part.added'
    || eventType === 'response.content_part.done'
    || eventType === 'response.output_item.added'
    || eventType === 'response.refusal.delta'
    || eventType === 'response.refusal.done'
    || eventType === 'response.reasoning_text.delta'
    || eventType === 'response.reasoning_text.done'
    || eventType === 'response.reasoning_summary_part.added'
    || eventType === 'response.reasoning_summary_part.done'
    || eventType === 'response.reasoning_summary_text.delta'
    || eventType === 'response.reasoning_summary_text.done'
    || eventType === 'response.output_text.annotation.added'
    || eventType.endsWith('.in_progress')
    || eventType.endsWith('.searching')
    || eventType.endsWith('.generating')
    || eventType.endsWith('.interpreting')
    || eventType.endsWith('.delta')
    || eventType.endsWith('.done')
    || eventType.endsWith('.completed');
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
