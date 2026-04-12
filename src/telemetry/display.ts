import pc from 'picocolors';

import { formatToolActivityLabel as formatRegisteredToolActivityLabel } from '../tools/registry.js';
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
  writeActivityLineBelow?(toolCallId: string, text: string): void;
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

interface ToolActivityAnimationState {
  intervalId: ReturnType<typeof setInterval>;
  label: string;
  frameIndex: number;
}

const interactiveToolPulseFrames = [
  pc.cyan('✦'),
  pc.blue('✧'),
  pc.magenta('✱'),
  pc.yellow('✲'),
  pc.green('✳'),
  pc.white('✴')
];
const interactiveToolPulseIntervalMs = 80;

export function createCompactCliTelemetryObserver(
  options: CompactCliTelemetryObserverOptions
): CompactCliTelemetryObserver {
  let pendingFooter: PendingFooterState | undefined;
  const toolActivityLabels = new Map<string, string>();
  const toolActivityAnimations = new Map<string, ToolActivityAnimationState>();
  const mode = options.mode ?? 'compact';

  function stopToolActivityAnimation(toolCallId: string): void {
    const animation = toolActivityAnimations.get(toolCallId);

    if (!animation) {
      return;
    }

    clearInterval(animation.intervalId);
    toolActivityAnimations.delete(toolCallId);
  }

  function stopAllToolActivityAnimations(): void {
    for (const toolCallId of toolActivityAnimations.keys()) {
      stopToolActivityAnimation(toolCallId);
    }
  }

  function startToolActivityAnimation(toolCallId: string, label: string): void {
    if (mode !== 'interactive' || !options.replaceActivityLine) {
      return;
    }

    stopToolActivityAnimation(toolCallId);

    const animationState: ToolActivityAnimationState = {
      intervalId: setInterval(() => {
        const activeAnimation = toolActivityAnimations.get(toolCallId);

        if (!activeAnimation) {
          return;
        }

        options.replaceActivityLine?.(toolCallId, formatToolActivityLine(activeAnimation.label, mode, activeAnimation.frameIndex));
        activeAnimation.frameIndex = (activeAnimation.frameIndex + 1) % interactiveToolPulseFrames.length;
      }, interactiveToolPulseIntervalMs),
      label,
      frameIndex: 0
    };

    toolActivityAnimations.set(toolCallId, animationState);
  }

  return {
    record(event: TelemetryEvent) {
      if (event.type === 'tool_call_started') {
        const label = formatToolActivityLabel(event.data);

        if (label) {
          toolActivityLabels.set(event.data.toolCallId, label);
          options.writeActivityLine(formatToolActivityLine(label, mode), event.data.toolCallId);
          startToolActivityAnimation(event.data.toolCallId, label);
        }
        return;
      }

      if (event.type === 'tool_call_completed') {
        stopToolActivityAnimation(event.data.toolCallId);
        const activityLabel = toolActivityLabels.get(event.data.toolCallId);
        const line = formatToolCompletionLine(event.data, activityLabel, mode);
        toolActivityLabels.delete(event.data.toolCallId);

        if (line) {
          if (mode === 'compact' && options.replaceActivityLine) {
            options.replaceActivityLine(event.data.toolCallId, line);
          } else if (mode === 'interactive' && options.writeActivityLineBelow) {
            options.writeActivityLineBelow(event.data.toolCallId, line);
          } else {
            options.writeActivityLine(line);
          }
        }
        return;
      }

      if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
        stopAllToolActivityAnimations();
        toolActivityLabels.clear();
        pendingFooter = createPendingFooterState(event.data, pendingFooter?.summary);
        return;
      }

      if (event.type === 'turn_failed') {
        stopAllToolActivityAnimations();
        toolActivityLabels.clear();
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
      cacheReadInputTokens: 0,
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

function formatToolActivityLine(
  label: string,
  mode: 'compact' | 'interactive',
  frameIndex = 0
): string {
  if (mode === 'interactive') {
    const icon = interactiveToolPulseFrames[frameIndex] ?? interactiveToolPulseFrames[0];
    return ` ${icon} ${label}`;
  }

  return `· ${label}`;
}

function formatToolActivityLabel(
  data: ToolCallStartedTelemetryData
): string | undefined {
  const actionLabel = formatToolActionLabel(data);

  if (!actionLabel) {
    return undefined;
  }

  return actionLabel;
}

function formatToolActionLabel(data: ToolCallStartedTelemetryData): string | undefined {
  return formatRegisteredToolActivityLabel(data.toolName, data.inputRawRedacted);
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
    formatTokenFooter(summary, mode),
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
    formatTokenFooter(summary, 'interactive'),
    durationMs === undefined ? undefined : `⏱️` + formatDurationSeconds(durationMs)
  ].filter((part): part is string => Boolean(part));

  return `${pc.dim('─'.repeat(54))}\n${status}${parts.length > 0 ? ` • ${parts.join(pc.dim(' • '))}` : ''}`;
}

function formatCompactStatus(stopReason: string): string {
  return stopReason === 'completed' ? 'completed' : `stopped: ${stopReason}`;
}

function formatTokenFooter(
  summary: TurnSummaryTelemetryData,
  mode: 'compact' | 'interactive'
): string {
  const base = `${summary.inputTokensTotal} in / ${summary.outputTokensTotal} out`;
  const cachedTokens = summary.cacheReadInputTokens ?? 0;

  if (cachedTokens <= 0) {
    return base;
  }

  const cacheRatio = summary.inputTokensTotal > 0
    ? Math.round((cachedTokens / summary.inputTokensTotal) * 100)
    : 0;
  const cacheText = `${cachedTokens} cached (${cacheRatio}%)`;

  if (mode === 'interactive') {
    return `${base} / ${pc.dim(cacheText)}`;
  }

  return `${base} / ${cacheText}`;
}

function formatDurationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
