import type { Message } from '../core/types.js';
import { buildTelemetryPreview } from './preview.js';
import { redactSensitiveTelemetryValue } from './redaction.js';

const REDACTED_VALUE = '[REDACTED]';
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

function redactMessageContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return SENSITIVE_STRING_PATTERN.test(content) ? REDACTED_VALUE : content;
  }

  return redactSensitiveTelemetryValue(content);
}

function toPreviewMessage(message: Message): Record<string, unknown> {
  const previewMessage: Record<string, unknown> = {
    role: message.role,
    content: redactMessageContent(message.content)
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
    previewMessage.toolCalls = redactSensitiveTelemetryValue(message.toolCalls);
  }

  return previewMessage;
}

export function measurePromptTelemetry(messages: Message[]): PromptTelemetry {
  return {
    messageCount: messages.length,
    contentBlockCount: messages.reduce(
      (total, message) => total + countContentBlocks(message.content) + (message.toolCalls?.length ?? 0),
      0
    ),
    preview: buildTelemetryPreview(
      {
        messages: messages.map((message) => toPreviewMessage(message))
      },
      Number.MAX_SAFE_INTEGER
    )
  };
}
