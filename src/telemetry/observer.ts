export type TelemetryEventType =
  | 'turn_started'
  | 'provider_called'
  | 'provider_responded'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'verification_completed'
  | 'turn_completed'
  | 'turn_stopped'
  | 'turn_failed';

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface TelemetryObserver {
  record(event: TelemetryEvent): void;
}

export function createNoopObserver(): TelemetryObserver {
  return {
    record() {}
  };
}

export function createTelemetryEvent(
  type: TelemetryEventType,
  data: Record<string, unknown> = {}
): TelemetryEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    data
  };
}
