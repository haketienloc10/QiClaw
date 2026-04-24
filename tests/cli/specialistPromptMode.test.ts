import { describe, expect, it, vi } from 'vitest';

import { buildCli } from '../../src/cli/main.js';
import type { CliRunTurnResult } from '../../src/cli/main.js';
import type { ResolvedAgentPackage } from '../../src/agent/spec.js';
import type { TelemetryObserver } from '../../src/telemetry/observer.js';

function createBridgeResolvedPackage(policy: ResolvedAgentPackage['effectivePolicy']): ResolvedAgentPackage {
  return {
    preset: 'cli-bridge',
    sourceTier: 'project',
    extendsChain: ['cli-bridge'],
    packageChain: [],
    effectivePolicy: policy,
    effectivePromptOrder: ['AGENT.md'],
    effectivePromptFiles: {
      'AGENT.md': {
        filePath: '/virtual/AGENT.md',
        content: 'CLI bridge agent purpose'
      }
    },
    resolvedFiles: ['/virtual/AGENT.md']
  };
}

function createTestRuntime(cwd: string, observer?: TelemetryObserver) {
  return {
    provider: {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify({
              kind: 'review',
              summary: 'Review completed.',
              confidence: 0.82,
              suggestedNextSteps: ['Restore the missing guard clause.'],
              findings: [
                {
                  severity: 'high',
                  title: 'Invariant break',
                  details: 'The patch skips the guard clause.'
                }
              ],
              blockingIssues: ['Restore the missing guard clause.'],
              nonBlockingIssues: [],
              verdict: 'changes_requested'
            })
          },
          toolCalls: [],
          usage: undefined,
          finish: { stopReason: 'completed' }
        };
      }
    },
    availableTools: [],
    cwd,
    observer: observer ?? { record() {} },
    resolvedPackage: createBridgeResolvedPackage({ maxToolRounds: 3 }),
    systemPrompt: 'Test prompt',
    maxToolRounds: 3
  };
}

describe('buildCli specialist prompt mode', () => {
  it('routes prompt-mode specialist requests without calling the main runTurn hook', async () => {
    const writes: string[] = [];
    const runTurn = vi.fn(async (): Promise<CliRunTurnResult> => ({
      stopReason: 'completed' as const,
      finalAnswer: 'should not be called',
      history: [],
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'should not be called',
        checklist: ['should not be called'],
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
    }));

    const cli = buildCli({
      argv: ['--prompt', '/review check this patch for regressions'],
      cwd: '/tmp/qiclaw-prompt-specialist',
      stdout: {
        write(chunk: string | Uint8Array) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => createTestRuntime('/tmp/qiclaw-prompt-specialist', runtimeOptions.observer),
      runTurn
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(runTurn).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('Review completed.');
    expect(writes.join('')).toContain('Blocking: Restore the missing guard clause.');
  });
});
