import type { TurnEvent } from '../agent/loop.js';
import type { Message } from '../core/types.js';
import { formatToolActivityLabel } from '../tools/registry.js';
import type { HostEvent, TranscriptCell } from './tuiProtocol.js';

export function createTranscriptSeed(history: Message[], historySummary?: string): TranscriptCell[] {
  const cells = history.map((message, index) => mapMessageToCell(message, index + 1));

  if (historySummary && historySummary.trim().length > 0) {
    cells.push({
      id: `summary-${cells.length + 1}`,
      kind: 'summary',
      title: 'History summary',
      text: historySummary
    });
  }

  return cells;
}

export function mapTurnEventToBridgeEvent(
  event: TurnEvent,
  state: { turnOrdinal: number; assistantMessageOrdinal: number }
): HostEvent | undefined {
  const turnId = `turn-${state.turnOrdinal}`;
  const messageId = `assistant-${state.assistantMessageOrdinal}`;

  if (event.type === 'assistant_text_delta') {
    return { type: 'assistant_delta', turnId, messageId, text: event.text };
  }

  if (event.type === 'assistant_message_completed') {
    return { type: 'assistant_completed', turnId, messageId, text: event.text };
  }

  if (event.type === 'tool_call_started') {
    return {
      type: 'tool_started',
      turnId,
      toolCallId: event.id,
      toolName: event.name,
      label: formatToolActivityLabel(event.name, event.input) ?? event.name
    };
  }

  if (event.type === 'tool_call_completed') {
    return {
      type: 'tool_completed',
      turnId,
      toolCallId: event.id,
      toolName: event.name,
      status: event.isError ? 'error' : 'success',
      resultPreview: event.resultPreview,
      durationMs: event.durationMs
    };
  }

  if (event.type === 'turn_failed') {
    return {
      type: 'error',
      text: event.error instanceof Error ? event.error.message : String(event.error)
    };
  }

  if (event.type === 'turn_completed') {
    return {
      type: 'turn_completed',
      turnId,
      stopReason: event.stopReason,
      finalAnswer: event.finalAnswer
    };
  }

  return undefined;
}

function mapMessageToCell(message: Message, index: number): TranscriptCell {
  if (message.role === 'user') {
    return { id: `user-${index}`, kind: 'user', text: message.content };
  }

  if (message.role === 'assistant') {
    return { id: `assistant-${index}`, kind: 'assistant', text: message.content };
  }

  return {
    id: `tool-${index}`,
    kind: 'tool',
    text: message.content,
    title: message.name,
    toolName: message.name,
    isError: message.isError
  };
}
