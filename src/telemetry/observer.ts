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

export interface TelemetryEventDataMap {
  turn_started: Record<string, unknown>;
  provider_called: Record<string, unknown>;
  provider_responded: Record<string, unknown>;
  tool_call_started: Record<string, unknown>;
  tool_call_completed: Record<string, unknown>;
  verification_completed: Record<string, unknown>;
  turn_completed: Record<string, unknown>;
  turn_stopped: Record<string, unknown>;
  turn_failed: Record<string, unknown>;
}

export interface TelemetryEvent<TType extends TelemetryEventType = TelemetryEventType> {
  type: TType;
  timestamp: string;
  data: TelemetryEventDataMap[TType];
}

export interface TelemetryObserver {
  record(event: TelemetryEvent): void;
}

export function createNoopObserver(): TelemetryObserver {
  return {
    record() {}
  };
}

export function createTelemetryEvent<TType extends TelemetryEventType>(
  type: TType,
  data: TelemetryEventDataMap[TType] = {}
): TelemetryEvent<TType> {
  return {
    type,
    timestamp: new Date().toISOString(),
    data
  };
}
