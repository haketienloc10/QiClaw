import type { Message } from '../core/types.js';
import { createSessionMemoryHash } from './hash.js';
import type { SessionMemoryEntry, SessionMemoryType } from './sessionMemoryTypes.js';

export interface BuildInteractiveTurnMemoryEntryInput {
  sessionId: string;
  userInput: string;
  finalAnswer: string;
  history?: Message[];
  sourceTurnId?: string;
  now?: string;
}

export function buildInteractiveTurnMemoryEntry(
  input: BuildInteractiveTurnMemoryEntryInput
): SessionMemoryEntry | undefined {
  const trimmedUserInput = normalizeWhitespace(input.userInput);
  const trimmedFinalAnswer = normalizeWhitespace(input.finalAnswer);
  const now = input.now ?? new Date().toISOString();

  if (trimmedFinalAnswer.length === 0) {
    return undefined;
  }

  if (isExplicitSaveRequest(trimmedUserInput)) {
    const statement = extractMemoryStatement(trimmedUserInput);
    return createEntry({
      sessionId: input.sessionId,
      memoryType: 'fact',
      summaryText: statement,
      essenceText: statement,
      fullText: `User asked to remember: ${statement}\nAssistant confirmed: ${trimmedFinalAnswer}`,
      sourceTurnId: input.sourceTurnId,
      createdAt: now,
      importance: 0.9,
      explicitSave: true
    });
  }

  const procedureEntry = buildProcedureMemoryEntry({
    sessionId: input.sessionId,
    userInput: trimmedUserInput,
    finalAnswer: trimmedFinalAnswer,
    history: input.history,
    sourceTurnId: input.sourceTurnId,
    now
  });

  if (procedureEntry) {
    return procedureEntry;
  }

  return buildFailureMemoryEntry({
    sessionId: input.sessionId,
    finalAnswer: trimmedFinalAnswer,
    history: input.history,
    sourceTurnId: input.sourceTurnId,
    now
  });
}

const PROCEDURE_CAPTURE_PATTERN = /(?:\b(?:use|run|read|check|open|inspect|query|call)\b|\bdùng\b|sử\s+dụng|\bchạy\b|đọc|kiểm\s+tra|\bmở\b|\bxem\b|truy\s+vấn|\bgọi\b)/iu;
const RECOVERY_CAPTURE_PATTERN = /(?:\b(?:retry|rerun|re-run|switch|use|check|fix|try)\b|thử\s+lại|chạy\s+lại|kiểm\s+tra\s+lại|đổi\s+sang|\bdùng\b|\bsửa\b|\bthử\b)/iu;
const EXPLICIT_SAVE_COMMAND_PATTERN = /^(?:please\s+)?(?:(?:remember|save)\s+(?:that\s+)?)\S|^(?:hãy\s+)?(?:(?:ghi\s+nhớ|nhớ|lưu)\s+(?:(?:rằng|là)\s+)?)\S/iu;

export function shouldCapture(memoryEntry: SessionMemoryEntry): boolean {
  const summaryLength = memoryEntry.summaryText.trim().length;
  const essenceLength = memoryEntry.essenceText.trim().length;

  if (summaryLength < 12 || summaryLength > 220 || essenceLength === 0 || essenceLength > 160) {
    return false;
  }

  if (memoryEntry.explicitSave) {
    return memoryEntry.memoryType === 'fact';
  }

  if (memoryEntry.memoryType === 'procedure') {
    return memoryEntry.importance >= 0.72
      && memoryEntry.tags.length >= 1
      && PROCEDURE_CAPTURE_PATTERN.test(memoryEntry.summaryText);
  }

  if (memoryEntry.memoryType === 'failure') {
    return memoryEntry.importance >= 0.78
      && RECOVERY_CAPTURE_PATTERN.test(memoryEntry.summaryText);
  }

  return false;
}

