import { appendFileSync } from 'node:fs';

import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export interface JsonLineWriter {
  appendLine(line: string): void;
}

export function createJsonLineLogger(writer: JsonLineWriter): TelemetryObserver {
  return {
    record(event: TelemetryEvent) {
      writer.appendLine(`${JSON.stringify(event)}\n`);
    }
  };
}

export function createFileJsonLineWriter(filePath: string): JsonLineWriter {
  return {
    appendLine(line: string) {
      appendFileSync(filePath, line, 'utf8');
    }
  };
}
