import { join } from 'node:path';

import type { Message } from '../core/types.js';
import type { SessionMemoryCheckpointMetadata } from '../memory/sessionMemoryTypes.js';
import type { TranscriptCell } from '../cli/tuiProtocol.js';

export interface InteractiveCheckpointPayload {
  version: 1;
  history: Message[];
  historySummary?: string;
  sessionMemory?: SessionMemoryCheckpointMetadata;
  transcriptCells?: TranscriptCell[];
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

export function getTaskLedgerPath(cwd: string): string {
  return join(cwd, '.qiclaw', 'witness-ledger.jsonl');
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

  if (payload.sessionMemory !== undefined) {
    if (!payload.sessionMemory || typeof payload.sessionMemory !== 'object') {
      return false;
    }

    const sessionMemory = payload.sessionMemory as Record<string, unknown>;
    if (
      typeof sessionMemory.storeSessionId !== 'string'
      || typeof sessionMemory.engine !== 'string'
      || typeof sessionMemory.version !== 'number'
      || typeof sessionMemory.memoryPath !== 'string'
      || typeof sessionMemory.metaPath !== 'string'
      || typeof sessionMemory.totalEntries !== 'number'
    ) {
      return false;
    }

    if (sessionMemory.lastCompactedAt !== null && sessionMemory.lastCompactedAt !== undefined && typeof sessionMemory.lastCompactedAt !== 'string') {
      return false;
    }

    if (sessionMemory.latestSummaryText !== undefined && typeof sessionMemory.latestSummaryText !== 'string') {
      return false;
    }
  }

  if (payload.transcriptCells !== undefined) {
    if (!Array.isArray(payload.transcriptCells) || payload.transcriptCells.some((cell) => !isTranscriptCell(cell))) {
      return false;
    }
  }

  return payload.history.every(isMessage);
}

function isTranscriptCell(value: unknown): value is TranscriptCell {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const cell = value as Record<string, unknown>;
  return typeof cell.id === 'string'
    && isTranscriptCellKind(cell.kind)
    && typeof cell.text === 'string'
    && (cell.title === undefined || typeof cell.title === 'string')
    && (cell.toolName === undefined || typeof cell.toolName === 'string')
    && (cell.isError === undefined || typeof cell.isError === 'boolean');
}

function isTranscriptCellKind(value: unknown): value is TranscriptCell['kind'] {
  return value === 'user'
    || value === 'assistant'
    || value === 'tool'
    || value === 'status'
    || value === 'diff'
    || value === 'shell'
    || value === 'summary';
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

  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls)) {
      return false;
    }

    const hasInvalidToolCall = message.toolCalls.some((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') {
        return true;
      }

      const candidate = toolCall as Record<string, unknown>;
      return typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !('input' in candidate);
    });

    if (hasInvalidToolCall) {
      return false;
    }
  }

  return true;
}
