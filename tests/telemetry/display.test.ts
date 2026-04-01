import { describe, expect, it } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompactCliTelemetryObserver', () => {
  it('renders shell tool activity as a short command label and omits done lines', () => {
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
      toolName: 'shell',
      toolCallId: 'call-1',
      inputPreview: '{"command":"git","args":["status"]}',
      inputRawRedacted: { command: 'git', args: ['status'] }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'shell',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 5,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual(['· shell git status']);
  });

  it('renders compact summaries for read_file, edit_file, and search without leaking payloads', () => {
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
      inputPreview: '{"path":"src/cli/main.ts"}',
      inputRawRedacted: { path: 'src/cli/main.ts' }
    }));
    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'edit_file',
      toolCallId: 'call-2',
      inputPreview: '{"path":"src/telemetry/display.ts"}',
      inputRawRedacted: {
        path: 'src/telemetry/display.ts',
        oldText: 'secret old text',
        newText: 'secret new text'
      }
    }));
    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'search',
      toolCallId: 'call-3',
      inputPreview: '{"pattern":"promptLabel"}',
      inputRawRedacted: { pattern: 'promptLabel' }
    }));

    expect(lines).toEqual([
      '· read src/cli/main.ts',
      '· edit src/telemetry/display.ts',
      '· search promptLabel'
    ]);
    expect(lines.join('\n')).not.toContain('secret old text');
    expect(lines.join('\n')).not.toContain('secret new text');
  });

  it('suppresses unknown tool activity lines', () => {
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
      toolName: 'Read',
      toolCallId: 'call-2',
      inputPreview: '{"path":"secret.txt"}',
      inputRawRedacted: { path: 'secret.txt' }
    }));

    expect(lines).toEqual([]);
  });

  it('renders a minimal footer from turn summary and omits zero tools', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeLine(text) {
        lines.push(text);
      }
    }) as ReturnType<typeof createCompactCliTelemetryObserver> & { flushPendingFooter?: () => void };

    observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 0,
      stopReason: 'completed',
      toolRoundsUsed: 0,
      isVerified: true,
      durationMs: 6300
    }));
    observer.record(createTelemetryEvent('turn_summary', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 0,
      providerRounds: 1,
      toolRoundsUsed: 0,
      toolCallsTotal: 0,
      toolCallsByName: {},
      inputTokensTotal: 185,
      outputTokensTotal: 15,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));

    observer.flushPendingFooter?.();

    expect(lines).toEqual(['─ completed • 1 provider • 185 in / 15 out • 6.3s']);
  });
});
