import { describe, expect, it } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompactCliTelemetryObserver', () => {
  it('replaces shell tool activity lines with completion lines that reuse the original command', () => {
    const lines: string[] = [];
    const replaced = new Map<string, string>();
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      replaceActivityLine(toolCallId, text) {
        replaced.set(toolCallId, text);
      },
      writeFooterLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'shell_readonly',
      toolCallId: 'call-1',
      inputPreview: '{"command":"git","args":["status"]}',
      inputRawRedacted: { command: 'git', args: ['status'] }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'shell_readonly',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok', data: { exitCode: 0 } },
      durationMs: 5,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual(['· shell:read git status']);
    expect(replaced).toEqual(new Map([
      ['call-1', '· shell:read git status | done (5ms)']
    ]));
  });

  it('replaces completion lines for read_file, edit_file, and search using the original compact labels', () => {
    const lines: string[] = [];
    const replaced = new Map<string, string>();
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      replaceActivityLine(toolCallId: string, text: string) {
        replaced.set(toolCallId, text);
      },
      writeFooterLine(text) {
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
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'read_file',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 7,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
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
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'edit_file',
      toolCallId: 'call-2',
      isError: true,
      resultPreview: 'error',
      resultRawRedacted: { content: 'error' },
      durationMs: 8,
      resultSizeChars: 5,
      resultSizeBucket: 'small'
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
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'search',
      toolCallId: 'call-3',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 9,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual([
      '· read src/cli/main.ts',
      '· edit src/telemetry/display.ts',
      '· search promptLabel'
    ]);
    expect(replaced).toEqual(new Map([
      ['call-1', '· read src/cli/main.ts | done (7ms)'],
      ['call-2', '· edit src/telemetry/display.ts | fail (8ms)'],
      ['call-3', '· search promptLabel | done (9ms)']
    ]));
    expect(lines.join('\n')).not.toContain('secret old text');
    expect(lines.join('\n')).not.toContain('secret new text');
  });

  it('renders compact summaries for read_file, edit_file, and search without leaking payloads', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
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
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
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
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
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

  it('adds verification status and tool round counts to the footer when tools run', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
        lines.push(text);
      }
    }) as ReturnType<typeof createCompactCliTelemetryObserver> & { flushPendingFooter?: () => void };

    observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-2',
      providerRound: 2,
      toolRound: 1,
      stopReason: 'completed',
      toolRoundsUsed: 1,
      isVerified: true,
      durationMs: 4800
    }));
    observer.record(createTelemetryEvent('turn_summary', 'completion_check', {
      turnId: 'turn-2',
      providerRound: 2,
      toolRound: 1,
      providerRounds: 2,
      toolRoundsUsed: 1,
      toolCallsTotal: 3,
      toolCallsByName: { read_file: 2, search: 1 },
      inputTokensTotal: 516,
      outputTokensTotal: 274,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));

    observer.flushPendingFooter?.();

    expect(lines).toEqual(['─ completed • verified • 2 provider • 1 tool round • 3 tools • 516 in / 274 out • 4.8s']);
  });
});
