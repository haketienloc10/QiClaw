import { join } from 'node:path';

import type { Message } from '../core/types.js';

export interface InteractiveCheckpointPayload {
  version: 1;
  history: Message[];
  historySummary?: string;
}

export function createSessionId() {
  return `session_${Date.now()}`;
}

export function createInteractiveCheckpointJson(payload: InteractiveCheckpointPayload): string {
  return JSON.stringify(payload);
}

export function parseInteractiveCheckpointJson(checkpointJson: string): InteractiveCheckpointPayload | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(checkpointJson);
  } catch {
    return undefined;
  }

  if (!isInteractiveCheckpointPayload(parsed)) {
    return undefined;
  }

  return parsed;
}

export function getCheckpointStorePath(cwd: string): string {
  return join(cwd, '.qiclaw', 'checkpoint.sqlite');
}

function isInteractiveCheckpointPayload(value: unknown): value is InteractiveCheckpointPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Record<string, unknown>;

  if (payload.version !== 1 || !Array.isArray(payload.history)) {
    return false;
  }

  if (payload.historySummary !== undefined && typeof payload.historySummary !== 'string') {
    return false;
  }

  return payload.history.every(isMessage);
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Record<string, unknown>;

  if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
    return false;
  }

  if (typeof message.content !== 'string') {
    return false;
  }

  if (message.role === 'tool') {
    return (
      typeof message.name === 'string' &&
      typeof message.toolCallId === 'string' &&
      typeof message.isError === 'boolean'
    );
  }

  if (message.name !== undefined && typeof message.name !== 'string') {
    return false;
  }

  if (message.toolCallId !== undefined && typeof message.toolCallId !== 'string') {
    return false;
  }

  if (message.isError !== undefined && typeof message.isError !== 'boolean') {
    return false;
  }

  return true;
}