function buildProcedureMemoryEntry(input: {
  sessionId: string;
  userInput: string;
  finalAnswer: string;
  history?: Message[];
  sourceTurnId?: string;
  now: string;
}): SessionMemoryEntry | undefined {
  const turnHistory = extractCurrentTurnHistory(input.history, input.userInput, input.finalAnswer);
  const successfulTool = findLatestToolMessage(turnHistory, false);

  if (!successfulTool || !isConciseConclusion(input.finalAnswer)) {
    return undefined;
  }

  const toolCall = findMatchingToolCall(turnHistory, successfulTool.toolCallId);
  const toolAction = summarizeToolAction(successfulTool.name, toolCall?.input);
  const conclusion = sanitizeSentence(input.finalAnswer, 120);

  if (!toolAction || conclusion.length === 0) {
    return undefined;
  }

  const summaryText = sanitizeSentence(`${toolAction} to ${inferGoal(input.userInput, conclusion)}.`, 180);
  const essenceText = sanitizeSentence(`${toolAction} -> ${conclusion}`, 140);
  const toolResultPreview = sanitizeSentence(successfulTool.content, 120);

  return createEntry({
    sessionId: input.sessionId,
    memoryType: 'procedure',
    summaryText,
    essenceText,
    fullText: [
      `User asked: ${input.userInput}`,
      `Successful tool: ${toolAction}`,
      toolResultPreview.length > 0 ? `Tool result: ${toolResultPreview}` : undefined,
      `Conclusion: ${conclusion}`
    ].filter(isPresent).join('\n'),
    sourceTurnId: input.sourceTurnId,
    createdAt: input.now,
    importance: 0.78,
    explicitSave: false,
    tags: extractTags(`${toolAction} ${conclusion}`)
  });
}

function buildFailureMemoryEntry(input: {
  sessionId: string;
  finalAnswer: string;
  history?: Message[];
  sourceTurnId?: string;
  now: string;
}): SessionMemoryEntry | undefined {
  const turnHistory = extractCurrentTurnHistory(input.history, undefined, input.finalAnswer);
  const failedTool = findLatestToolMessage(turnHistory, true);
  const recovery = extractRecoveryGuidance(input.finalAnswer);

  if (!failedTool || recovery.length === 0) {
    return undefined;
  }

  const toolAction = summarizeToolAction(failedTool.name, findMatchingToolCall(turnHistory, failedTool.toolCallId)?.input);
  const summaryText = sanitizeSentence(`${toolAction} failed; ${recovery}`, 180);
  const essenceText = sanitizeSentence(`${failedTool.name} failed -> ${recovery}`, 140);

  return createEntry({
    sessionId: input.sessionId,
    memoryType: 'failure',
    summaryText,
    essenceText,
    fullText: `Tool failure: ${failedTool.content}\nRecovery: ${recovery}`,
    sourceTurnId: input.sourceTurnId,
    createdAt: input.now,
    importance: 0.8,
    explicitSave: false,
    tags: extractTags(`${toolAction} ${recovery} failure`)
  });
}

function createEntry(input: {
  sessionId: string;
  memoryType: SessionMemoryType;
  summaryText: string;
  essenceText: string;
  fullText: string;
  sourceTurnId?: string;
  createdAt: string;
  importance: number;
  explicitSave: boolean;
  tags?: string[];
}): SessionMemoryEntry {
  const summaryText = normalizeWhitespace(input.summaryText);
  const essenceText = normalizeWhitespace(input.essenceText);
  const fullText = normalizeWhitespace(input.fullText.replace(/\n/gu, ' \n ')).replace(/ \n /gu, '\n');

  return {
    hash: createSessionMemoryHash(`${input.sessionId}\n${input.memoryType}\n${summaryText}\n${essenceText}`),
    sessionId: input.sessionId,
    memoryType: input.memoryType,
    fullText,
    summaryText,
    essenceText,
    tags: input.tags ?? extractTags(`${summaryText} ${essenceText}`),
    source: 'interactive-cli',
    sourceTurnId: input.sourceTurnId,
    createdAt: input.createdAt,
    lastAccessed: input.createdAt,
    accessCount: 0,
    importance: input.importance,
    explicitSave: input.explicitSave
  };
}

function extractCurrentTurnHistory(
  history: Message[] | undefined,
  userInput: string | undefined,
  finalAnswer: string
): Message[] | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }

  const normalizedFinalAnswer = normalizeWhitespace(finalAnswer);

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];

    if (message.role === 'user' && (!userInput || normalizeWhitespace(message.content) === userInput)) {
      const turnHistory = history.slice(index);
      const lastAssistantMessage = [...turnHistory].reverse().find((candidate) => candidate.role === 'assistant');

      if (!lastAssistantMessage || normalizeWhitespace(lastAssistantMessage.content) !== normalizedFinalAnswer) {
        return undefined;
      }

      return turnHistory;
    }
  }

  return undefined;
}

