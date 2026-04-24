import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../../src/core/types.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';
import { createCompositeObserver } from '../../src/telemetry/composite.js';
import { getBuiltinToolNames, getBuiltinTools } from '../../src/tools/registry.js';
import { buildSpecialistBrief } from '../../src/specialist/context.js';
import { runSpecialistOrchestrator } from '../../src/specialist/orchestrator.js';

const baseMessages: Message[] = [
  { role: 'user', content: 'Earlier question' },
  { role: 'assistant', content: 'Earlier answer' },
  { role: 'user', content: 'Newest relevant request' }
];

describe('buildSpecialistBrief', () => {
  it('keeps specialist context isolated from the full main history', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`
    })) satisfies Message[];

    const brief = buildSpecialistBrief({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      specialist: 'research',
      userInput: 'Analyze this subsystem.',
      history,
      historySummary: 'Summary of older context.',
      memoryText: 'Large memory dump that should not be forwarded wholesale.'
    });

    expect(brief.kind).toBe('research');
    expect(brief.goal).toBe('Analyze this subsystem.');
    expect(brief.relevantContext).toContain('Summary of older context.');
    expect(brief.relevantContext).not.toContain('Large memory dump');
    expect(brief.evidenceSnippets).toHaveLength(4);
    expect(brief.evidenceSnippets?.join('\n')).not.toContain('message-0');
  });
});

describe('runSpecialistOrchestrator', () => {
  it('keeps the old flow when no specialist matches', async () => {
    const executeMainTurn = vi.fn().mockResolvedValue({ ok: true, mode: 'main' });
    const executeSpecialistTurn = vi.fn();

    const result = await runSpecialistOrchestrator({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      userInput: 'Hello there',
      history: baseMessages,
      historySummary: '',
      memoryText: '',
      availableTools: getBuiltinTools(),
      executeMainTurn,
      executeSpecialistTurn,
      observer: createCompositeObserver([])
    });

    expect(result).toEqual({ ok: true, mode: 'main' });
    expect(executeMainTurn).toHaveBeenCalledOnce();
    expect(executeSpecialistTurn).not.toHaveBeenCalled();
  });

  it('passes only specialist-allowed tools and emits telemetry for specialist runs', async () => {
    const events: string[] = [];
    const observer = createCompositeObserver([
      {
        record(event) {
          events.push(event.type);
        }
      }
    ]);
    const executeMainTurn = vi.fn();
    const executeSpecialistTurn = vi.fn().mockResolvedValue({
      artifact: {
        kind: 'review',
        summary: 'Review completed.',
        confidence: 0.76,
        suggestedNextSteps: ['Apply the blocking fix.'],
        findings: [
          {
            severity: 'high',
            title: 'Invariant break',
            details: 'The patch skips a guard clause.'
          }
        ],
        blockingIssues: ['Restore the missing guard clause.'],
        nonBlockingIssues: [],
        verdict: 'changes_requested'
      },
      rawOutput: '{"kind":"review"}',
      parsed: true,
      finalAnswer: 'Review completed.',
      toolNames: ['file', 'shell', 'git', 'web_fetch']
    });

    const result = await runSpecialistOrchestrator({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      userInput: '/review please check this patch for regressions',
      history: baseMessages,
      historySummary: 'Older summary',
      memoryText: 'Memory text should stay out of the specialist brief',
      availableTools: getBuiltinTools(),
      executeMainTurn,
      executeSpecialistTurn,
      observer
    });

    expect(executeMainTurn).not.toHaveBeenCalled();
    expect(executeSpecialistTurn).toHaveBeenCalledOnce();
    expect(executeSpecialistTurn.mock.calls[0]?.[0].availableTools.map((tool: { name: string }) => tool.name)).toEqual([
      'file',
      'shell',
      'git',
      'web_fetch'
    ]);
    if (typeof result !== 'object' || result === null || !('mode' in result) || result.mode !== 'specialist' || !('artifact' in result)) {
      throw new Error('expected specialist result');
    }
    const specialistResult = result as { mode: 'specialist'; artifact: { kind: string } };
    expect(specialistResult.artifact.kind).toBe('review');
    expect(events).toEqual(['specialist_selected', 'specialist_started', 'specialist_completed']);
  });

  it('emits parse failure telemetry when specialist output falls back', async () => {
    const events: string[] = [];
    const observer = {
      record(event: ReturnType<typeof createTelemetryEvent>) {
        events.push(event.type);
      }
    };

    const result = await runSpecialistOrchestrator({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      userInput: '/debug inspect this crash',
      history: baseMessages,
      historySummary: '',
      memoryText: '',
      availableTools: getBuiltinTools(),
      executeMainTurn: vi.fn(),
      executeSpecialistTurn: vi.fn().mockResolvedValue({
        artifact: {
          kind: 'debug',
          summary: 'Could not parse specialist output.',
          confidence: 0.2,
          suggestedNextSteps: ['Review the raw output manually.'],
          likelyCauses: [],
          evidence: [],
          proposedFixes: [],
          unresolvedRisks: []
        },
        rawOutput: 'not json',
        parsed: false,
        finalAnswer: 'Could not parse specialist output.',
        toolNames: ['file', 'shell', 'git', 'web_fetch']
      }),
      observer
    });

    if (typeof result !== 'object' || result === null || !('mode' in result) || result.mode !== 'specialist') {
      throw new Error('expected specialist result');
    }
    expect(events).toContain('specialist_parse_failed');
  });

  it('emits explicit failure telemetry when specialist execution throws', async () => {
    const events: string[] = [];
    const observer = {
      record(event: ReturnType<typeof createTelemetryEvent>) {
        events.push(event.type);
      }
    };

    await expect(runSpecialistOrchestrator({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      userInput: '/debug inspect this crash',
      history: baseMessages,
      historySummary: '',
      memoryText: '',
      availableTools: getBuiltinTools(),
      executeMainTurn: vi.fn(),
      executeSpecialistTurn: vi.fn().mockRejectedValue(new Error('debug specialist crashed')),
      observer
    })).rejects.toThrow('debug specialist crashed');

    expect(events).toContain('specialist_failed');
  });

  it('filters specialist tools by capability class and explicit tool names', async () => {
    const executeSpecialistTurn = vi.fn().mockResolvedValue({
      artifact: {
        kind: 'research',
        summary: 'Research completed.',
        confidence: 0.71,
        suggestedNextSteps: ['Inspect the matching file next.'],
        findings: ['Found the relevant module.'],
        openQuestions: [],
        evidence: ['src/module.ts']
      },
      rawOutput: '{"kind":"research"}',
      parsed: true,
      finalAnswer: 'Research completed.',
      toolNames: ['file', 'git']
    });

    await runSpecialistOrchestrator({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      userInput: '/research find the relevant module',
      history: baseMessages,
      historySummary: 'Older summary',
      memoryText: '',
      availableTools: getBuiltinTools(),
      executeMainTurn: vi.fn(),
      executeSpecialistTurn,
      observer: createCompositeObserver([])
    });

    expect(getBuiltinToolNames()).toContain('summary_tool');
    expect(executeSpecialistTurn).toHaveBeenCalledOnce();
    expect(executeSpecialistTurn.mock.calls[0]?.[0].availableTools.map((tool: { name: string }) => tool.name)).toEqual([
      'file',
      'shell',
      'git',
      'web_fetch'
    ]);
  });

  it('treats "current patch" review requests as reviewing the current workspace diff', async () => {
    const executeSpecialistTurn = vi.fn().mockResolvedValue({
      artifact: {
        kind: 'review',
        summary: 'Review completed.',
        confidence: 0.8,
        suggestedNextSteps: [],
        findings: [],
        blockingIssues: [],
        nonBlockingIssues: [],
        verdict: 'pass'
      },
      rawOutput: '{"kind":"review"}',
      parsed: true,
      finalAnswer: 'Review completed.',
      toolNames: ['file', 'git']
    });

    await runSpecialistOrchestrator({
      sessionId: 'session-1',
      parentTaskId: 'turn-1',
      userInput: '/review kiểm tra code bản vá hiện tại?',
      history: baseMessages,
      historySummary: 'Older summary',
      memoryText: '',
      availableTools: getBuiltinTools(),
      executeMainTurn: vi.fn(),
      executeSpecialistTurn,
      observer: createCompositeObserver([])
    });

    expect(executeSpecialistTurn).toHaveBeenCalledOnce();
    expect(executeSpecialistTurn.mock.calls[0]?.[0].brief.goal).toContain('current workspace diff');
  });
});
