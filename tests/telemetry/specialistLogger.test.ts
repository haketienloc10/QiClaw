import { describe, expect, it } from 'vitest';

import { createJsonLineLogger } from '../../src/telemetry/logger.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('specialist telemetry logging', () => {
  it('serializes specialist telemetry events as JSONL', () => {
    const lines: string[] = [];
    const observer = createJsonLineLogger({
      appendLine(line) {
        lines.push(line);
      }
    });

    observer.record(createTelemetryEvent('specialist_selected', 'input_received', {
      turnId: 'turn-1',
      providerRound: 0,
      toolRound: 0,
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      kind: 'research',
      routeReason: 'heuristic',
      matchedRule: 'find',
      contextChars: 120,
      historyMessageCount: 4
    }));

    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.type).toBe('specialist_selected');
    expect(parsed.data.kind).toBe('research');
    expect(parsed.data.contextChars).toBe(120);
  });
});
