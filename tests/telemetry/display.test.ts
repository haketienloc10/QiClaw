import { describe, expect, it } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompactCliTelemetryObserver', () => {
  it('prints compact tool status lines for a successful tool call', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'read_file',
      toolCallId: 'call-1',
      inputPreview: '{"path":"note.txt"}',
      inputRawRedacted: { path: 'note.txt' }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'read_file',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'agent note',
      resultRawRedacted: { content: 'agent note' },
      durationMs: 5,
      resultSizeChars: 10
    }));

    expect(lines).toEqual(['Tool: read_file', 'Tool: read_file done']);
  });
});
