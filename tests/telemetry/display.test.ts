import pc from 'picocolors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCompactCliTelemetryObserver } from '../../src/telemetry/display.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

const INTERACTIVE_PULSE_REDRAW_MS = 80;
const INTERACTIVE_PULSE_SETTLE_MS = 240;

afterEach(() => {
  vi.useRealTimers();
});

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
      resultRawRedacted: { content: 'ok', data: { exitCode: 0 } },
      durationMs: 5,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual(['· shell git status']);
    expect(replaced).toEqual(new Map([
      ['call-1', '· shell git status | done (5ms)']
    ]));
  });

  it('replaces completion lines for file actions using the original compact labels', () => {
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
      toolName: 'file',
      toolCallId: 'call-1',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
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
      toolName: 'file',
      toolCallId: 'call-2',
      inputPreview: '{"action":"write","path":"src/telemetry/display.ts"}',
      inputRawRedacted: {
        action: 'write',
        path: 'src/telemetry/display.ts',
        oldText: 'secret old text',
        newText: 'secret new text'
      }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
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
      toolName: 'file',
      toolCallId: 'call-3',
      inputPreview: '{"action":"search","query":"promptLabel"}',
      inputRawRedacted: { action: 'search', query: 'promptLabel' }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-3',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 9,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual([
      '· file read src/cli/main.ts',
      '· file write src/telemetry/display.ts',
      '· file search promptLabel'
    ]);
    expect(replaced).toEqual(new Map([
      ['call-1', '· file read src/cli/main.ts | done (7ms)'],
      ['call-2', '· file write src/telemetry/display.ts | fail (8ms)'],
      ['call-3', '· file search promptLabel | done (9ms)']
    ]));
    expect(lines.join('\n')).not.toContain('secret old text');
    expect(lines.join('\n')).not.toContain('secret new text');
  });

  it('renders compact summaries for file actions without leaking payloads', () => {
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
      toolName: 'file',
      toolCallId: 'call-1',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));
    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-2',
      inputPreview: '{"action":"write","path":"src/telemetry/display.ts"}',
      inputRawRedacted: {
        action: 'write',
        path: 'src/telemetry/display.ts',
        oldText: 'secret old text',
        newText: 'secret new text'
      }
    }));
    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-3',
      inputPreview: '{"action":"search","query":"promptLabel"}',
      inputRawRedacted: { action: 'search', query: 'promptLabel' }
    }));

    expect(lines).toEqual([
      '· file read src/cli/main.ts',
      '· file write src/telemetry/display.ts',
      '· file search promptLabel'
    ]);
    expect(lines.join('\n')).not.toContain('secret old text');
    expect(lines.join('\n')).not.toContain('secret new text');
  });

  it('redraws the active interactive tool line while the tool is still running', () => {
    vi.useFakeTimers();

    const activityLines: string[] = [];
    const redraws = new Map<string, string[]>();
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        activityLines.push(text);
      },
      replaceActivityLine(toolCallId, text) {
        const entries = redraws.get(toolCallId) ?? [];
        entries.push(text);
        redraws.set(toolCallId, entries);
      },
      writeFooterLine(text) {
        activityLines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-1',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));

    const initialActivityLine = activityLines[0];
    expect(initialActivityLine).toContain('✦');
    expect(initialActivityLine).toContain('file read src/cli/main.ts');
    expect(redraws.get('call-1')).toBeUndefined();

    const redrawIntervalMs = INTERACTIVE_PULSE_REDRAW_MS;
    vi.advanceTimersByTime(redrawIntervalMs);

    const redrawHistory = redraws.get('call-1') ?? [];
    expect(redrawHistory.length).toBeGreaterThan(0);
    expect(redrawHistory[0]).toBe(initialActivityLine);
  });

  it('does not animate interactive tool activity when replaceActivityLine is unavailable', () => {
    vi.useFakeTimers();

    const activityLines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        activityLines.push(text);
      },
      writeFooterLine(text) {
        activityLines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-fallback',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));

    expect(activityLines).toHaveLength(1);
    expect(activityLines[0]).toContain('✦');
    expect(activityLines[0]).toContain('file read src/cli/main.ts');
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(INTERACTIVE_PULSE_SETTLE_MS);

    expect(activityLines).toHaveLength(1);
  });

  it('stops interactive animation after tool_call_completed and finalizes the same tool line', () => {
    vi.useFakeTimers();

    const fastRedrawIntervalMs = INTERACTIVE_PULSE_REDRAW_MS;
    const postCompletionWaitMs = INTERACTIVE_PULSE_SETTLE_MS;
    const activityLines: string[] = [];
    const redraws = new Map<string, string[]>();
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        activityLines.push(text);
      },
      replaceActivityLine(toolCallId, text) {
        const entries = redraws.get(toolCallId) ?? [];
        entries.push(text);
        redraws.set(toolCallId, entries);
      },
      writeFooterLine(text) {
        activityLines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-completed',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));

    const originalToolLine = activityLines[0]!;

    vi.advanceTimersByTime(fastRedrawIntervalMs);

    const redrawsBeforeCompletion = redraws.get('call-completed') ?? [];
    expect(redrawsBeforeCompletion.length).toBeGreaterThan(0);
    expect(redrawsBeforeCompletion[0]).toContain('✦');

    const redrawHistoryAtCompletion = [...redrawsBeforeCompletion];

    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-completed',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 5,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    const redrawsAtCompletion = [...(redraws.get('call-completed') ?? [])];

    expect(vi.getTimerCount()).toBe(0);
    expect(redrawsAtCompletion).toEqual(redrawHistoryAtCompletion);
    expect(activityLines).toEqual([
      originalToolLine,
      ' └─ ✔ Success (5ms)'
    ]);

    vi.advanceTimersByTime(postCompletionWaitMs);

    expect(redraws.get('call-completed')).toEqual(redrawsAtCompletion);
    expect(activityLines).toEqual([
      originalToolLine,
      ' └─ ✔ Success (5ms)'
    ]);
  });

  it('places interactive completion directly below the matching tool line when multiple tools are active', () => {
    vi.useFakeTimers();

    const activityLines: string[] = [];
    const redraws = new Map<string, string[]>();
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        activityLines.push(text);
      },
      writeActivityLineBelow(toolCallId, text) {
        const insertIndex = toolCallId === 'call-1' ? 1 : activityLines.length;
        activityLines.splice(insertIndex, 0, text);
      },
      replaceActivityLine(toolCallId, text) {
        const entries = redraws.get(toolCallId) ?? [];
        entries.push(text);
        redraws.set(toolCallId, entries);
      },
      writeFooterLine(text) {
        activityLines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-1',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));
    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-2',
      inputPreview: '{"action":"search","query":"promptLabel"}',
      inputRawRedacted: { action: 'search', query: 'promptLabel' }
    }));

    const firstToolLine = activityLines[0]!;
    const secondToolLine = activityLines[1]!;

    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-1',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 5,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(redraws.get('call-1')).toBeUndefined();
    expect(activityLines).toEqual([
      firstToolLine,
      expect.stringContaining('Success'),
      secondToolLine
    ]);
  });

  it('stops interactive animation after turn_completed cleanup', () => {
    vi.useFakeTimers();

    const activityLines: string[] = [];
    const redraws = new Map<string, string[]>();
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        activityLines.push(text);
      },
      replaceActivityLine(toolCallId, text) {
        const entries = redraws.get(toolCallId) ?? [];
        entries.push(text);
        redraws.set(toolCallId, entries);
      },
      writeFooterLine(text) {
        activityLines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-turn-completed',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));

    vi.advanceTimersByTime(INTERACTIVE_PULSE_REDRAW_MS);
    const redrawHistoryBeforeCleanup = redraws.get('call-turn-completed') ?? [];
    expect(redrawHistoryBeforeCleanup.length).toBeGreaterThan(0);
    expect(redrawHistoryBeforeCleanup[0]).toContain('✦');

    observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      stopReason: 'completed',
      toolRoundsUsed: 1,
      isVerified: true,
      durationMs: 10
    }));

    const redrawHistoryAtCleanup = [...(redraws.get('call-turn-completed') ?? [])];
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(INTERACTIVE_PULSE_SETTLE_MS);

    expect(redraws.get('call-turn-completed')).toEqual(redrawHistoryAtCleanup);
  });

  it('stops interactive animation after turn_stopped cleanup', () => {
    vi.useFakeTimers();

    const activityLines: string[] = [];
    const redraws = new Map<string, string[]>();
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        activityLines.push(text);
      },
      replaceActivityLine(toolCallId, text) {
        const entries = redraws.get(toolCallId) ?? [];
        entries.push(text);
        redraws.set(toolCallId, entries);
      },
      writeFooterLine(text) {
        activityLines.push(text);
      }
    });

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'file',
      toolCallId: 'call-turn-stopped',
      inputPreview: '{"action":"read","path":"src/cli/main.ts"}',
      inputRawRedacted: { action: 'read', path: 'src/cli/main.ts' }
    }));

    vi.advanceTimersByTime(INTERACTIVE_PULSE_REDRAW_MS);
    const redrawHistoryBeforeCleanup = redraws.get('call-turn-stopped') ?? [];
    expect(redrawHistoryBeforeCleanup.length).toBeGreaterThan(0);
    expect(redrawHistoryBeforeCleanup[0]).toContain('✦');

    observer.record(createTelemetryEvent('turn_stopped', 'completion_check', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      stopReason: 'interrupted',
      toolRoundsUsed: 1,
      isVerified: false,
      durationMs: 10
    }));

    const redrawHistoryAtCleanup = [...(redraws.get('call-turn-stopped') ?? [])];
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(INTERACTIVE_PULSE_SETTLE_MS);

    expect(redraws.get('call-turn-stopped')).toEqual(redrawHistoryAtCleanup);
  });

  it('renders compact activity lines for git, web_fetch, and summary_tool', () => {
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
      toolName: 'git',
      toolCallId: 'call-git',
      inputPreview: '{"args":["status","--short","--branch"]}',
      inputRawRedacted: { args: ['status', '--short', '--branch'] }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'git',
      toolCallId: 'call-git',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 4,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'web_fetch',
      toolCallId: 'call-web',
      inputPreview: '{"url":"https://example.com/docs"}',
      inputRawRedacted: { url: 'https://example.com/docs', prompt: 'secret prompt text' }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'web_fetch',
      toolCallId: 'call-web',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 6,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    observer.record(createTelemetryEvent('tool_call_started', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'summary_tool',
      toolCallId: 'call-summary',
      inputPreview: '{"texts":["alpha","beta"],"mode":"memory"}',
      inputRawRedacted: { texts: ['alpha', 'beta'], mode: 'memory', dedupeSentences: true }
    }));
    observer.record(createTelemetryEvent('tool_call_completed', 'tool_execution', {
      turnId: 'turn-1',
      providerRound: 1,
      toolRound: 1,
      toolName: 'summary_tool',
      toolCallId: 'call-summary',
      isError: false,
      resultPreview: 'ok',
      resultRawRedacted: { content: 'ok' },
      durationMs: 8,
      resultSizeChars: 2,
      resultSizeBucket: 'small'
    }));

    expect(lines).toEqual([
      '· git status --short --branch',
      '· web fetch https://example.com/docs',
      '· summarize memory'
    ]);
    expect(replaced).toEqual(new Map([
      ['call-git', '· git status --short --branch | done (4ms)'],
      ['call-web', '· web fetch https://example.com/docs | done (6ms)'],
      ['call-summary', '· summarize memory | done (8ms)']
    ]));
    expect(lines.join('\n')).not.toContain('secret prompt text');
  });

  it('renders fallback activity lines for unknown tools', () => {
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
      inputPreview: '{"action":"inspect","path":"secret.txt"}',
      inputRawRedacted: { action: 'inspect', path: 'secret.txt' }
    }));

    expect(lines).toEqual(['· Read inspect secret.txt']);
  });

  it('renders specialist selection as a compact activity line', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('specialist_selected', 'provider_decision', {
      turnId: 'turn-specialist',
      providerRound: 1,
      toolRound: 0,
      sessionId: 'session-1',
      kind: 'review',
      routeReason: 'explicit',
      matchedRule: '/review',
      contextChars: 128,
      historyMessageCount: 4
    }));

    expect(lines).toEqual(['· using review specialist']);
  });

  it('renders specialist parse fallback as a compact activity line', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('specialist_parse_failed', 'response_composition', {
      turnId: 'turn-specialist',
      providerRound: 1,
      toolRound: 0,
      sessionId: 'session-1',
      kind: 'debug',
      routeReason: 'heuristic',
      matchedRule: 'debug_keywords',
      contextChars: 128,
      historyMessageCount: 4,
      fallbackReason: 'invalid_json'
    }));

    expect(lines).toEqual(['· debug specialist fell back to unstructured output']);
  });

  it('renders explicit specialist failure as a compact activity line', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
        lines.push(text);
      }
    });

    observer.record(createTelemetryEvent('specialist_failed', 'completion_check', {
      turnId: 'turn-specialist',
      providerRound: 1,
      toolRound: 0,
      sessionId: 'session-1',
      kind: 'review',
      routeReason: 'explicit',
      matchedRule: '/review',
      contextChars: 128,
      historyMessageCount: 4,
      failureReason: 'execution_error'
    }));

    expect(lines).toEqual(['· review specialist failed']);
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
      cacheReadInputTokens: 0,
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

  it('renders cached input tokens in the footer when present', () => {
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
      turnId: 'turn-cache',
      providerRound: 2,
      toolRound: 0,
      stopReason: 'completed',
      toolRoundsUsed: 0,
      isVerified: true,
      durationMs: 2100
    }));
    observer.record(createTelemetryEvent('turn_summary', 'completion_check', {
      turnId: 'turn-cache',
      providerRound: 2,
      toolRound: 0,
      providerRounds: 2,
      toolRoundsUsed: 0,
      toolCallsTotal: 0,
      toolCallsByName: {},
      inputTokensTotal: 516,
      outputTokensTotal: 274,
      cacheReadInputTokens: 128,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));

    observer.flushPendingFooter?.();

    expect(lines).toEqual(['─ completed • 2 provider • 516 in / 274 out / 128 cached (25%) • 2.1s']);
  });

  it('renders cached input tokens with a dimmed ratio in interactive mode', () => {
    const lines: string[] = [];
    const observer = createCompactCliTelemetryObserver({
      mode: 'interactive',
      writeActivityLine(text) {
        lines.push(text);
      },
      writeFooterLine(text) {
        lines.push(text);
      }
    }) as ReturnType<typeof createCompactCliTelemetryObserver> & { flushPendingFooter?: () => void };

    observer.record(createTelemetryEvent('turn_completed', 'completion_check', {
      turnId: 'turn-interactive-cache',
      providerRound: 2,
      toolRound: 0,
      stopReason: 'completed',
      toolRoundsUsed: 0,
      isVerified: true,
      durationMs: 2100
    }));
    observer.record(createTelemetryEvent('turn_summary', 'completion_check', {
      turnId: 'turn-interactive-cache',
      providerRound: 2,
      toolRound: 0,
      providerRounds: 2,
      toolRoundsUsed: 0,
      toolCallsTotal: 0,
      toolCallsByName: {},
      inputTokensTotal: 516,
      outputTokensTotal: 274,
      cacheReadInputTokens: 128,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));

    observer.flushPendingFooter?.();

    expect(lines).toEqual([
      `${pc.dim('─'.repeat(54))}\n${pc.green('✔')} ${pc.green(pc.bold('DONE'))} • 2 provider${pc.dim(' • ')}516 in / 274 out / ${pc.dim('128 cached (25%)')}${pc.dim(' • ')}⏱️2.1s`
    ]);
  });

  it('renders the compact base footer without CLI-only verification and tool-round details', () => {
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
      cacheReadInputTokens: 0,
      promptCharsMax: 100,
      toolResultCharsInFinalPrompt: 0,
      assistantToolCallCharsInFinalPrompt: 0,
      toolResultPromptGrowthCharsTotal: 0,
      toolResultCharsAddedAcrossTurn: 0,
      turnCompleted: true,
      stopReason: 'completed'
    }));

    observer.flushPendingFooter?.();

    expect(lines).toEqual(['─ completed • 2 provider • 3 tools • 516 in / 274 out • 4.8s']);
  });
});
