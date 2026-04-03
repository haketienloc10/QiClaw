import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunAgentTurnInput, RunAgentTurnResult } from '../../src/agent/loop.js';
import type { AgentRuntime } from '../../src/agent/runtime.js';
import type { AgentSpec } from '../../src/agent/spec.js';
import type { Message } from '../../src/core/types.js';
import type { ProviderResponse, ProviderStreamEvent } from '../../src/provider/model.js';
import { CheckpointStore } from '../../src/session/checkpointStore.js';
import type { TelemetryObserver } from '../../src/telemetry/observer.js';
import { parseInteractiveCheckpointJson } from '../../src/session/session.js';
import { createInteractiveAppProps, runInteractiveApp } from '../../src/ui/runInteractiveApp.js';

vi.mock('ink', () => ({
  render: vi.fn(() => ({
    waitUntilExit: vi.fn(async () => undefined)
  }))
}));

vi.mock('../../src/ui/App.js', () => ({
  default: vi.fn(() => null)
}));

function createObserverStub(): TelemetryObserver {
  return { record() {} };
}

function createAgentSpecStub(): AgentSpec {
  return {
    identity: {
      purpose: 'test',
      behavioralFraming: 'test',
      scopeBoundary: 'test'
    },
    capabilities: {
      allowedCapabilityClasses: [],
      operatingSurface: 'test',
      capabilityExclusions: []
    },
    policies: {
      safetyStance: 'test',
      toolUsePolicy: 'test',
      escalationPolicy: 'test',
      mutationPolicy: 'test'
    },
    completion: {
      completionMode: 'test',
      doneCriteriaShape: 'test',
      evidenceRequirement: 'test',
      stopVsDoneDistinction: 'test',
      maxToolRounds: 3
    }
  };
}

function createRuntimeStub(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    provider: {
      name: 'test-provider',
      model: 'test-model',
      async generate() {
        throw new Error('not used');
      }
    },
    availableTools: [],
    cwd: '/tmp/app',
    observer: createObserverStub(),
    agentSpec: createAgentSpecStub(),
    systemPrompt: 'system prompt',
    maxToolRounds: 3,
    ...overrides
  };
}

function createTurnResult(overrides: Partial<RunAgentTurnResult & { historySummary?: string }> = {}): RunAgentTurnResult & { historySummary?: string } {
  return {
    stopReason: 'completed',
    finalAnswer: 'fallback answer',
    history: [],
    toolRoundsUsed: 0,
    doneCriteria: {
      goal: 'test goal',
      checklist: ['test goal'],
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
    },
    ...overrides
  };
}

