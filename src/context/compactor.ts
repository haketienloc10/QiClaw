import type { Message } from '../core/types.js';

export interface CompactHistoryOptions {
  maxLines: number;
  maxChars: number;
  snippetLength: number;
}

export function compactHistoryMessages(messages: Message[], options: CompactHistoryOptions): string {
  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const snippetLength = Math.max(1, Math.floor(options.snippetLength));
  const toolEvidenceIndex = findLastToolEvidenceIndex(messages);
  const lineSlots = Math.max(0, maxLines - 1);
  const reservedToolSlot = toolEvidenceIndex >= 0 && lineSlots > 0 ? 1 : 0;
  const leadingSlots = Math.max(0, lineSlots - reservedToolSlot);
  const leadingMessages = leadingSlots === 0 ? [] : messages.slice(0, leadingSlots);
  const summaryMessages = toolEvidenceIndex >= 0
    ? [...leadingMessages, messages[toolEvidenceIndex]].filter((entry, index, items) => items.indexOf(entry) === index)
    : leadingMessages;
  const header = clampText('History summary:', maxChars);
  const lines = [header];
  let currentLength = header.length;

  if (currentLength >= maxChars) {
    return header;
  }

  for (const entry of summaryMessages) {
    if (lines.length >= maxLines) {
      break;
    }

    const line = summarizeMessage(entry, snippetLength);
    const remainingChars = maxChars - currentLength - 1;

    if (remainingChars <= 0) {
      break;
    }

    lines.push(clampText(line, remainingChars));
    currentLength += 1 + lines[lines.length - 1].length;
  }

  return lines.join('\n');
}

function summarizeMessage(message: Message, snippetLength: number): string {
  const roleLabel = message.role === 'tool' && message.name ? `tool(${message.name})` : message.role;
  return `- ${roleLabel}: ${truncateText(normalizeContent(message.content), snippetLength)}`;
}

function findLastToolEvidenceIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isToolEvidence(messages[index])) {
      return index;
    }
  }

  return -1;
}

function isToolEvidence(message: Message): boolean {
  return message.role === 'tool' || (message.role === 'assistant' && /\btool call\b/i.test(message.content));
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length < maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 2)).trimEnd()}…`;
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 1) {
    return '…';
  }

  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}
