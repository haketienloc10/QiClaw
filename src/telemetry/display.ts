import pc from 'picocolors';

import type {
  TelemetryEvent,
  TelemetryObserver,
  ToolCallCompletedTelemetryData,
  ToolCallStartedTelemetryData,
  TurnFinishedTelemetryData,
  TurnSummaryTelemetryData
} from './observer.js';

export interface CompactCliTelemetryObserverOptions {
  mode?: 'compact' | 'interactive';
  writeActivityLine(text: string, toolCallId?: string): void;
  replaceActivityLine?(toolCallId: string, text: string): void;
  writeFooterLine(text: string): void;
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
  const toolActivityLabels = new Map<string, string>();
  const mode = options.mode ?? 'compact';

  return {
    record(event: TelemetryEvent) {
      if (event.type === 'tool_call_started') {
        const label = formatToolActivityLabel(event.data, mode);

        if (label) {
          toolActivityLabels.set(event.data.toolCallId, label);
          options.writeActivityLine(formatToolActivityLine(label, mode), event.data.toolCallId);
        }
        return;
      }

      if (event.type === 'tool_call_completed') {
        const activityLabel = toolActivityLabels.get(event.data.toolCallId);
        const line = formatToolCompletionLine(event.data, activityLabel, mode);
        toolActivityLabels.delete(event.data.toolCallId);

        if (line) {
          if (options.replaceActivityLine && mode === 'compact') {
            options.replaceActivityLine(event.data.toolCallId, line);
          } else {
            options.writeActivityLine(line);
          }
        }
        return;
      }

      if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
        toolActivityLabels.clear();
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

      options.writeFooterLine(formatFooterLine(pendingFooter.summary, pendingFooter.durationMs, mode));
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

function formatToolActivityLine(label: string, mode: 'compact' | 'interactive'): string {
  if (mode === 'interactive') {
    return ` ${pc.cyan('⚡')} ${label}`;
  }

  return `· ${label}`;
}

function formatToolActivityLabel(
  data: ToolCallStartedTelemetryData,
  mode: 'compact' | 'interactive'
): string | undefined {
  const actionLabel = formatToolActionLabel(data);

  if (!actionLabel) {
    return undefined;
  }

  return actionLabel;
}

function formatToolActionLabel(data: ToolCallStartedTelemetryData): string | undefined {
  if (data.toolName === 'shell_readonly' || data.toolName === 'shell_exec') {
    return `${formatShellToolKind(data.toolName)} ${formatShellCommandLabel(data.inputRawRedacted)}`;
  }

  if (data.toolName === 'read_file') {
    return `read ${formatPathToolLabel(data.inputRawRedacted, 'file')}`;
  }

  if (data.toolName === 'edit_file') {
    return `edit ${formatPathToolLabel(data.inputRawRedacted, 'file')}`;
  }

  if (data.toolName === 'search') {
    return `search ${formatSearchLabel(data.inputRawRedacted)}`;
  }

  return undefined;
}

function formatToolCompletionLine(
  data: ToolCallCompletedTelemetryData,
  activityLabel: string | undefined,
  mode: 'compact' | 'interactive'
): string | undefined {
  if (!activityLabel) {
    return undefined;
  }

  const statusText = formatToolCompletionStatus(data, mode);
  return mode === 'interactive'
    ? ` └─ ${statusText} (${data.durationMs}ms)`
    : `· ${activityLabel} | ${statusText} (${data.durationMs}ms)`;
}

function formatToolCompletionStatus(
  data: ToolCallCompletedTelemetryData,
  mode: 'compact' | 'interactive'
): string {
  if (mode === 'interactive') {
    return data.isError ? `${pc.red('✖')} ${pc.red('Fail')}` : `${pc.green('✔')} ${pc.green('Success')}`;
  }

  return data.isError ? 'fail' : 'done';
}

function formatShellToolKind(toolName: 'shell_readonly' | 'shell_exec'): string {
  return toolName === 'shell_readonly' ? 'shell:read' : 'shell:exec';
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

function formatPathToolLabel(input: unknown, fallbackNoun: string): string {
  if (!input || typeof input !== 'object') {
    return fallbackNoun;
  }

  const path = typeof (input as { path?: unknown }).path === 'string'
    ? (input as { path: string }).path.trim()
    : '';

  return path.length > 0 ? path : fallbackNoun;
}

function formatSearchLabel(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return 'pattern';
  }

  const pattern = typeof (input as { pattern?: unknown }).pattern === 'string'
    ? (input as { pattern: string }).pattern.trim()
    : '';

  return pattern.length > 0 ? pattern : 'pattern';
}

function formatFooterLine(
  summary: TurnSummaryTelemetryData,
  durationMs: number | undefined,
  mode: 'compact' | 'interactive'
): string {
  if (mode === 'interactive') {
    return formatInteractiveFooterLine(summary, durationMs);
  }

  const parts = [
    formatCompactStatus(summary.stopReason),
    `${summary.providerRounds} provider`,
    summary.toolCallsTotal > 0 ? `${summary.toolCallsTotal} tools` : undefined,
    `${summary.inputTokensTotal} in / ${summary.outputTokensTotal} out`,
    durationMs === undefined ? undefined : formatDurationSeconds(durationMs)
  ].filter((part): part is string => Boolean(part));

  return `─ ${parts.join(' • ')}`;
}

function formatInteractiveFooterLine(summary: TurnSummaryTelemetryData, durationMs?: number): string {
  const isSuccess = summary.stopReason === 'completed';
  const status = isSuccess
    ? `${pc.green('✔')} ${pc.green(pc.bold('DONE'))}`
    : `${pc.red('✖')} ${pc.red(pc.bold('FAIL: ' + summary.stopReason))}`;
  const parts = [
    `${summary.providerRounds} provider`,
    summary.toolCallsTotal > 0 ? `${summary.toolCallsTotal} tools` : undefined,
    `${summary.inputTokensTotal} in / ${summary.outputTokensTotal} out`,
    durationMs === undefined ? undefined : `⏱️` + formatDurationSeconds(durationMs)
  ].filter((part): part is string => Boolean(part));

  return `${pc.dim('─'.repeat(54))}\n${status}${parts.length > 0 ? ` • ${parts.join(pc.dim(' • '))}` : ''}`;
}

function formatCompactStatus(stopReason: string): string {
  return stopReason === 'completed' ? 'completed' : `stopped: ${stopReason}`;
}

function formatDurationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
