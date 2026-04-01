import type {
  TelemetryEvent,
  TelemetryObserver,
  ToolCallStartedTelemetryData,
  TurnFinishedTelemetryData,
  TurnSummaryTelemetryData
} from './observer.js';

export interface CompactCliTelemetryObserverOptions {
  writeLine(text: string): void;
}

export interface CompactCliTelemetryObserver extends TelemetryObserver {
  flushPendingFooter(): void;
}

interface PendingFooterState {
  turnId: string;
  summary: TurnSummaryTelemetryData;
  durationMs?: number;
}

export function createCompactCliTelemetryObserver(
  options: CompactCliTelemetryObserverOptions
): CompactCliTelemetryObserver {
  let pendingFooter: PendingFooterState | undefined;

  return {
    record(event: TelemetryEvent) {
      if (event.type === 'tool_call_started') {
        options.writeLine(formatToolActivityLine(event.data));
        return;
      }

      if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
        pendingFooter = createPendingFooterState(event.data, pendingFooter?.summary);
        return;
      }

      if (event.type === 'turn_summary') {
        pendingFooter = createPendingFooterState(pendingFooter?.durationMs, event.data);
        return;
      }
    },
    flushPendingFooter() {
      if (!pendingFooter) {
        return;
      }

      options.writeLine(formatFooterLine(pendingFooter.summary, pendingFooter.durationMs));
      pendingFooter = undefined;
    }
  };
}

function createPendingFooterState(
  durationOrEvent: number | TurnFinishedTelemetryData | undefined,
  summaryOrPrevious?: TurnSummaryTelemetryData
): PendingFooterState | undefined {
  if (typeof durationOrEvent === 'number') {
    if (!summaryOrPrevious) {
      return undefined;
    }

    return {
      turnId: summaryOrPrevious.turnId,
      summary: summaryOrPrevious,
      durationMs: durationOrEvent
    };
  }

  if (!durationOrEvent) {
    return summaryOrPrevious
      ? {
          turnId: summaryOrPrevious.turnId,
          summary: summaryOrPrevious
        }
      : undefined;
  }

  if (summaryOrPrevious && summaryOrPrevious.turnId === durationOrEvent.turnId) {
    return {
      turnId: durationOrEvent.turnId,
      summary: summaryOrPrevious,
      durationMs: durationOrEvent.durationMs
    };
  }

  return {
    turnId: durationOrEvent.turnId,
    summary: {
      turnId: durationOrEvent.turnId,
      providerRound: durationOrEvent.providerRound,
      toolRound: durationOrEvent.toolRound,
      providerRounds: durationOrEvent.providerRound,
      toolRoundsUsed: durationOrEvent.toolRoundsUsed,
      toolCallsTotal: 0,
      toolCallsByName: {},
      inputTokensTotal: 0,
      outputTokensTotal: 0,
      promptCharsMax: 0,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: durationOrEvent.stopReason === 'completed',
      stopReason: durationOrEvent.stopReason
    },
    durationMs: durationOrEvent.durationMs
  };
}

function formatToolActivityLine(data: ToolCallStartedTelemetryData): string {
  if (data.toolName === 'shell') {
    return `· shell ${formatShellCommandLabel(data.inputRawRedacted)}`;
  }

  return `· ${String(data.toolName ?? 'unknown')}`;
}

function formatShellCommandLabel(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return 'command';
  }

  const command = typeof (input as { command?: unknown }).command === 'string'
    ? (input as { command: string }).command.trim()
    : '';
  const args = Array.isArray((input as { args?: unknown }).args)
    ? (input as { args: unknown[] }).args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
    : [];
  const label = [command, ...args].filter((part) => part.length > 0).join(' ').trim();

  return label.length > 0 ? label : 'command';
}

function formatFooterLine(summary: TurnSummaryTelemetryData, durationMs?: number): string {
  const parts = [
    formatStatus(summary.stopReason),
    `${summary.providerRounds} provider`,
    summary.toolCallsTotal > 0 ? `${summary.toolCallsTotal} tools` : undefined,
    `${summary.inputTokensTotal} in / ${summary.outputTokensTotal} out`,
    durationMs === undefined ? undefined : formatDurationSeconds(durationMs)
  ].filter((part): part is string => Boolean(part));

  return `─ ${parts.join(' • ')}`;
}

function formatStatus(stopReason: string): string {
  return stopReason === 'completed' ? 'completed' : `stopped: ${stopReason}`;
}

function formatDurationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