function findLatestToolMessage(history: Message[] | undefined, isError: boolean): (Message & { role: 'tool'; name: string; toolCallId: string }) | undefined {
  if (!history) {
    return undefined;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];

    if (message.role === 'tool' && message.name && message.toolCallId && Boolean(message.isError) === isError) {
      return message as Message & { role: 'tool'; name: string; toolCallId: string };
    }
  }

  return undefined;
}

function findMatchingToolCall(history: Message[] | undefined, toolCallId: string | undefined): { id: string; name: string; input: unknown } | undefined {
  if (!history || !toolCallId) {
    return undefined;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const toolCall = message.toolCalls?.find((candidate) => candidate.id === toolCallId);

    if (toolCall) {
      return toolCall;
    }
  }

  return undefined;
}

function isExplicitSaveRequest(input: string): boolean {
  return EXPLICIT_SAVE_COMMAND_PATTERN.test(input);
}

function extractMemoryStatement(input: string): string {
  const withoutCommand = input
    .replace(/^\s*(?:please\s+)?(?:remember|save)\b[:\s-]*/iu, '')
    .replace(/^\s*(?:hãy\s+)?(?:ghi\s+nhớ|nhớ|lưu)(?:\s+(?:rằng|là))?[:\s-]*/iu, '');
  const normalized = normalizeWhitespace(withoutCommand);
  return normalized.length > 0 ? normalized : input;
}

function summarizeToolAction(toolName: string, toolInput: unknown): string {
  const subject = summarizeToolInput(toolInput);
  return subject.length > 0 ? `${toolName} ${subject}` : `use ${toolName}`;
}

function summarizeToolInput(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') {
    return '';
  }

  const record = toolInput as Record<string, unknown>;
  const filePath = firstString(record.file_path, record.path, record.notebook_path);

  if (filePath) {
    const basename = filePath.split(/[\\/]/u).filter(Boolean).at(-1);
    return basename ? `on ${basename}` : `on ${filePath}`;
  }

  const query = firstString(record.pattern, record.query, record.command);
  if (query) {
    return `with ${sanitizeSentence(query, 40)}`;
  }

  return '';
}

function inferGoal(userInput: string, conclusion: string): string {
  const normalizedUserInput = userInput.toLowerCase();

  if (/\bversion\b|phiên\s+bản/u.test(normalizedUserInput)) {
    return `confirm ${conclusion}`;
  }

  if (/\b(test|tests)\b|kiểm\s+thử/u.test(normalizedUserInput)) {
    return `check test output: ${conclusion}`;
  }

  if (/\b(build|compile)\b|biên\s+dịch/u.test(normalizedUserInput)) {
    return `check build status: ${conclusion}`;
  }

  return conclusion;
}

function extractRecoveryGuidance(finalAnswer: string): string {
  const normalized = normalizeWhitespace(finalAnswer);
  const match = normalized.match(/(?:\b(?:retry|rerun|re-run|switch|use|check|fix|try)\b|thử\s+lại|chạy\s+lại|kiểm\s+tra\s+lại|đổi\s+sang|\bdùng\b|\bsửa\b|\bthử\b)[^.!?]{0,120}[.!?]?/iu);
  return sanitizeSentence(match?.[0] ?? '', 120);
}

function isConciseConclusion(finalAnswer: string): boolean {
  return finalAnswer.length >= 12 && finalAnswer.length <= 160 && !/\n/u.test(finalAnswer);
}

function sanitizeSentence(value: string, maxLength: number): string {
  const normalized = normalizeWhitespace(value).replace(/[\r\n]+/gu, ' ');

  if (normalized.length <= maxLength) {
    return normalized.replace(/[.!?]+$/u, '');
  }

  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd().replace(/[.,;:!?-]+$/u, '');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function extractTags(value: string): string[] {
  return Array.from(value.toLowerCase().matchAll(/[\p{L}\p{N}.]+/gu), (match) => match[0])
    .filter((token) => token.length >= 4)
    .slice(0, 6);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
