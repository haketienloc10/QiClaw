import { describe, expect, it, vi } from 'vitest';

import type { ModelProvider } from '../../src/provider/model.js';
import { createNoopObserver } from '../../src/telemetry/observer.js';
import type { RunAgentTurnResult } from '../../src/agent/loop.js';
import { getBuiltinTools } from '../../src/tools/registry.js';
import { runSpecialistAwareTurn } from '../../src/specialist/entrypoint.js';

const runSpecialistOrchestratorMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/specialist/orchestrator.js', () => ({
  runSpecialistOrchestrator: runSpecialistOrchestratorMock
}));

describe('runSpecialistAwareTurn', () => {
  it('does not silently fall back to the main turn when specialist orchestration fails', async () => {
    const provider: ModelProvider = {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('provider.generate should not be called directly in this mocked test');
      }
    };
    const executeMainTurn = vi.fn().mockResolvedValue({
      stopReason: 'completed',
      finalAnswer: 'main fallback answer',
      history: [],
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'review this patch',
        checklist: ['review this patch'],
        requiresNonEmptyFinalAnswer: true,
        requiresToolEvidence: false,
        requiresSubstantiveFinalAnswer: false,
        forbidSuccessAfterToolErrors: false
      },
      verification: {
        isVerified: true,
        finalAnswerIsNonEmpty: true,
        finalAnswerIsSubstantive: true,
        toolEvidenceSatisfied: true,
        noUnresolvedToolErrors: true,
        toolMessagesCount: 0,
        checks: []
      }
    });

    runSpecialistOrchestratorMock.mockRejectedValue(new Error('specialist runtime exploded'));

    await expect(runSpecialistAwareTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'system prompt',
      userInput: '/review review this patch',
      cwd: '/tmp/qiclaw-specialist-entrypoint',
      maxToolRounds: 10,
      observer: createNoopObserver(),
      history: [],
      historySummary: undefined,
      memoryText: '',
      sessionId: 'session-1'
    }, executeMainTurn)).rejects.toThrow('specialist runtime exploded');

    expect(executeMainTurn).not.toHaveBeenCalled();
  });

  it('does not return a completed specialist turn when the specialist artifact was not parsed', async () => {
    const provider: ModelProvider = {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('provider.generate should not be called directly in this mocked test');
      }
    };
    const executeMainTurn = vi.fn();

    runSpecialistOrchestratorMock.mockResolvedValue({
      mode: 'specialist',
      artifact: {
        kind: 'review',
        summary: 'Could not parse specialist output into a structured artifact.',
        confidence: 0.2,
        suggestedNextSteps: ['Review the raw specialist output manually.'],
        findings: [],
        blockingIssues: [],
        nonBlockingIssues: ['raw text output'],
        verdict: 'needs_followup'
      },
      finalAnswer: 'raw text output',
      parsed: false,
      rawOutput: 'raw text output'
    });

    await expect(runSpecialistAwareTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'system prompt',
      userInput: '/review review this patch',
      cwd: '/tmp/qiclaw-specialist-entrypoint',
      maxToolRounds: 10,
      observer: createNoopObserver(),
      history: [],
      historySummary: undefined,
      memoryText: '',
      sessionId: 'session-1'
    }, executeMainTurn)).rejects.toThrow(/parse|structured|artifact/i);

    expect(executeMainTurn).not.toHaveBeenCalled();
  });

  it('re-enters the main turn with structured specialist handoff instead of fabricating a completed turn', async () => {
    const provider: ModelProvider = {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('provider.generate should not be called directly in this mocked test');
      }
    };
    const mainTurnResult: RunAgentTurnResult = {
      stopReason: 'completed',
      finalAnswer: 'main synthesized answer',
      history: [
        { role: 'user', content: '/review review this patch' },
        { role: 'assistant', content: 'main synthesized answer' }
      ],
      memoryCandidates: [],
      structuredOutputParsed: true,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'review this patch',
        checklist: ['review this patch'],
        requiresNonEmptyFinalAnswer: true,
        requiresToolEvidence: false,
        requiresSubstantiveFinalAnswer: false,
        forbidSuccessAfterToolErrors: false
      },
      verification: {
        isVerified: true,
        finalAnswerIsNonEmpty: true,
        finalAnswerIsSubstantive: true,
        toolEvidenceSatisfied: true,
        noUnresolvedToolErrors: true,
        toolMessagesCount: 0,
        checks: []
      }
    };
    const executeMainTurn = vi.fn().mockResolvedValue(mainTurnResult);

    runSpecialistOrchestratorMock.mockResolvedValue({
      mode: 'specialist',
      artifact: {
        kind: 'review',
        summary: 'Found one blocking invariant break.',
        confidence: 0.82,
        suggestedNextSteps: ['Restore the guard clause.'],
        findings: [
          {
            severity: 'high',
            title: 'Missing guard clause',
            details: 'The patch bypasses an invariant check.'
          }
        ],
        blockingIssues: ['Missing guard clause'],
        nonBlockingIssues: [],
        verdict: 'changes_requested'
      },
      finalAnswer: 'Verdict: changes_requested',
      parsed: true,
      rawOutput: '{"kind":"review"}'
    });

    const result = await runSpecialistAwareTurn({
      provider,
      availableTools: getBuiltinTools(),
      baseSystemPrompt: 'system prompt',
      userInput: '/review review this patch',
      cwd: '/tmp/qiclaw-specialist-entrypoint',
      maxToolRounds: 10,
      observer: createNoopObserver(),
      history: [{ role: 'user', content: 'Earlier request' }],
      historySummary: 'Older summary',
      memoryText: 'Memory section',
      blueprintText: 'Blueprint section',
      sessionId: 'session-1'
    }, executeMainTurn);

    expect(result).toBe(mainTurnResult);
    expect(executeMainTurn).toHaveBeenCalledOnce();
    expect(executeMainTurn.mock.calls[0]?.[0].userInput).toContain('Structured specialist artifact');
    expect(executeMainTurn.mock.calls[0]?.[0].userInput).toContain('Found one blocking invariant break.');
    expect(executeMainTurn.mock.calls[0]?.[0].userInput).toContain('Verdict: changes_requested');
    expect(executeMainTurn.mock.calls[0]?.[0].history).toEqual([{ role: 'user', content: 'Earlier request' }]);
    expect(executeMainTurn.mock.calls[0]?.[0].historySummary).toBe('Older summary');
    expect(executeMainTurn.mock.calls[0]?.[0].memoryText).toBe('Memory section');
    expect(executeMainTurn.mock.calls[0]?.[0].blueprintText).toBe('Blueprint section');
  });
});
