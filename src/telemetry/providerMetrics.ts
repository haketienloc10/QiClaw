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
  return {
    role: message.role,
    rawChars: JSON.stringify(message).length,
    contentBlockCount: countContentBlocks(message)
  };
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
    )
  };
}
