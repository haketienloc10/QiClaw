import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../../src/core/types.js';
import { createInteractiveTurnController } from '../../src/ui/App.js';

describe('createInteractiveTurnController', () => {
  it('appends the user message and an assistant placeholder before the turn finishes', async () => {
    let resolveTurn: ((value: {
      finalAnswer: string;
      history: Message[];
      historySummary?: string;
    }) => void) | undefined;
    const onTurnSettled = vi.fn();

    const runTurn = vi.fn(() => new Promise<{
      finalAnswer: string;
      history: Message[];
      historySummary?: string;
    }>((resolve) => {
      resolveTurn = resolve;
    }));

    const controller = createInteractiveTurnController({
      initialMessages: [],
      initialHistorySummary: undefined,
      runTurn,
      onTurnSettled
    });

    const firstSubmit = controller.submitTurn('first prompt');

    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: true,
      isThinking: true,
      draft: '',
      messages: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: '' }
      ]
    });
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith({
      userInput: 'first prompt',
      history: [],
      historySummary: undefined,
      onEvent: expect.any(Function)
    });
    expect(onTurnSettled).not.toHaveBeenCalled();

    resolveTurn?.({
      finalAnswer: 'first answer',
      history: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first answer' }
      ],
      historySummary: 'summary after first prompt'
    });

    await expect(firstSubmit).resolves.toEqual({ accepted: true });
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: false,
      isThinking: false,
      historySummary: 'summary after first prompt',
      messages: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first answer' }
      ]
    });
  });

  it('tracks tool activity, usage, and completion status from streaming events', async () => {
    let resolveTurn: ((value: {
      finalAnswer: string;
      history: Message[];
      historySummary?: string;
    }) => void) | undefined;
    const onTurnSettled = vi.fn();

    const runTurn = vi.fn((input: {
      userInput: string;
      history: Message[];
      historySummary?: string;
      onEvent(event: {
        type: 'text_delta'; delta: string
      } | {
        type: 'tool_call'; toolCall: { id: string; name: string; input: unknown }
      } | {
        type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
      } | {
        type: 'completed'; response: { message: Message; toolCalls: [] }
      }): void;
    }) => {
      input.onEvent({ type: 'tool_call', toolCall: { id: 'tool-1', name: 'read_file', input: {} } });
      input.onEvent({ type: 'tool_call', toolCall: { id: 'tool-2', name: 'read_file', input: {} } });
      input.onEvent({ type: 'usage', usage: { inputTokens: 10, outputTokens: 32, totalTokens: 42 } });
      input.onEvent({ type: 'completed', response: { message: { role: 'assistant', content: 'done' }, toolCalls: [] } });
      return new Promise<{
        finalAnswer: string;
        history: Message[];
        historySummary?: string;
      }>((resolve) => {
        resolveTurn = resolve;
      });
    });

    const controller = createInteractiveTurnController({
      initialMessages: [],
      initialHistorySummary: undefined,
      runTurn,
      onTurnSettled
    });

    const submit = controller.submitTurn('stream me');

    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: true,
      isThinking: true,
      toolActivities: [
        { id: 'tool-1', name: 'read_file', status: 'completed' },
        { id: 'tool-2', name: 'read_file', status: 'completed' }
      ],
      latestUsage: { inputTokens: 10, outputTokens: 32, totalTokens: 42 },
      statusText: 'Completed'
    });

    resolveTurn?.({
      finalAnswer: 'done',
      history: [
        { role: 'user', content: 'stream me' },
        { role: 'assistant', content: 'done' }
      ]
    });

    await expect(submit).resolves.toEqual({ accepted: true });
    expect(onTurnSettled).toHaveBeenCalledOnce();
  });

  it('keeps the composer locked when synchronous streaming text deltas arrive', async () => {
    let resolveTurn: ((value: {
      finalAnswer: string;
      history: Message[];
      historySummary?: string;
    }) => void) | undefined;
    const onTurnSettled = vi.fn();

    const runTurn = vi.fn((input: {
      userInput: string;
      history: Message[];
      historySummary?: string;
      onEvent(event: { type: 'text_delta'; delta: string }): void;
    }) => {
      input.onEvent({ type: 'text_delta', delta: 'hello' });
      return new Promise<{
        finalAnswer: string;
        history: Message[];
        historySummary?: string;
      }>((resolve) => {
        resolveTurn = resolve;
      });
    });

    const controller = createInteractiveTurnController({
      initialMessages: [],
      initialHistorySummary: undefined,
      runTurn,
      onTurnSettled
    });

    const submit = controller.submitTurn('stream me');

    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: true,
      isThinking: true,
      messages: [
        { role: 'user', content: 'stream me' },
        { role: 'assistant', content: 'hello' }
      ]
    });

    resolveTurn?.({
      finalAnswer: 'hello world',
      history: [
        { role: 'user', content: 'stream me' },
        { role: 'assistant', content: 'hello world' }
      ]
    });

    await expect(submit).resolves.toEqual({ accepted: true });
    expect(onTurnSettled).toHaveBeenCalledOnce();
  });

  it('locks composer and ignores a new submit while the current turn is still running', async () => {
    let resolveTurn: ((value: {
      finalAnswer: string;
      history: Message[];
      historySummary?: string;
    }) => void) | undefined;
    const onTurnSettled = vi.fn();

    const runTurn = vi.fn(() => new Promise<{
      finalAnswer: string;
      history: Message[];
      historySummary?: string;
    }>((resolve) => {
      resolveTurn = resolve;
    }));

    const controller = createInteractiveTurnController({
      initialMessages: [],
      initialHistorySummary: undefined,
      runTurn,
      onTurnSettled
    });

    const firstSubmit = controller.submitTurn('first prompt');

    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: true,
      isThinking: true,
      draft: ''
    });
    expect(runTurn).toHaveBeenCalledTimes(1);

    await expect(controller.submitTurn('second prompt')).resolves.toEqual({ accepted: false });
    expect(runTurn).toHaveBeenCalledTimes(1);

    resolveTurn?.({
      finalAnswer: 'first answer',
      history: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first answer' }
      ],
      historySummary: 'summary after first prompt'
    });

    await expect(firstSubmit).resolves.toEqual({ accepted: true });
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: false,
      isThinking: false,
      historySummary: 'summary after first prompt',
      messages: [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first answer' }
      ]
    });
  });

  it('rolls back optimistic messages when a turn fails', async () => {
    let rejectTurn: ((error?: unknown) => void) | undefined;
    const onTurnSettled = vi.fn();

    const controller = createInteractiveTurnController({
      initialMessages: [
        { role: 'user', content: 'previous prompt' },
        { role: 'assistant', content: 'previous answer' }
      ],
      initialHistorySummary: 'previous summary',
      runTurn: vi.fn(() => new Promise<{
        finalAnswer: string;
        history: Message[];
        historySummary?: string;
      }>((_resolve, reject) => {
        rejectTurn = reject;
      })),
      onTurnSettled
    });

    controller.setDraft('first prompt');

    const firstSubmit = controller.submitTurn('first prompt');
    expect(controller.getSnapshot()).toMatchObject({
      composerLocked: true,
      isThinking: true,
      messages: [
        { role: 'user', content: 'previous prompt' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: '' }
      ]
    });

    await expect(controller.submitTurn('second prompt')).resolves.toEqual({ accepted: false });

    rejectTurn?.(new Error('provider failed'));

    await expect(firstSubmit).rejects.toThrow('provider failed');
    expect(onTurnSettled).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      draft: 'first prompt',
      composerLocked: false,
      isThinking: false,
      historySummary: 'previous summary',
      messages: [
        { role: 'user', content: 'previous prompt' },
        { role: 'assistant', content: 'previous answer' }
      ]
    });
  });
});
