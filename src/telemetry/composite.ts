import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export function createCompositeObserver(observers: readonly TelemetryObserver[]): TelemetryObserver {
  return {
    record(event: TelemetryEvent) {
      for (const observer of observers) {
        observer.record(event);
      }
    }
  };
}
