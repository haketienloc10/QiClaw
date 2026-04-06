import type { Message } from '../core/types.js';
import { compactHistoryMessages } from './compactor.js';

export interface HistoryPrunerOptions {
  recentMessageCount: number;
  oldHistoryBudgetChars: number;
  summaryMaxLines: number;
  summaryMaxChars: number;
  summarySnippetLength: number;
}

export interface HistoryPruneResult {
  messages: Message[];
  summary: string;
  didCompact: boolean;
}

export function pruneHistoryForContext(history: Message[], options: HistoryPrunerOptions): HistoryPruneResult {
  const recentMessageCount = Math.max(0, Math.floor(options.recentMessageCount));
  const recentStartIndex = findSafeRecentStartIndex(history, recentMessageCount);
  const recentMessages = history.slice(recentStartIndex);
  const olderMessages = history.slice(0, recentStartIndex);
  const olderChars = getMessagesCharCount(olderMessages);

  if (olderMessages.length === 0) {
    return {
      messages: history,
      summary: '',
      didCompact: false
    };
  }

  if (olderChars <= options.oldHistoryBudgetChars) {
    return {
      messages: history,
      summary: '',
      didCompact: false
    };
  }

  const summary = compactHistoryMessages(olderMessages, {
    maxLines: options.summaryMaxLines,
    maxChars: options.summaryMaxChars,
    snippetLength: options.summarySnippetLength
  });

  return {
    summary,
    didCompact: true,
    messages: recentMessages
  };
}

function findSafeRecentStartIndex(history: Message[], recentMessageCount: number): number {
  if (recentMessageCount === 0) {
    return history.length;
  }

  let startIndex = Math.max(0, history.length - recentMessageCount);
  while (startIndex > 0 && isOrphanedToolResultAt(history, startIndex)) {
    startIndex -= 1;
  }

  return startIndex;
}

function isOrphanedToolResultAt(history: Message[], startIndex: number): boolean {
  const message = history[startIndex];
  if (message?.role !== 'tool' || !message.toolCallId) {
    return false;
  }

  return !history.slice(startIndex).some((candidate) => hasToolCall(candidate, message.toolCallId));
}

function hasToolCall(message: Message, toolCallId: string): boolean {
  return message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.some((toolCall) => toolCall.id === toolCallId);
}

function getMessagesCharCount(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
