import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export interface CompactCliTelemetryObserverOptions {
  writeLine(text: string): void;
}

export function createCompactCliTelemetryObserver(
  options: CompactCliTelemetryObserverOptions
): TelemetryObserver {
  return {
    record(event: TelemetryEvent) {
      if (event.type === 'tool_call_started') {
        options.writeLine(`Tool: ${String(event.data.toolName ?? 'unknown')}`);
        return;
      }

      if (event.type === 'tool_call_completed') {
        const suffix = event.data.isError === true ? 'failed' : 'done';
        options.writeLine(`Tool: ${String(event.data.toolName ?? 'unknown')} ${suffix}`);
      }
    }
  };
}
