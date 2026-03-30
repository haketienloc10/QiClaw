import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export interface TelemetryMetricsSnapshot {
  turnsStarted: number;
  turnsCompleted: number;
  turnsFailed: number;
  totalToolCallsCompleted: number;
  lastTurnDurationMs: number;
}

export interface MetricsObserver extends TelemetryObserver {
  snapshot(): TelemetryMetricsSnapshot;
}

export function createInMemoryMetricsObserver(): MetricsObserver {
  let turnsStarted = 0;
  let turnsCompleted = 0;
  let turnsFailed = 0;
  let totalToolCallsCompleted = 0;
  let turnStartedAt = 0;
  let lastTurnDurationMs = 0;

  return {
    record(event: TelemetryEvent) {
      if (event.type === 'turn_started') {
        turnsStarted += 1;
        turnStartedAt = Date.now();
        return;
      }

      if (event.type === 'tool_call_completed') {
        totalToolCallsCompleted += 1;
        return;
      }

      if (event.type === 'turn_completed') {
        turnsCompleted += 1;
        lastTurnDurationMs = Math.max(0, Date.now() - turnStartedAt);
        return;
      }

      if (event.type === 'turn_failed') {
        turnsFailed += 1;
        lastTurnDurationMs = Math.max(0, Date.now() - turnStartedAt);
      }
    },
    snapshot() {
      return {
        turnsStarted,
        turnsCompleted,
        turnsFailed,
        totalToolCallsCompleted,
        lastTurnDurationMs
      };
    }
  };
}
