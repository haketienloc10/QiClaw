export type TranscriptCellKind = 'user' | 'assistant' | 'tool' | 'status' | 'diff' | 'shell' | 'summary';

export interface TranscriptCell {
  id: string;
  kind: TranscriptCellKind;
  text: string;
  title?: string;
  toolName?: string;
  isError?: boolean;
  streaming?: boolean;
  turnId?: string;
  toolCallId?: string;
  durationMs?: number;
}

export interface SlashCatalogEntry {
  name: string;
  description: string;
  usage?: string;
  kind: 'direct' | 'prompt' | 'state';
}

export type HostEvent =
  | { type: 'hello'; protocolVersion: 1; sessionId: string; model: string; cwd: string }
  | { type: 'session_loaded'; restored: boolean; sessionId: string; historySummary?: string }
  | { type: 'transcript_seed'; cells: TranscriptCell[] }
  | { type: 'transcript_append'; cells: TranscriptCell[] }
  | { type: 'assistant_delta'; turnId: string; messageId: string; text: string }
  | { type: 'assistant_completed'; turnId: string; messageId: string; text: string }
  | { type: 'tool_started'; turnId: string; toolCallId: string; toolName: string; label: string }
  | { type: 'tool_completed'; turnId: string; toolCallId: string; toolName: string; status: 'success' | 'error'; resultPreview: string; durationMs?: number }
  | { type: 'status'; text: string }
  | { type: 'footer'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'error'; text: string }
  | { type: 'turn_completed'; turnId: string; stopReason: string; finalAnswer: string }
  | { type: 'slash_catalog'; commands: SlashCatalogEntry[] };

export type FrontendAction =
  | { type: 'submit_prompt'; prompt: string }
  | { type: 'run_slash_command'; command: string; argsText?: string }
  | { type: 'run_shell_command'; command: string; args?: string[] }
  | { type: 'request_status' }
  | { type: 'clear_session' }
  | { type: 'quit' };

export type BridgeMessage = HostEvent | FrontendAction;

export function serializeBridgeMessage(message: BridgeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseBridgeMessage(line: string): BridgeMessage {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line.trim());
  } catch {
    throw new Error('Invalid bridge message: expected JSON object');
  }

  if (!isBridgeMessage(parsed) || !hasRequiredFields(parsed)) {
    throw new Error('Invalid bridge message: unexpected shape');
  }

  return parsed;
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && bridgeMessageTypes.has(type);
}

function hasRequiredFields(value: BridgeMessage): boolean {
  switch (value.type) {
    case 'assistant_delta':
      return typeof value.turnId === 'string' && typeof value.messageId === 'string' && typeof value.text === 'string';
    case 'assistant_completed':
      return typeof value.turnId === 'string' && typeof value.messageId === 'string' && typeof value.text === 'string';
    case 'hello':
      return value.protocolVersion === 1 && typeof value.sessionId === 'string' && typeof value.model === 'string' && typeof value.cwd === 'string';
    case 'transcript_seed':
    case 'transcript_append':
      return isTranscriptCellList(value.cells);
    case 'slash_catalog':
      return Array.isArray(value.commands) && value.commands.every(isSlashCatalogEntry);
    case 'run_shell_command':
      return typeof value.command === 'string' && (value.args === undefined || isStringArray(value.args));
    case 'run_slash_command':
      return typeof value.command === 'string' && (value.argsText === undefined || typeof value.argsText === 'string');
    case 'submit_prompt':
      return typeof value.prompt === 'string';
    case 'tool_started':
      return typeof value.turnId === 'string' && typeof value.toolCallId === 'string' && typeof value.toolName === 'string' && typeof value.label === 'string';
    case 'tool_completed':
      return typeof value.turnId === 'string'
        && typeof value.toolCallId === 'string'
        && typeof value.toolName === 'string'
        && (value.status === 'success' || value.status === 'error')
        && typeof value.resultPreview === 'string'
        && (value.durationMs === undefined || typeof value.durationMs === 'number');
    case 'status':
    case 'footer':
    case 'warning':
    case 'error':
      return typeof value.text === 'string';
    case 'session_loaded':
      return typeof value.restored === 'boolean'
        && typeof value.sessionId === 'string'
        && (value.historySummary === undefined || typeof value.historySummary === 'string');
    case 'turn_completed':
      return typeof value.turnId === 'string' && typeof value.stopReason === 'string' && typeof value.finalAnswer === 'string';
    case 'request_status':
    case 'clear_session':
    case 'quit':
      return true;
    default:
      return false;
  }
}

function isTranscriptCellList(value: unknown): value is TranscriptCell[] {
  return Array.isArray(value) && value.every(isTranscriptCell);
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
    && (cell.isError === undefined || typeof cell.isError === 'boolean')
    && (cell.streaming === undefined || typeof cell.streaming === 'boolean')
    && (cell.turnId === undefined || typeof cell.turnId === 'string')
    && (cell.toolCallId === undefined || typeof cell.toolCallId === 'string')
    && (cell.durationMs === undefined || typeof cell.durationMs === 'number');
}

function isTranscriptCellKind(value: unknown): value is TranscriptCellKind {
  return value === 'user'
    || value === 'assistant'
    || value === 'tool'
    || value === 'status'
    || value === 'diff'
    || value === 'shell'
    || value === 'summary';
}

function isSlashCatalogEntry(value: unknown): value is SlashCatalogEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return typeof entry.name === 'string'
    && typeof entry.description === 'string'
    && (entry.usage === undefined || typeof entry.usage === 'string')
    && (entry.kind === 'direct' || entry.kind === 'prompt' || entry.kind === 'state');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const bridgeMessageTypes = new Set<string>([
  'hello',
  'session_loaded',
  'transcript_seed',
  'transcript_append',
  'assistant_delta',
  'assistant_completed',
  'tool_started',
  'tool_completed',
  'status',
  'footer',
  'warning',
  'error',
  'turn_completed',
  'slash_catalog',
  'submit_prompt',
  'run_slash_command',
  'run_shell_command',
  'request_status',
  'clear_session',
  'quit'
]);
