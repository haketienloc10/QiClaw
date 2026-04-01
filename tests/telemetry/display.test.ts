import { describe, expect, it } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompactCliTelemetryObserver', () => {
  it('prints short tool activity lines for a successful tool call', () => {
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
      resultSizeChars: 10,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual(['· tool read_file', '· tool read_file done']);
  });

  it('renders one footer line from end-of-turn telemetry and flushes it once', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeLine(text) {
        lines.push(text);
      }
    }) as ReturnType<typeof createCompactCliTelemetryObserver> & { flushPendingFooter?: () => void };

    observer.record(createTelemetryEvent('provider_responded', 'provider_decision', {
      turnId: 'turn-1',
      providerRound: 2,
      toolRound: 1,
      usage: { inputTokens: 412, outputTokens: 138, totalTokens: 550 },
      responseContentBlockCount: 1,
      toolCallCount: 0,
      hasTextOutput: true,
      durationMs: 40
    }));
    observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 2,
      toolRound: 1,
      stopReason: 'completed',
      toolRoundsUsed: 1,
      isVerified: true,
      durationMs: 3200
    }));
    observer.record(createTelemetryEvent('turn_summary', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 2,
      toolRound: 1,
      providerRounds: 2,
      toolRoundsUsed: 1,
      toolCallsTotal: 2,
      toolCallsByName: { read_file: 2 },
      inputTokensTotal: 412,
      outputTokensTotal: 138,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));

    observer.flushPendingFooter?.();
    observer.flushPendingFooter?.();

    expect(lines).toEqual(['─ completed • 2 provider rounds • 1 tool round • 412 in / 138 out • 3.2s']);
  });

  it('does not reuse footer telemetry from a previous turn when the next turn is partial', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeLine(text) {
        lines.push(text);
      }
    }) as ReturnType<typeof createCompactCliTelemetryObserver> & { flushPendingFooter?: () => void };

    observer.record(createTelemetryEvent('provider_responded', 'provider_decision', {
      turnId: 'turn-1',
      providerRound: 2,
      toolRound: 1,
      usage: { inputTokens: 412, outputTokens: 138, totalTokens: 550 },
      responseContentBlockCount: 1,
      toolCallCount: 0,
      hasTextOutput: true,
      durationMs: 40
    }));
    observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 2,
      toolRound: 1,
      stopReason: 'completed',
      toolRoundsUsed: 1,
      isVerified: true,
      durationMs: 3200
    }));
    observer.record(createTelemetryEvent('turn_summary', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 2,
      toolRound: 1,
      providerRounds: 2,
      toolRoundsUsed: 1,
      toolCallsTotal: 2,
      toolCallsByName: { read_file: 2 },
      inputTokensTotal: 412,
      outputTokensTotal: 138,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));
    observer.flushPendingFooter?.();

    observer.record(createTelemetryEvent('turn_stopped', 'completion_check', {
      turnId: 'turn-2',
      providerRound: 1,
      toolRound: 0,
      stopReason: 'max_tool_rounds_reached',
      toolRoundsUsed: 0,
      isVerified: false,
      durationMs: 1200
    }));
    observer.flushPendingFooter?.();

    expect(lines).toEqual([
      '─ completed • 2 provider rounds • 1 tool round • 412 in / 138 out • 3.2s',
      '─ stopped: max_tool_rounds_reached • 0 tool rounds • 1.2s'
    ]);
  });
});
