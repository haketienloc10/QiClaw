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
  const recentMessages = recentMessageCount === 0 ? [] : history.slice(-recentMessageCount);
  const olderMessages = recentMessageCount === 0 ? history.slice() : history.slice(0, -recentMessageCount);
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

function getMessagesCharCount(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
