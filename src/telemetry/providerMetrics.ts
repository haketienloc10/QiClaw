import type { Message } from '../core/types.js';
import type { ProviderCalledMessageSummary } from './observer.js';
import { buildTelemetryPreview } from './preview.js';
import { redactSensitiveTelemetryPreviewValue } from './redaction.js';

const PREVIEW_MAX_LENGTH = 512;

export interface PromptTelemetry {
  promptRawChars: number;
  messageSummaries: ProviderCalledMessageSummary[];
  totalContentBlockCount: number;
  hasSystemPrompt: boolean;
  promptRawPreviewRedacted: string;
  toolMessagesCount: number;
  assistantToolCallsCount: number;
  systemMessageChars: number;
  userMessageChars: number;
  assistantTextChars: number;
  assistantToolCallChars: number;
  toolResultChars: number;
}

function countContentBlocks(message: Message): number {
  const contentBlockCount = message.content.length > 0 ? 1 : 0;
  const toolCallCount = Array.isArray(message.toolCalls) ? message.toolCalls.length : 0;

  return contentBlockCount + toolCallCount;
}

function buildPromptPreviewMessage(message: Message): Record<string, unknown> {
  const previewMessage: Record<string, unknown> = {
    role: message.role,
    content: redactSensitiveTelemetryPreviewValue(message.content)
  };

  if (message.name) {
    previewMessage.name = message.name;
  }

  if (message.toolCallId) {
    previewMessage.toolCallId = message.toolCallId;
  }

  if (typeof message.isError === 'boolean') {
    previewMessage.isError = message.isError;
  }

  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    previewMessage.toolCalls = redactSensitiveTelemetryPreviewValue(message.toolCalls);
  }

  return previewMessage;
}

function measurePromptMessage(message: Message): ProviderCalledMessageSummary {
  const toolCallCount = Array.isArray(message.toolCalls) ? message.toolCalls.length : 0;

  return {
    role: message.role,
    rawChars: JSON.stringify(message).length,
    contentBlockCount: countContentBlocks(message),
    messageSource: getMessageSource(message),
    toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
    toolName: message.role === 'tool' ? message.name : undefined,
    toolCallId: message.role === 'tool' ? message.toolCallId : undefined,
    isError: message.role === 'tool' ? message.isError : undefined
  };
}

function getMessageSource(message: Message): ProviderCalledMessageSummary['messageSource'] {
  switch (message.role) {
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    case 'tool':
      return 'tool_result';
    case 'assistant':
      return Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? 'assistant_tool_call' : 'assistant_text';
  }
}

export function measurePromptTelemetry(messages: Message[]): PromptTelemetry {
  const messageSummaries = messages.map((message) => measurePromptMessage(message));

  return {
    promptRawChars: JSON.stringify(messages).length,
    messageSummaries,
    totalContentBlockCount: messageSummaries.reduce((total, message) => total + message.contentBlockCount, 0),
    hasSystemPrompt: messages.some((message) => message.role === 'system' && message.content.trim().length > 0),
    promptRawPreviewRedacted: buildTelemetryPreview(
      {
        messages: messages.map((message) => buildPromptPreviewMessage(message))
      },
      PREVIEW_MAX_LENGTH
    ),
    toolMessagesCount: messages.filter((message) => message.role === 'tool').length,
    assistantToolCallsCount: messages.reduce(
      (count, message) => count + (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0),
      0
    ),
    systemMessageChars: sumMessageCharsBySource(messageSummaries, 'system'),
    userMessageChars: sumMessageCharsBySource(messageSummaries, 'user'),
    assistantTextChars: sumMessageCharsBySource(messageSummaries, 'assistant_text'),
    assistantToolCallChars: sumMessageCharsBySource(messageSummaries, 'assistant_tool_call'),
    toolResultChars: sumMessageCharsBySource(messageSummaries, 'tool_result')
  };
}

function sumMessageCharsBySource(
  messageSummaries: ProviderCalledMessageSummary[],
  source: ProviderCalledMessageSummary['messageSource']
): number {
  return messageSummaries
    .filter((message) => message.messageSource === source)
    .reduce((total, message) => total + message.rawChars, 0);
}
