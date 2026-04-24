import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelProvider } from '../../src/provider/model.js';
import { createNoopObserver } from '../../src/telemetry/observer.js';
import { getBuiltinTools } from '../../src/tools/registry.js';
import { executeSpecialistTurn } from '../../src/specialist/runtime.js';
import { getSpecialistDefinition } from '../../src/specialist/registry.js';

const runAgentTurnMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/agent/loop.js', () => ({
  runAgentTurn: runAgentTurnMock
}));

describe('review specialist runtime', () => {
  beforeEach(() => {
    runAgentTurnMock.mockReset();
  });

  it('runs the isolated specialist turn with a 10-round tool budget', async () => {
    const provider: ModelProvider = {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('provider.generate should not be called directly in this mocked test');
      }
    };

    runAgentTurnMock.mockResolvedValue({
      stopReason: 'completed',
      finalAnswer: JSON.stringify({
        kind: 'review',
        summary: 'No blocking regressions found.',
        confidence: 0.82,
        suggestedNextSteps: [],
        findings: [],
        blockingIssues: [],
        nonBlockingIssues: [],
        verdict: 'pass'
      }),
      history: [],
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'review',
        checklist: ['review'],
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

    await executeSpecialistTurn({
      provider,
      cwd: '/tmp/qiclaw-review-runtime',
      brief: {
        kind: 'review',
        goal: 'Check whether the current patch introduces serious regressions.',
        relevantContext: 'Changed files include src/config.ts and tests/config.test.ts',
        constraints: ['Use only the provided brief and evidence snippets.'],
        evidenceSnippets: ['user: please review this patch for regressions']
      },
      availableTools: getBuiltinTools(),
      observer: createNoopObserver()
    });

    expect(runAgentTurnMock).toHaveBeenCalledOnce();
    expect(runAgentTurnMock.mock.calls[0]?.[0]).toMatchObject({
      maxToolRounds: 10,
      history: []
    });
  });

  it('includes review findings details and verdict in the user-facing output', async () => {
    const provider: ModelProvider = {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('provider.generate should not be called directly in this mocked test');
      }
    };

    runAgentTurnMock.mockResolvedValue({
      stopReason: 'completed',
      finalAnswer: JSON.stringify({
        kind: 'review',
        summary: 'Patch introduces a regression in the guard path.',
        confidence: 0.88,
        suggestedNextSteps: ['Restore the guard clause.'],
        findings: [
          {
            severity: 'high',
            title: 'Missing guard clause',
            details: 'The patched path now dereferences config before validating it, which can crash startup.'
          },
          {
            severity: 'medium',
            title: 'Regression coverage missing',
            details: 'There is no test covering startup with an incomplete config.'
          }
        ],
        blockingIssues: ['Missing guard clause'],
        nonBlockingIssues: ['Regression coverage missing'],
        verdict: 'changes_requested'
      }),
      history: [],
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'review',
        checklist: ['review'],
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

    const result = await executeSpecialistTurn({
      provider,
      cwd: '/tmp/qiclaw-review-runtime',
      brief: {
        kind: 'review',
        goal: 'Check whether the current patch introduces serious regressions.',
        relevantContext: 'Changed files include src/config.ts and tests/config.test.ts',
        constraints: ['Use only the provided brief and evidence snippets.'],
        evidenceSnippets: ['user: please review this patch for regressions']
      },
      availableTools: getBuiltinTools(),
      observer: createNoopObserver()
    });

    expect(result.parsed).toBe(true);
    expect(result.finalAnswer).toContain('Verdict: changes_requested');
    expect(result.finalAnswer).toContain('Summary: Patch introduces a regression in the guard path.');
    expect(result.finalAnswer).toContain('Main issue: Missing guard clause');
    expect(result.finalAnswer).toContain('Why it matters: The patched path now dereferences config before validating it, which can crash startup.');
    expect(result.finalAnswer).toContain('Also check: Regression coverage missing');
    expect(result.finalAnswer).not.toContain('[medium]');
    expect(result.finalAnswer).not.toContain('Non-blocking: Regression coverage missing');
  });

  it('keeps pass verdict review output actionable with concrete findings and next steps', async () => {
    const provider: ModelProvider = {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('provider.generate should not be called directly in this mocked test');
      }
    };

    runAgentTurnMock.mockResolvedValue({
      stopReason: 'completed',
      finalAnswer: JSON.stringify({
        kind: 'review',
        summary: 'Current patch addresses the prior blocking concern.',
        confidence: 0.91,
        suggestedNextSteps: ['Run typecheck:test before merging.'],
        findings: [
          {
            severity: 'low',
            title: 'Typecheck still needs confirmation',
            details: 'Runtime tests are green, but test-only type drift can still block completion.'
          }
        ],
        blockingIssues: [],
        nonBlockingIssues: [],
        verdict: 'pass'
      }),
      history: [],
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'review',
        checklist: ['review'],
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

    const result = await executeSpecialistTurn({
      provider,
      cwd: '/tmp/qiclaw-review-runtime-pass',
      brief: {
        kind: 'review',
        goal: 'Check whether the current patch is ready to merge.',
        relevantContext: 'Changed files include src/specialist/runtime.ts and tests/specialist/runtime.test.ts',
        constraints: ['Use only the provided brief and evidence snippets.'],
        evidenceSnippets: ['user: /review current patch']
      },
      availableTools: getBuiltinTools(),
      observer: createNoopObserver()
    });

    expect(result.finalAnswer).toContain('Verdict: pass');
    expect(result.finalAnswer).toContain('Summary: Current patch addresses the prior blocking concern.');
    expect(result.finalAnswer).toContain('Main issue: Typecheck still needs confirmation');
    expect(result.finalAnswer).toContain('Why it matters: Runtime tests are green, but test-only type drift can still block completion.');
    expect(result.finalAnswer).toContain('Next step: Run typecheck:test before merging.');
  });
});

describe('review specialist definition', () => {
  it('tells the specialist to inspect the patch or diff with available read-only tools', () => {
    const definition = getSpecialistDefinition('review');

    expect(definition.systemPrompt).toContain('Inspect the patch, diff, or changed files');
    expect(definition.systemPrompt).toContain('Use available read-only tools to gather concrete evidence before reaching a verdict.');
  });
});
