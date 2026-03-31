import type { Message } from '../core/types.js';
import { buildTelemetryPreview } from './preview.js';

const REDACTED_VALUE = '[REDACTED]';
const PREVIEW_MAX_LENGTH = 512;
const SENSITIVE_KEY_PATTERN = /(key|token|secret|authorization|cookie|password)/i;
const SENSITIVE_STRING_PATTERN = /(authorization\s*:|bearer\s+|api[_-]?key|token|secret|password|cookie)/i;

export interface PromptTelemetry {
  messageCount: number;
  contentBlockCount: number;
  preview: string;
}

function countContentBlocks(content: unknown): number {
  if (typeof content === 'string') {
    return content.length > 0 ? 1 : 0;
  }

  if (Array.isArray(content)) {
    return content.length;
  }

  if (content == null) {
    return 0;
  }

  return 1;
}

function redactTelemetryPreviewValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return SENSITIVE_STRING_PATTERN.test(value) ? REDACTED_VALUE : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactTelemetryPreviewValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactTelemetryPreviewValue(entryValue)
    ])
  );
}

function toPreviewMessage(message: Message): Record<string, unknown> {
  const previewMessage: Record<string, unknown> = {
    role: message.role,
    content: redactTelemetryPreviewValue(message.content)
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
    previewMessage.toolCalls = redactTelemetryPreviewValue(message.toolCalls);
  }

  return previewMessage;
}

export function measurePromptTelemetry(messages: Message[]): PromptTelemetry {
  return {
    messageCount: messages.length,
    contentBlockCount: messages.reduce((total, message) => total + countContentBlocks(message.content), 0),
    preview: buildTelemetryPreview(
      {
        messages: messages.map((message) => toPreviewMessage(message))
      },
      PREVIEW_MAX_LENGTH
    )
  };
}
