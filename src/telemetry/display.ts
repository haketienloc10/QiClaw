import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export interface CompactCliTelemetryObserverOptions {
  writeLine(text: string): void;
}

export interface CompactCliTelemetryObserver extends TelemetryObserver {
  flushPendingFooter(): void;
}

interface PendingFooterState {
  turnId?: string;
  providerRounds?: number;
  toolRoundsUsed?: number;
  inputTokensTotal?: number;
  outputTokensTotal?: number;
  hasUsageTelemetry: boolean;
  stopReason?: string;
  durationMs?: number;
  footerRendered: boolean;
}

export function createCompactCliTelemetryObserver(
  options: CompactCliTelemetryObserverOptions
): CompactCliTelemetryObserver {
  const footerState = createPendingFooterState();

  return {
    record(event: TelemetryEvent) {
      if (event.type === 'tool_call_started') {
        options.writeLine(formatToolActivityLine(String(event.data.toolName ?? 'unknown')));
        return;
      }

      if (event.type === 'tool_call_completed') {
        const suffix = event.data.isError === true ? 'failed' : 'done';
        options.writeLine(formatToolActivityLine(String(event.data.toolName ?? 'unknown'), suffix));
        return;
      }

      alignFooterStateWithTurn(footerState, event.data.turnId);

      if (event.type === 'provider_responded' && event.data.usage) {
        footerState.hasUsageTelemetry = true;
        return;
      }

      if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
        footerState.stopReason = event.data.stopReason;
        footerState.toolRoundsUsed = event.data.toolRoundsUsed;
        footerState.durationMs = event.data.durationMs;
        footerState.footerRendered = false;
        return;
      }

      if (event.type === 'turn_summary') {
        footerState.providerRounds = event.data.providerRounds;
        footerState.toolRoundsUsed = event.data.toolRoundsUsed;
        footerState.inputTokensTotal = event.data.inputTokensTotal;
        footerState.outputTokensTotal = event.data.outputTokensTotal;
        footerState.stopReason = event.data.stopReason;
        footerState.footerRendered = false;
      }
    },
    flushPendingFooter() {
      if (footerState.footerRendered) {
        return;
      }

      const line = formatFooterSummaryLine(footerState);

      if (!line) {
        return;
      }

      options.writeLine(line);
      footerState.footerRendered = true;
    }
  };
}

function createPendingFooterState(): PendingFooterState {
  return {
    turnId: undefined,
    providerRounds: undefined,
    toolRoundsUsed: undefined,
    inputTokensTotal: undefined,
    outputTokensTotal: undefined,
    hasUsageTelemetry: false,
    stopReason: undefined,
    durationMs: undefined,
    footerRendered: false
  };
}

function alignFooterStateWithTurn(state: PendingFooterState, turnId: string): void {
  if (state.turnId === turnId) {
    return;
  }

  const nextState = createPendingFooterState();
  Object.assign(state, nextState, { turnId });
}

function formatToolActivityLine(toolName: string, suffix?: string): string {
  return suffix ? `· tool ${toolName} ${suffix}` : `· tool ${toolName}`;
}

function formatFooterSummaryLine(state: PendingFooterState): string | undefined {
  if (!state.stopReason) {
    return undefined;
  }

  const status = state.stopReason === 'completed' ? 'completed' : `stopped: ${state.stopReason}`;
  const parts = [`─ ${status}`];

  if (typeof state.providerRounds === 'number') {
    parts.push(`${state.providerRounds} ${pluralize(state.providerRounds, 'provider round', 'provider rounds')}`);
  }

  if (typeof state.toolRoundsUsed === 'number') {
    parts.push(`${state.toolRoundsUsed} ${pluralize(state.toolRoundsUsed, 'tool round', 'tool rounds')}`);
  }

  if (
    state.hasUsageTelemetry &&
    typeof state.inputTokensTotal === 'number' &&
    typeof state.outputTokensTotal === 'number'
  ) {
    parts.push(`${state.inputTokensTotal} in / ${state.outputTokensTotal} out`);
  }

  if (typeof state.durationMs === 'number') {
    parts.push(formatDurationSeconds(state.durationMs));
  }

  return parts.join(' • ');
}

function pluralize(value: number, singular: string, plural: string): string {
  return value === 1 ? singular : plural;
}

function formatDurationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