describe('runInteractiveApp', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createCheckpointStore(): Promise<CheckpointStore> {
    const tempDir = await mkdtemp(join(tmpdir(), 'run-interactive-app-'));
    tempDirs.push(tempDir);
    return new CheckpointStore(join(tempDir, 'checkpoint.sqlite'));
  }

  it('uses streaming turn execution when the provider supports generateStream', async () => {
    const { render } = await import('ink');

    const executeTurn = vi.fn(async (_input: RunAgentTurnInput & { sessionId?: string }) => createTurnResult());
    const checkpointStore = await createCheckpointStore();
    const flushPendingFooter = vi.fn();

    const runtime = createRuntimeStub({
      provider: {
        name: 'test-provider',
        model: 'test-model',
        async generate() {
          throw new Error('not used');
        },
        async generateStream(_request, onEvent) {
          onEvent({ type: 'text_delta', delta: 'hello' });
          onEvent({ type: 'tool_call', toolCall: { id: 'tool-1', name: 'read_file', input: {} } });
          onEvent({ type: 'usage', usage: { totalTokens: 42 } });
          const response: ProviderResponse = {
            message: { role: 'assistant', content: 'hello' },
            toolCalls: []
          };
          onEvent({ type: 'completed', response });
          return response;
        }
      }
    });

    const appProps = createInteractiveAppProps({
      runtime,
      checkpointStore,
      sessionId: 'session-1',
      history: [],
      historySummary: undefined,
      executeTurn,
      flushPendingFooter
    });

    const streamedEvents: ProviderStreamEvent[] = [];
    const turnResult = await appProps.runTurn?.({
      userInput: 'streamed prompt',
      history: [],
      historySummary: undefined,
      onEvent(event) {
        streamedEvents.push(event);
      }
    });

    expect(streamedEvents).toEqual([
      { type: 'text_delta', delta: 'hello' },
      { type: 'tool_call', toolCall: { id: 'tool-1', name: 'read_file', input: {} } },
      { type: 'usage', usage: { totalTokens: 42 } },
      {
        type: 'completed',
        response: {
          message: { role: 'assistant', content: 'hello' },
          toolCalls: []
        }
      }
    ]);
    expect(turnResult?.history).toEqual([
      { role: 'user', content: 'streamed prompt' },
      { role: 'assistant', content: 'hello' }
    ]);
    expect(turnResult?.finalAnswer).toBe('hello');
    expect(executeTurn).not.toHaveBeenCalled();

    const checkpoint = checkpointStore.getBySessionId('session-1');
    expect(checkpoint).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      taskId: 'interactive',
      status: 'completed'
    }));
    expect(parseInteractiveCheckpointJson(checkpoint!.checkpointJson)).toEqual({
      version: 1,
      history: [
        { role: 'user', content: 'streamed prompt' },
        { role: 'assistant', content: 'hello' }
      ],
      historySummary: undefined
    });
    expect(flushPendingFooter).not.toHaveBeenCalled();
    appProps.onTurnSettled?.();
    expect(flushPendingFooter).toHaveBeenCalledOnce();

    await runInteractiveApp({
      runtime,
      checkpointStore,
      sessionId: 'session-1',
      history: [],
      historySummary: undefined,
      executeTurn,
      flushPendingFooter
    });

    expect(render).toHaveBeenCalledOnce();
  });

  it('falls back to executeTurn when the provider does not support generateStream', async () => {
    const fallbackHistory: Message[] = [
      { role: 'user', content: 'plain prompt' },
      { role: 'assistant', content: 'fallback answer' }
    ];
    const fallbackResult = createTurnResult({
      finalAnswer: 'fallback answer',
      history: fallbackHistory,
      historySummary: 'fallback summary'
    });

    const executeTurn = vi.fn(async (_input: RunAgentTurnInput & { sessionId?: string }) => fallbackResult);
    const checkpointStore = await createCheckpointStore();
    const flushPendingFooter = vi.fn();

    const runtime = createRuntimeStub();

    const appProps = createInteractiveAppProps({
      runtime,
      checkpointStore,
      sessionId: 'session-1',
      history: [],
      historySummary: undefined,
      executeTurn,
      flushPendingFooter
    });

    const turnResult = await appProps.runTurn?.({
      userInput: 'plain prompt',
      history: [],
      historySummary: undefined,
      onEvent() {}
    });

    expect(executeTurn).toHaveBeenCalledOnce();
    expect(executeTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      userInput: 'plain prompt'
    }));
    expect(turnResult).toBe(fallbackResult);

    const checkpoint = checkpointStore.getBySessionId('session-1');
    expect(parseInteractiveCheckpointJson(checkpoint!.checkpointJson)).toEqual({
      version: 1,
      history: fallbackHistory,
      historySummary: 'fallback summary'
    });
    expect(flushPendingFooter).not.toHaveBeenCalled();
    appProps.onTurnSettled?.();
    expect(flushPendingFooter).toHaveBeenCalledOnce();
  });

  it('does not save a checkpoint or flush the footer before a failing turn settles', async () => {
    const executeTurn = vi.fn(async (_input: RunAgentTurnInput & { sessionId?: string }) => {
      throw new Error('turn failed');
    });
    const checkpointStore = await createCheckpointStore();
    const flushPendingFooter = vi.fn();

    const runtime = createRuntimeStub();

    const appProps = createInteractiveAppProps({
      runtime,
      checkpointStore,
      sessionId: 'session-1',
      history: [],
      historySummary: undefined,
      executeTurn,
      flushPendingFooter
    });

    await expect(appProps.runTurn?.({
      userInput: 'plain prompt',
      history: [],
      historySummary: undefined,
      onEvent() {}
    })).rejects.toThrow('turn failed');

    expect(checkpointStore.getBySessionId('session-1')).toBeUndefined();
    expect(flushPendingFooter).not.toHaveBeenCalled();
    appProps.onTurnSettled?.();
    expect(flushPendingFooter).toHaveBeenCalledOnce();
  });
});
