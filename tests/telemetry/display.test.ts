import { describe, expect, it } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompactCliTelemetryObserver', () => {
  it('prints only compact tool status lines', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', {
      toolName: 'read_file',
      toolCallId: 'call-1',
      inputPreview: '{"path":"note.txt"}',
      inputRawRedacted: { path: 'note.txt' }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', {
      toolName: 'read_file',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'agent note',
      resultRawRedacted: { content: 'agent note' }
    }));

    expect(lines).toEqual(['Tool: read_file', 'Tool: read_file done']);
  });
});
