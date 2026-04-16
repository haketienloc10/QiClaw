import { describe, expect, it, vi } from 'vitest';

import type { TurnEvent } from '../../src/agent/loop.js';
import { createTuiController } from '../../src/cli/tuiController.js';
import { parseBridgeMessage, type HostEvent } from '../../src/cli/tuiProtocol.js';
import { createInteractiveCheckpointJson, parseInteractiveCheckpointJson } from '../../src/session/session.js';

describe('tuiController', () => {
  it('emits session seed, slash catalog, streamed assistant events, and saves checkpoint on submit', async () => {
    const emitted: HostEvent[] = [];
    const savedRecords: Array<{ sessionId: string; checkpointJson: string }> = [];
    const checkpointJson = createInteractiveCheckpointJson({
      version: 1,
      history: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' }
      ],
      historySummary: 'previous summary'
    });

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return {
            sessionId: 'session-restored',
            taskId: 'interactive',
            status: 'running',
            checkpointJson
          };
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson });
        }
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: 'recall text',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-restored',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-restored',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 1,
          lastCompactedAt: null,
          latestSummaryText: 'saved summary'
        }
      })),
      createSessionId: () => 'session-new',
      executeTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: 'new answer',
        history: [
          { role: 'user', content: 'old question' },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: 'new question' },
          { role: 'assistant', content: 'new answer' }
        ],
        historySummary: 'updated summary',
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'new question',
          checklist: ['new question'],
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
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'new ' };
          yield { type: 'assistant_text_delta', text: 'answer' };
          yield { type: 'assistant_message_completed', text: 'new answer' };
          yield {
            type: 'turn_completed',
            finalAnswer: 'new answer',
            stopReason: 'completed',
            history: [
              { role: 'user', content: 'old question' },
              { role: 'assistant', content: 'old answer' },
              { role: 'user', content: 'new question' },
              { role: 'assistant', content: 'new answer' }
            ],
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: 'new question',
              checklist: ['new question'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true
          };
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'new answer',
          history: [
            { role: 'user', content: 'old question' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'new question' },
            { role: 'assistant', content: 'new answer' }
          ],
          historySummary: 'updated summary',
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: 'new question',
            checklist: ['new question'],
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
        })
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'new question' });

    expect(emitted[0]).toMatchObject({ type: 'hello', protocolVersion: 1, sessionId: 'session-restored' });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'transcript_seed', cells: expect.any(Array) }));
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'slash_catalog', commands: expect.any(Array) }));
    expect(emitted).toContainEqual({ type: 'assistant_delta', turnId: 'turn-2', messageId: 'assistant-2', text: 'new ' });
    expect(emitted).toContainEqual({ type: 'assistant_completed', turnId: 'turn-2', messageId: 'assistant-2', text: 'new answer' });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'turn_completed', turnId: 'turn-2', stopReason: 'completed' }));
    expect(savedRecords).toHaveLength(5);
  });

  it('appends user transcript cells for prompts, slash commands, and shell commands', async () => {
    const emitted: HostEvent[] = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-actions',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-actions',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save() {}
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: '',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-actions',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-actions',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      createSessionId: () => 'session-actions',
      executeTurn: vi.fn(async ({ userInput }) => ({
        stopReason: 'completed',
        finalAnswer: `answer for ${userInput}`,
        history: [
          { role: 'user', content: userInput },
          { role: 'assistant', content: `answer for ${userInput}` }
        ],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: userInput,
          checklist: [userInput],
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
      })),
      runDirectCommand: vi.fn(async (command) => {
        if (command.type === 'diff') {
          return {
            transcriptCells: [
              { id: 'diff-status', kind: 'status', text: 'git status output' },
              { id: 'diff-patch', kind: 'diff', text: 'git diff output' }
            ]
          };
        }

        return {
          transcriptCells: [{ id: 'shell-1', kind: 'shell', text: 'pwd output' }],
          footer: 'shell completed'
        };
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'new question' });
    await controller.handleAction({ type: 'run_slash_command', command: '/diff' });
    await controller.handleAction({ type: 'run_shell_command', command: 'pwd', args: [] });

    const appendEvents = emitted.filter((event) => event.type === 'transcript_append');
    expect(appendEvents).toHaveLength(5);
    expect(appendEvents[0]).toEqual(expect.objectContaining({ cells: [expect.objectContaining({ kind: 'user', text: 'new question' })] }));
    expect(appendEvents[1]).toEqual(expect.objectContaining({ cells: [expect.objectContaining({ kind: 'user', text: '/diff' })] }));
    expect(appendEvents[2]).toEqual(expect.objectContaining({ cells: expect.arrayContaining([
      expect.objectContaining({ id: 'diff-status', kind: 'status', text: 'git status output' }),
      expect.objectContaining({ id: 'diff-patch', kind: 'diff', text: 'git diff output' })
    ]) }));
    expect(appendEvents[3]).toEqual(expect.objectContaining({ cells: [expect.objectContaining({ kind: 'user', text: '!pwd' })] }));
    expect(appendEvents[4]).toEqual(expect.objectContaining({ cells: [expect.objectContaining({ id: 'shell-1', kind: 'shell', text: 'pwd output' })] }));
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'status', text: 'shell completed' }));
  });

  it('clears the transcript without appending a raw /clear slash command cell', async () => {
    const emitted: HostEvent[] = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-clear',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-clear',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save() {}
      },
      createSessionId: () => 'session-clear',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'run_slash_command', command: '/clear' });

    const appendEvents = emitted.filter((event) => event.type === 'transcript_append');
    expect(appendEvents).toHaveLength(0);
    expect(emitted).toContainEqual({ type: 'transcript_seed', cells: [] });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'status', text: 'Session cleared.' }));
  });

  it('saves and restores local slash and shell transcript cells via checkpoint state', async () => {
    const emitted: HostEvent[] = [];
    const savedRecords: Array<{ sessionId: string; checkpointJson: string }> = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-persist-local',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-persist-local',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson });
        }
      },
      createSessionId: () => 'session-persist-local',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      runDirectCommand: vi.fn(async (command) => {
        if (command.type === 'shell') {
          return {
            transcriptCells: [{ id: 'shell-1', kind: 'shell', text: 'git status output' }],
            footer: 'shell completed'
          };
        }

        return {
          transcriptCells: [{ id: 'diff-1', kind: 'diff', text: 'diff output' }]
        };
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'run_slash_command', command: '/status' });
    await controller.handleAction({ type: 'run_shell_command', command: 'git', args: ['status'] });

    expect(savedRecords.length).toBeGreaterThanOrEqual(2);
    expect(savedRecords.at(-1)).toMatchObject({ sessionId: 'session-persist-local' });

    const restoredController = createTuiController({
      cwd: '/tmp/qiclaw-controller-persist-local',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-persist-local',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          const latest = savedRecords.at(-1);
          return latest
            ? {
                sessionId: latest.sessionId,
                taskId: 'interactive',
                status: 'running',
                checkpointJson: latest.checkpointJson
              }
            : undefined;
        },
        save() {}
      },
      createSessionId: () => 'session-other',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await restoredController.start();

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'transcript_seed',
      cells: expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: '/status' }),
        expect.objectContaining({ kind: 'user', text: '!git status' }),
        expect.objectContaining({ kind: 'shell', text: 'git status output' })
      ])
    }));
  });

  it('persists and restores transcript-affecting local host events without double-appending transcript cells', async () => {
    const emitted: HostEvent[] = [];
    const savedRecords: Array<{ sessionId: string; checkpointJson: string }> = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-host-events',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-host-events',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson });
        }
      },
      createSessionId: () => 'session-host-events',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'run_slash_command', command: '/status' });
    await controller.handleAction({ type: 'request_status' });

    expect(emitted.filter((event) => event.type === 'transcript_append')).toHaveLength(1);
    expect(savedRecords.length).toBeGreaterThanOrEqual(2);

    const restoredEmitted: HostEvent[] = [];
    const restoredController = createTuiController({
      cwd: '/tmp/qiclaw-controller-host-events',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-host-events',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          const latest = savedRecords.at(-1);
          return latest
            ? {
                sessionId: latest.sessionId,
                taskId: 'interactive',
                status: 'running',
                checkpointJson: latest.checkpointJson
              }
            : undefined;
        },
        save() {}
      },
      createSessionId: () => 'session-host-events-restored',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        restoredEmitted.push(parseBridgeMessage(message));
      }
    });

    await restoredController.start();

    expect(restoredEmitted).toContainEqual(expect.objectContaining({
      type: 'transcript_seed',
      cells: expect.arrayContaining([
        expect.objectContaining({ kind: 'user', text: '/status' }),
        expect.objectContaining({ kind: 'status', text: expect.stringContaining('Session session-host-events') }),
        expect.objectContaining({ kind: 'status', text: expect.stringContaining('messages') })
      ])
    }));
  });

  it('restores persisted local status, warning, and error events with severity metadata', async () => {
    const emitted: HostEvent[] = [];
    const checkpointJson = createInteractiveCheckpointJson({
      version: 1,
      history: [],
      transcriptCells: [
        { id: 'status-1', kind: 'status', text: 'plain status', title: 'Status' },
        { id: 'warning-1', kind: 'status', text: 'warning status', title: 'Warning', isError: true },
        { id: 'error-1', kind: 'status', text: 'error status', title: 'Error', isError: true }
      ]
    });

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-host-event-restore-fidelity',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-host-event-restore-fidelity',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return {
            sessionId: 'session-host-event-restore-fidelity',
            taskId: 'interactive',
            status: 'running',
            checkpointJson
          };
        },
        save() {}
      },
      createSessionId: () => 'session-other',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();

    const transcriptSeed = emitted.find((event) => event.type === 'transcript_seed');
    expect(transcriptSeed).toEqual({
      type: 'transcript_seed',
      cells: [
        { id: 'status-1', kind: 'status', text: 'plain status', title: 'Status' },
        { id: 'warning-1', kind: 'status', text: 'warning status', title: 'Warning', isError: true },
        { id: 'error-1', kind: 'status', text: 'error status', title: 'Error', isError: true }
      ]
    });
  });

  it('restores transcript seed from history and historySummary when checkpoint has no transcriptCells', async () => {
    const emitted: HostEvent[] = [];
    const checkpointJson = createInteractiveCheckpointJson({
      version: 1,
      history: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' }
      ],
      historySummary: 'legacy summary'
    });

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-legacy-checkpoint',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-legacy-checkpoint',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return {
            sessionId: 'legacy-session',
            taskId: 'interactive',
            status: 'running',
            checkpointJson
          };
        },
        save() {}
      },
      createSessionId: () => 'session-new',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'transcript_seed',
      cells: [
        expect.objectContaining({ kind: 'user', text: 'old question' }),
        expect.objectContaining({ kind: 'assistant', text: 'old answer' }),
        expect.objectContaining({ kind: 'summary', title: 'History summary', text: 'legacy summary' })
      ]
    }));
  });

  it('persists and restores provider-backed assistant streaming transcript state', async () => {
    const savedRecords: Array<{ sessionId: string; checkpointJson: string }> = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-assistant',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-assistant',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson });
        }
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: '',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-provider-stream-assistant',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-provider-stream-assistant',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      createSessionId: () => 'session-provider-stream-assistant',
      executeTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: 'partial answer complete',
        history: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'partial answer complete' }
        ],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: 'question',
          checklist: ['question'],
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
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'partial ' };
          yield { type: 'assistant_text_delta', text: 'answer' };
          yield { type: 'assistant_message_completed', text: 'partial answer complete' };
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'partial answer complete',
          history: [
            { role: 'user', content: 'question' },
            { role: 'assistant', content: 'partial answer complete' }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: 'question',
            checklist: ['question'],
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
        })
      }),
      emit() {}
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'question' });

    const latest = savedRecords.at(-1);
    expect(latest).toBeDefined();

    const parsed = parseInteractiveCheckpointJson(latest!.checkpointJson);
    expect(parsed?.transcriptCells).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user', text: 'question' }),
      expect.objectContaining({ kind: 'assistant', text: 'partial answer complete' })
    ]));

    const restoredEmitted: HostEvent[] = [];
    const restoredController = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-assistant',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-assistant',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return latest
            ? {
                sessionId: latest.sessionId,
                taskId: 'interactive',
                status: 'completed',
                checkpointJson: latest.checkpointJson
              }
            : undefined;
        },
        save() {}
      },
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        restoredEmitted.push(parseBridgeMessage(message));
      }
    });

    await restoredController.start();

    expect(restoredEmitted).toContainEqual(expect.objectContaining({
      type: 'transcript_seed',
      cells: expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant', text: 'partial answer complete' })
      ])
    }));
  });

  it('emits a new assistant message id after tool activity in the same turn', async () => {
    const emitted: HostEvent[] = [];
    const savedRecords: Array<{ sessionId: string; checkpointJson: string; status?: string }> = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-multi-assistant-turn',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-multi-assistant-turn',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson, status: record.status });
        }
      },
      prepareSessionMemory: vi.fn(async () => undefined),
      captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
      createSessionId: () => 'session-multi-assistant-turn',
      executeTurn: vi.fn(async () => ({
        stopReason: 'completed',
        finalAnswer: 'Kết luận cuối',
        history: [
          { role: 'user', content: 'review code diff' },
          { role: 'assistant', content: 'Review nhanh theo git diff' },
          { role: 'tool', name: 'git', toolCallId: 'tool-1', content: '1 file changed', isError: false },
          { role: 'assistant', content: 'Kết luận cuối' }
        ],
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'review code diff',
          checklist: ['review code diff'],
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
          toolMessagesCount: 1,
          checks: []
        },
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'Review nhanh theo git diff' };
          yield { type: 'assistant_message_completed', text: 'Review nhanh theo git diff' };
          yield { type: 'tool_call_started', id: 'tool-1', name: 'git', input: { command: 'git diff --stat' } };
          yield { type: 'tool_call_completed', id: 'tool-1', name: 'git', isError: false, resultPreview: '1 file changed', durationMs: 12 };
          yield { type: 'assistant_text_delta', text: 'Kết luận cuối' };
          yield { type: 'assistant_message_completed', text: 'Kết luận cuối' };
          yield {
            type: 'turn_completed',
            finalAnswer: 'Kết luận cuối',
            stopReason: 'completed',
            history: [
              { role: 'user', content: 'review code diff' },
              { role: 'assistant', content: 'Review nhanh theo git diff' },
              { role: 'tool', name: 'git', toolCallId: 'tool-1', content: '1 file changed', isError: false },
              { role: 'assistant', content: 'Kết luận cuối' }
            ],
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: 'review code diff',
              checklist: ['review code diff'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true,
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 1,
              checks: []
            }
          };
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'Kết luận cuối',
          history: [
            { role: 'user', content: 'review code diff' },
            { role: 'assistant', content: 'Review nhanh theo git diff' },
            { role: 'tool', name: 'git', toolCallId: 'tool-1', content: '1 file changed', isError: false },
            { role: 'assistant', content: 'Kết luận cuối' }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: 'review code diff',
            checklist: ['review code diff'],
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
            toolMessagesCount: 1,
            checks: []
          }
        })
      })),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'review code diff' });

    expect(emitted).toContainEqual({ type: 'assistant_completed', turnId: 'turn-1', messageId: 'assistant-1', text: 'Review nhanh theo git diff' });
    expect(emitted).toContainEqual({ type: 'assistant_completed', turnId: 'turn-1', messageId: 'assistant-2', text: 'Kết luận cuối' });

    const finalCheckpoint = parseInteractiveCheckpointJson(savedRecords.at(-1)!.checkpointJson);
    expect(finalCheckpoint?.transcriptCells).toEqual([
      { id: 'user-live-1', kind: 'user', text: 'review code diff' },
      { id: 'assistant-live-2', kind: 'assistant', text: 'Review nhanh theo git diff' },
      { id: 'tool-live-3', kind: 'tool', text: '1 file changed', title: 'git', toolName: 'git', isError: false, streaming: false, turnId: 'turn-1', toolCallId: 'tool-1', durationMs: 12 },
      { id: 'assistant-live-4', kind: 'assistant', text: 'Kết luận cuối' }
    ]);
  });

  it('keeps a single assistant live cell while a long completion text arrives in chunks', async () => {
    const emitted: HostEvent[] = [];
    const savedRecords: Array<{ sessionId: string; checkpointJson: string; status?: string }> = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-long-assistant',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-long-assistant',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson, status: record.status });
        }
      },
      prepareSessionMemory: vi.fn(async () => undefined),
      captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
      createSessionId: () => 'session-long-assistant',
      executeTurn: vi.fn(async () => ({
        stopReason: 'completed',
        finalAnswer: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.',
        history: [
          { role: 'user', content: 'review cho lẹ' },
          { role: 'assistant', content: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.' }
        ],
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: 'review cho lẹ',
          checklist: ['review cho lẹ'],
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
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'Chu' };
          yield { type: 'assistant_text_delta', text: 'ẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.' };
          yield {
            type: 'assistant_message_completed',
            text: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.'
          };
          yield {
            type: 'turn_completed',
            finalAnswer: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.',
            stopReason: 'completed',
            history: [
              { role: 'user', content: 'review cho lẹ' },
              { role: 'assistant', content: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.' }
            ],
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: 'review cho lẹ',
              checklist: ['review cho lẹ'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true,
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
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.',
          history: [
            { role: 'user', content: 'review cho lẹ' },
            { role: 'assistant', content: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.' }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: 'review cho lẹ',
            checklist: ['review cho lẹ'],
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
        })
      })),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'review cho lẹ' });

    expect(emitted.filter((event) => event.type === 'assistant_completed')).toEqual([
      {
        type: 'assistant_completed',
        turnId: 'turn-1',
        messageId: 'assistant-1',
        text: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.'
      }
    ]);

    const finalCheckpoint = parseInteractiveCheckpointJson(savedRecords.at(-1)!.checkpointJson);
    expect(finalCheckpoint?.transcriptCells).toEqual([
      { id: 'user-live-1', kind: 'user', text: 'review cho lẹ' },
      { id: 'assistant-live-2', kind: 'assistant', text: 'Chuẩn, Đại ca. Lần này em đi quá sâu vào file nên chậm.' }
    ]);
  });

  it('does not duplicate a short assistant fragment when completion arrives for the same turn', async () => {
    const emitted: HostEvent[] = [];
    const savedRecords: Array<{ sessionId: string; checkpointJson: string; status?: string }> = [];
    const finalAnswer = 'Chào Đại ca, em đây. Cần em làm gì?';

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-short-fragment',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-short-fragment',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson, status: record.status });
        }
      },
      prepareSessionMemory: vi.fn(async () => undefined),
      captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
      createSessionId: () => 'session-short-fragment',
      executeTurn: vi.fn(async () => ({
        stopReason: 'completed',
        finalAnswer,
        history: [
          { role: 'user', content: 'xin chào' },
          { role: 'assistant', content: finalAnswer }
        ],
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: 'xin chào',
          checklist: ['xin chào'],
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
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'Ch' };
          yield { type: 'assistant_message_completed', text: finalAnswer };
          yield {
            type: 'turn_completed',
            finalAnswer,
            stopReason: 'completed',
            history: [
              { role: 'user', content: 'xin chào' },
              { role: 'assistant', content: finalAnswer }
            ],
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: 'xin chào',
              checklist: ['xin chào'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true,
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
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer,
          history: [
            { role: 'user', content: 'xin chào' },
            { role: 'assistant', content: finalAnswer }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: 'xin chào',
            checklist: ['xin chào'],
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
        })
      })),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'xin chào' });

    const assistantAppendCells = emitted
      .filter((event): event is Extract<HostEvent, { type: 'transcript_append' }> => event.type === 'transcript_append')
      .flatMap((event) => event.cells.filter((cell) => cell.kind === 'assistant'));

    expect(assistantAppendCells).toEqual([]);
    expect(emitted.filter((event) => event.type === 'assistant_completed')).toEqual([
      { type: 'assistant_completed', turnId: 'turn-1', messageId: 'assistant-1', text: finalAnswer }
    ]);

    const finalCheckpoint = parseInteractiveCheckpointJson(savedRecords.at(-1)!.checkpointJson);
    expect(finalCheckpoint?.transcriptCells).toEqual([
      { id: 'user-live-1', kind: 'user', text: 'xin chào' },
      { id: 'assistant-live-2', kind: 'assistant', text: finalAnswer }
    ]);
  });

  it('persists and restores provider-backed tool activity transcript state', async () => {
    const savedRecords: Array<{ sessionId: string; checkpointJson: string }> = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-tool',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-tool',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson });
        }
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: '',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-provider-stream-tool',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-provider-stream-tool',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      createSessionId: () => 'session-provider-stream-tool',
      executeTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: 'done',
        history: [
          { role: 'user', content: 'use tool' },
          { role: 'tool', name: 'read_file', toolCallId: 'tool-1', content: 'file contents', isError: false },
          { role: 'assistant', content: 'done' }
        ],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'use tool',
          checklist: ['use tool'],
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
          toolMessagesCount: 1,
          checks: []
        },
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { file_path: '/tmp/demo.txt' } };
          yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', isError: false, resultPreview: 'file contents', durationMs: 12 };
          yield { type: 'assistant_message_completed', text: 'done' };
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'done',
          history: [
            { role: 'user', content: 'use tool' },
            { role: 'tool', name: 'read_file', toolCallId: 'tool-1', content: 'file contents', isError: false },
            { role: 'assistant', content: 'done' }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 1,
          doneCriteria: {
            goal: 'use tool',
            checklist: ['use tool'],
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
            toolMessagesCount: 1,
            checks: []
          }
        })
      }),
      emit() {}
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'use tool' });

    const latest = savedRecords.at(-1);
    const parsed = parseInteractiveCheckpointJson(latest!.checkpointJson);
    expect(parsed?.transcriptCells).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user', text: 'use tool' }),
      expect.objectContaining({
        kind: 'tool',
        toolName: 'read_file',
        title: 'read_file /tmp/demo.txt',
        text: 'file contents',
        toolCallId: 'tool-1',
        turnId: 'turn-1',
        streaming: false,
        durationMs: 12
      }),
      expect.objectContaining({ kind: 'assistant', text: 'done' })
    ]));
    expect(parsed?.transcriptCells?.filter((cell) => cell.kind === 'tool' && cell.toolCallId === 'tool-1')).toHaveLength(1);

    const restoredEmitted: HostEvent[] = [];
    const restoredController = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-tool',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-tool',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return latest
            ? {
                sessionId: latest.sessionId,
                taskId: 'interactive',
                status: 'completed',
                checkpointJson: latest.checkpointJson
              }
            : undefined;
        },
        save() {}
      },
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      emit(message) {
        restoredEmitted.push(parseBridgeMessage(message));
      }
    });

    await restoredController.start();

    expect(restoredEmitted).toContainEqual(expect.objectContaining({
      type: 'transcript_seed',
      cells: expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool',
          toolName: 'read_file',
          title: 'read_file /tmp/demo.txt',
          text: 'file contents',
          toolCallId: 'tool-1',
          turnId: 'turn-1',
          streaming: false,
          durationMs: 12
        })
      ])
    }));
  });

  it('persists useful provider-backed transcript state when a streamed turn fails after deltas and tools', async () => {
    const savedRecords: Array<{ sessionId: string; checkpointJson: string; status?: string }> = [];

    const streamError = new Error('provider stream failed');
    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-failure',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-failure',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson, status: record.status });
        }
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: '',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-provider-stream-failure',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-provider-stream-failure',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      createSessionId: () => 'session-provider-stream-failure',
      executeTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'question',
          checklist: ['question'],
          requiresNonEmptyFinalAnswer: true,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: false,
          finalAnswerIsNonEmpty: false,
          finalAnswerIsSubstantive: false,
          toolEvidenceSatisfied: false,
          noUnresolvedToolErrors: false,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'partial ' };
          yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { file_path: '/tmp/demo.txt' } };
          yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', isError: false, resultPreview: 'file contents', durationMs: 12 };
          throw streamError;
        })(),
        finalResult: Promise.reject(streamError)
      }),
      emit() {}
    });

    await expect(controller.start()).resolves.toBeUndefined();
    await expect(controller.handleAction({ type: 'submit_prompt', prompt: 'question' })).rejects.toThrow('provider stream failed');

    const latest = savedRecords.at(-1);
    expect(latest).toBeDefined();

    const parsed = parseInteractiveCheckpointJson(latest!.checkpointJson);
    expect(parsed?.transcriptCells).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'user', text: 'question' }),
      expect.objectContaining({ kind: 'assistant', text: 'partial ' }),
      expect.objectContaining({
        kind: 'tool',
        toolName: 'read_file',
        title: 'read_file /tmp/demo.txt',
        text: 'file contents',
        toolCallId: 'tool-1',
        turnId: 'turn-1',
        streaming: false,
        durationMs: 12
      }),
      expect.objectContaining({ kind: 'status', title: 'Error', text: 'provider stream failed', isError: true })
    ]));
  });

  it('restores a failed provider-backed streamed turn and completes the next prompt coherently', async () => {
    const savedRecords: Array<{ sessionId: string; checkpointJson: string; status?: string }> = [];
    const restoredEmitted: HostEvent[] = [];
    const streamError = new Error('provider stream failed');

    const firstController = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-failure-restore',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-failure-restore',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson, status: record.status });
        }
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: '',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-provider-stream-failure-restore',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-provider-stream-failure-restore',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      })),
      createSessionId: () => 'session-provider-stream-failure-restore',
      executeTurn: async () => ({
        stopReason: 'completed',
        finalAnswer: '',
        history: [],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 1,
        doneCriteria: {
          goal: 'question',
          checklist: ['question'],
          requiresNonEmptyFinalAnswer: true,
          requiresToolEvidence: false,
          requiresSubstantiveFinalAnswer: false,
          forbidSuccessAfterToolErrors: false
        },
        verification: {
          isVerified: false,
          finalAnswerIsNonEmpty: false,
          finalAnswerIsSubstantive: false,
          toolEvidenceSatisfied: false,
          noUnresolvedToolErrors: false,
          toolMessagesCount: 0,
          checks: []
        },
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'partial ' };
          yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { file_path: '/tmp/demo.txt' } };
          yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', isError: false, resultPreview: 'file contents', durationMs: 12 };
          throw streamError;
        })(),
        finalResult: Promise.reject(streamError)
      }),
      emit() {}
    });

    await firstController.start();
    await expect(firstController.handleAction({ type: 'submit_prompt', prompt: 'question' })).rejects.toThrow('provider stream failed');

    const failedCheckpoint = savedRecords.at(-1);
    expect(failedCheckpoint).toBeDefined();

    const failedParsed = parseInteractiveCheckpointJson(failedCheckpoint!.checkpointJson);
    expect(failedParsed?.history).toEqual([]);
    expect(failedParsed?.transcriptCells?.map(({ kind, text, title, toolName, isError, streaming, turnId, toolCallId, durationMs }) => ({ kind, text, title, toolName, isError, streaming, turnId, toolCallId, durationMs }))).toEqual([
      { kind: 'user', text: 'question', title: undefined, toolName: undefined, isError: undefined, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined },
      { kind: 'assistant', text: 'partial ', title: undefined, toolName: undefined, isError: undefined, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined },
      { kind: 'tool', text: 'file contents', title: 'read_file /tmp/demo.txt', toolName: 'read_file', isError: false, streaming: false, turnId: 'turn-1', toolCallId: 'tool-1', durationMs: 12 },
      { kind: 'status', text: 'provider stream failed', title: 'Error', toolName: undefined, isError: true, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined }
    ]);

    const restoredExecuteTurn = vi.fn(async ({ userInput, history, historySummary }) => {
      expect(history).toEqual([]);
      expect(historySummary).toBeUndefined();
      return {
        stopReason: 'completed',
        finalAnswer: 'follow-up answer',
        history: [
          { role: 'user', content: userInput },
          { role: 'assistant', content: 'follow-up answer' }
        ],
        historySummary: undefined,
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: userInput,
          checklist: [userInput],
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
        turnStream: (async function* (): AsyncIterable<TurnEvent> {
          yield { type: 'assistant_text_delta', text: 'follow-up ' };
          yield { type: 'assistant_text_delta', text: 'answer' };
          yield { type: 'assistant_message_completed', text: 'follow-up answer' };
        })(),
        finalResult: Promise.resolve({
          stopReason: 'completed',
          finalAnswer: 'follow-up answer',
          history: [
            { role: 'user', content: userInput },
            { role: 'assistant', content: 'follow-up answer' }
          ],
          historySummary: undefined,
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: userInput,
            checklist: [userInput],
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
        })
      };
    });

    const restoredController = createTuiController({
      cwd: '/tmp/qiclaw-controller-provider-stream-failure-restore',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-provider-stream-failure-restore',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return failedCheckpoint
            ? {
                sessionId: failedCheckpoint.sessionId,
                taskId: 'interactive',
                status: 'running',
                checkpointJson: failedCheckpoint.checkpointJson
              }
            : undefined;
        },
        save(record) {
          savedRecords.push({ sessionId: record.sessionId, checkpointJson: record.checkpointJson, status: record.status });
        }
      },
      prepareSessionMemory: vi.fn(async () => ({
        memoryText: '',
        store: { stub: true },
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-provider-stream-failure-restore',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 1,
          lastCompactedAt: null
        }
      })),
      captureTurnMemory: vi.fn(async () => ({
        saved: true,
        checkpointState: {
          storeSessionId: 'session-provider-stream-failure-restore',
          engine: 'file-session-memory',
          version: 1,
          memoryPath: '/tmp/memory.jsonl',
          metaPath: '/tmp/meta.json',
          totalEntries: 2,
          lastCompactedAt: null
        }
      })),
      createSessionId: () => 'session-provider-stream-failure-restore-other',
      executeTurn: restoredExecuteTurn,
      emit(message) {
        restoredEmitted.push(parseBridgeMessage(message));
      }
    });

    await restoredController.start();

    const restoredSeed = restoredEmitted.find((event) => event.type === 'transcript_seed');
    expect(restoredSeed).toEqual({
      type: 'transcript_seed',
      cells: [
        { id: 'user-live-1', kind: 'user', text: 'question' },
        { id: 'assistant-live-2', kind: 'assistant', text: 'partial ' },
        { id: 'tool-live-3', kind: 'tool', text: 'file contents', title: 'read_file /tmp/demo.txt', toolName: 'read_file', isError: false, streaming: false, turnId: 'turn-1', toolCallId: 'tool-1', durationMs: 12 },
        { id: 'error-live-4', kind: 'status', text: 'provider stream failed', title: 'Error', isError: true }
      ]
    });

    await expect(restoredController.handleAction({ type: 'submit_prompt', prompt: 'follow-up question' })).resolves.toBe(true);
    expect(restoredExecuteTurn).toHaveBeenCalledOnce();

    const finalCheckpoint = savedRecords.at(-1);
    expect(finalCheckpoint).toBeDefined();
    expect(finalCheckpoint?.status).toBe('completed');

    const finalParsed = parseInteractiveCheckpointJson(finalCheckpoint!.checkpointJson);
    expect(finalParsed?.transcriptCells?.map(({ kind, text, title, toolName, isError, streaming, turnId, toolCallId, durationMs }) => ({ kind, text, title, toolName, isError, streaming, turnId, toolCallId, durationMs }))).toEqual([
      { kind: 'user', text: 'question', title: undefined, toolName: undefined, isError: undefined, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined },
      { kind: 'assistant', text: 'partial ', title: undefined, toolName: undefined, isError: undefined, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined },
      { kind: 'tool', text: 'file contents', title: 'read_file /tmp/demo.txt', toolName: 'read_file', isError: false, streaming: false, turnId: 'turn-1', toolCallId: 'tool-1', durationMs: 12 },
      { kind: 'status', text: 'provider stream failed', title: 'Error', toolName: undefined, isError: true, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined },
      { kind: 'user', text: 'follow-up question', title: undefined, toolName: undefined, isError: undefined, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined },
      { kind: 'assistant', text: 'follow-up answer', title: undefined, toolName: undefined, isError: undefined, streaming: undefined, turnId: undefined, toolCallId: undefined, durationMs: undefined }
    ]);
    expect(finalParsed?.history).toEqual([
      { role: 'user', content: 'follow-up question' },
      { role: 'assistant', content: 'follow-up answer' }
    ]);
  });

  it('drops stale partial assistant transcript cells when restoring before the next turn', async () => {
    const savedRecords: Array<{ sessionId: string; taskId: string; status: 'running' | 'completed'; checkpointJson: string }> = [];
    const initialCheckpoint = createInteractiveCheckpointJson({
      version: 1,
      history: [
        { role: 'user', content: 'xin chào' }
      ],
      historySummary: undefined,
      sessionMemory: undefined,
      transcriptCells: [
        { id: 'user-live-1', kind: 'user', text: 'xin chào' },
        { id: 'assistant-live-2', kind: 'assistant', text: 'Ch' }
      ]
    });
    const emitted: HostEvent[] = [];

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-restore-ordinals',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-restore-ordinals',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return {
            sessionId: 'session-restore-ordinals',
            taskId: 'interactive',
            status: 'running',
            checkpointJson: initialCheckpoint,
            createdAt: new Date().toISOString()
          };
        },
        save(record) {
          savedRecords.push(record);
        }
      },
      prepareSessionMemory: vi.fn(async () => undefined),
      captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
      createSessionId: () => 'session-restore-ordinals-fallback',
      executeTurn: vi.fn(async () => ({
        stopReason: 'completed',
        finalAnswer: 'Chào Đại ca.',
        history: [
          { role: 'user', content: 'tiếp tục' },
          { role: 'assistant', content: 'Chào Đại ca.' }
        ],
        memoryCandidates: [],
        structuredOutputParsed: false,
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: 'tiếp tục',
          checklist: ['tiếp tục'],
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
        turnStream: (async function* () {
          yield { type: 'assistant_text_delta', text: 'Chào Đại ca.' } as const;
          yield { type: 'assistant_message_completed', text: 'Chào Đại ca.' } as const;
          yield {
            type: 'turn_completed',
            stopReason: 'completed',
            finalAnswer: 'Chào Đại ca.',
            history: [
              { role: 'user', content: 'tiếp tục' },
              { role: 'assistant', content: 'Chào Đại ca.' }
            ],
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: 'tiếp tục',
              checklist: ['tiếp tục'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            turnCompleted: true,
            verification: {
              isVerified: true,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            }
          } as const;
        })()
      })),
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();

    const restoredSeed = emitted.find((event) => event.type === 'transcript_seed');
    expect(restoredSeed).toEqual({
      type: 'transcript_seed',
      cells: [
        { id: 'user-live-1', kind: 'user', text: 'xin chào' }
      ]
    });

    await controller.handleAction({ type: 'submit_prompt', prompt: 'tiếp tục' });

    expect(emitted).toContainEqual({ type: 'assistant_delta', turnId: 'turn-2', messageId: 'assistant-1', text: 'Chào Đại ca.' });
    expect(emitted).toContainEqual({ type: 'assistant_completed', turnId: 'turn-2', messageId: 'assistant-1', text: 'Chào Đại ca.' });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'turn_completed', turnId: 'turn-2' }));

    const finalCheckpoint = parseInteractiveCheckpointJson(savedRecords.at(-1)!.checkpointJson);
    expect(finalCheckpoint?.transcriptCells).toEqual([
      { id: 'user-live-1', kind: 'user', text: 'xin chào' },
      { id: 'user-live-2', kind: 'user', text: 'tiếp tục' },
      { id: 'assistant-live-3', kind: 'assistant', text: 'Chào Đại ca.' }
    ]);
  });

  it('formats completed footer summary with verification, provider count, tool count, and seconds', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0);
    nowSpy.mockReturnValueOnce(18_000);

    const emitted: HostEvent[] = [];

    try {
      const controller = createTuiController({
        cwd: '/tmp/qiclaw-controller-footer-summary',
        runtime: {
          provider: { name: 'openai', model: 'gpt-test' },
          availableTools: [],
          systemPrompt: 'system prompt',
          cwd: '/tmp/qiclaw-controller-footer-summary',
          maxToolRounds: 3,
          observer: { record() {} }
        },
        checkpointStore: {
          getLatest() {
            return undefined;
          },
          save() {}
        },
        prepareSessionMemory: vi.fn(async () => undefined),
        captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
        createSessionId: () => 'session-footer-summary',
        executeTurn: vi.fn(async (input) => {
          input.observer?.record({
            type: 'provider_called',
            timestamp: '2026-04-16T10:00:01.000Z',
            stage: 'provider_decision',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              messageCount: 1,
              promptRawChars: 14,
              toolNames: [],
              messageSummaries: [],
              totalContentBlockCount: 1,
              hasSystemPrompt: true,
              promptRawPreviewRedacted: 'summarize turn'
            }
          });
          input.observer?.record({
            type: 'provider_responded',
            timestamp: '2026-04-16T10:00:02.000Z',
            stage: 'response_composition',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              durationMs: 300,
              responseContentBlockCount: 1,
              toolCallCount: 2,
              hasTextOutput: true,
              usage: {
                inputTokens: 12_000,
                outputTokens: 1_300,
                totalTokens: 13_300,
                cacheReadInputTokens: 0
              }
            }
          });

          return {
            stopReason: 'completed',
            finalAnswer: 'done',
            history: [
              { role: 'user', content: 'summarize turn' },
              { role: 'assistant', content: 'done' }
            ],
            historySummary: undefined,
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: 'summarize turn',
              checklist: ['summarize turn'],
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
            turnStream: (async function* (): AsyncIterable<TurnEvent> {
              yield { type: 'provider_started' };
              yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { filePath: 'a' } };
              yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', resultPreview: 'ok', isError: false, durationMs: 10 };
              yield { type: 'tool_call_started', id: 'tool-2', name: 'grep', input: { pattern: 'x' } };
              yield { type: 'tool_call_completed', id: 'tool-2', name: 'grep', resultPreview: 'ok', isError: false, durationMs: 10 };
              yield { type: 'assistant_message_completed', text: 'done' };
              yield {
                type: 'turn_completed',
                finalAnswer: 'done',
                stopReason: 'completed',
                history: [
                  { role: 'user', content: 'summarize turn' },
                  { role: 'assistant', content: 'done' }
                ],
                memoryCandidates: [],
                structuredOutputParsed: false,
                toolRoundsUsed: 1,
                doneCriteria: {
                  goal: 'summarize turn',
                  checklist: ['summarize turn'],
                  requiresNonEmptyFinalAnswer: true,
                  requiresToolEvidence: false,
                  requiresSubstantiveFinalAnswer: false,
                  forbidSuccessAfterToolErrors: false
                },
                turnCompleted: true,
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
            })(),
            finalResult: Promise.resolve({
              stopReason: 'completed',
              finalAnswer: 'done',
              history: [
                { role: 'user', content: 'summarize turn' },
                { role: 'assistant', content: 'done' }
              ],
              historySummary: undefined,
              memoryCandidates: [],
              structuredOutputParsed: false,
              toolRoundsUsed: 1,
              doneCriteria: {
                goal: 'summarize turn',
                checklist: ['summarize turn'],
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
            })
          };
        }),
        emit(message) {
          emitted.push(parseBridgeMessage(message));
        }
      });

      await controller.start();
      await controller.handleAction({ type: 'submit_prompt', prompt: 'summarize turn' });

      const assistantCompletedIndex = emitted.findIndex((event) => event.type === 'assistant_completed');
      const turnCompletedIndex = emitted.findIndex((event) => event.type === 'turn_completed');
      const footerSummaries = emitted.filter((event): event is Extract<HostEvent, { type: 'footer_summary' }> => event.type === 'footer_summary');
      const footerSummaryIndex = emitted.findIndex((event) => event.type === 'footer_summary');

      expect(assistantCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(turnCompletedIndex).toBeGreaterThan(assistantCompletedIndex);
      expect(footerSummaries).toHaveLength(1);
      expect(footerSummaries[0]).toEqual({
        type: 'footer_summary',
        text: 'completed • verified • 1 provider • 2 tools • 12k in • 1.3k out • 18s'
      });
      expect(footerSummaryIndex).toBeGreaterThan(turnCompletedIndex);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('formats max-tools footer summary with actual tool calls and millisecond duration', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0);
    nowSpy.mockReturnValueOnce(842);

    const emitted: HostEvent[] = [];

    try {
      const controller = createTuiController({
        cwd: '/tmp/qiclaw-controller-footer-summary-max-tools',
        runtime: {
          provider: { name: 'openai', model: 'gpt-test' },
          availableTools: [],
          systemPrompt: 'system prompt',
          cwd: '/tmp/qiclaw-controller-footer-summary-max-tools',
          maxToolRounds: 3,
          observer: { record() {} }
        },
        checkpointStore: {
          getLatest() {
            return undefined;
          },
          save() {}
        },
        prepareSessionMemory: vi.fn(async () => undefined),
        captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
        createSessionId: () => 'session-footer-summary-max-tools',
        executeTurn: vi.fn(async (input) => {
          input.observer?.record({
            type: 'provider_called',
            timestamp: '2026-04-16T11:00:00.010Z',
            stage: 'provider_decision',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              messageCount: 1,
              promptRawChars: 9,
              toolNames: ['read_file'],
              messageSummaries: [],
              totalContentBlockCount: 1,
              hasSystemPrompt: true,
              promptRawPreviewRedacted: 'max tools'
            }
          });
          input.observer?.record({
            type: 'provider_called',
            timestamp: '2026-04-16T11:00:00.020Z',
            stage: 'provider_decision',
            data: {
              turnId: 'turn-1',
              providerRound: 2,
              toolRound: 1,
              messageCount: 2,
              promptRawChars: 18,
              toolNames: ['read_file'],
              messageSummaries: [],
              totalContentBlockCount: 1,
              hasSystemPrompt: true,
              promptRawPreviewRedacted: 'max tools retry'
            }
          });
          input.observer?.record({
            type: 'provider_responded',
            timestamp: '2026-04-16T11:00:00.030Z',
            stage: 'response_composition',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              durationMs: 300,
              responseContentBlockCount: 1,
              toolCallCount: 1,
              hasTextOutput: false,
              usage: {
                inputTokens: 421,
                outputTokens: 31,
                totalTokens: 452,
                cacheReadInputTokens: 0
              }
            }
          });
          input.observer?.record({
            type: 'provider_responded',
            timestamp: '2026-04-16T11:00:00.040Z',
            stage: 'response_composition',
            data: {
              turnId: 'turn-1',
              providerRound: 2,
              toolRound: 1,
              durationMs: 320,
              responseContentBlockCount: 1,
              toolCallCount: 0,
              hasTextOutput: true,
              usage: {
                inputTokens: 421,
                outputTokens: 30,
                totalTokens: 451,
                cacheReadInputTokens: 0
              }
            }
          });

          return {
            stopReason: 'max_tool_rounds_reached',
            finalAnswer: 'stopped',
            history: [],
            historySummary: undefined,
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 3,
            doneCriteria: {
              goal: 'max tools',
              checklist: ['max tools'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: false,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 1,
              checks: []
            },
            turnStream: (async function* (): AsyncIterable<TurnEvent> {
              yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { filePath: 'a' } };
              yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', resultPreview: 'ok', isError: false, durationMs: 10 };
              yield { type: 'assistant_message_completed', text: 'stopped' };
              yield {
                type: 'turn_completed',
                finalAnswer: 'stopped',
                stopReason: 'max_tool_rounds_reached',
                history: [],
                memoryCandidates: [],
                structuredOutputParsed: false,
                toolRoundsUsed: 3,
                doneCriteria: {
                  goal: 'max tools',
                  checklist: ['max tools'],
                  requiresNonEmptyFinalAnswer: true,
                  requiresToolEvidence: false,
                  requiresSubstantiveFinalAnswer: false,
                  forbidSuccessAfterToolErrors: false
                },
                turnCompleted: false,
                verification: {
                  isVerified: false,
                  finalAnswerIsNonEmpty: true,
                  finalAnswerIsSubstantive: true,
                  toolEvidenceSatisfied: true,
                  noUnresolvedToolErrors: true,
                  toolMessagesCount: 1,
                  checks: []
                }
              };
            })(),
            finalResult: Promise.resolve({
              stopReason: 'max_tool_rounds_reached',
              finalAnswer: 'stopped',
              history: [],
              historySummary: undefined,
              memoryCandidates: [],
              structuredOutputParsed: false,
              toolRoundsUsed: 3,
              doneCriteria: {
                goal: 'max tools',
                checklist: ['max tools'],
                requiresNonEmptyFinalAnswer: true,
                requiresToolEvidence: false,
                requiresSubstantiveFinalAnswer: false,
                forbidSuccessAfterToolErrors: false
              },
              verification: {
                isVerified: false,
                finalAnswerIsNonEmpty: true,
                finalAnswerIsSubstantive: true,
                toolEvidenceSatisfied: true,
                noUnresolvedToolErrors: true,
                toolMessagesCount: 1,
                checks: []
              }
            })
          };
        }),
        emit(message) {
          emitted.push(parseBridgeMessage(message));
        }
      });

      await controller.start();
      await controller.handleAction({ type: 'submit_prompt', prompt: 'max tools' });

      const footerSummaries = emitted.filter((event): event is Extract<HostEvent, { type: 'footer_summary' }> => event.type === 'footer_summary');
      expect(footerSummaries).toHaveLength(1);
      expect(footerSummaries[0]).toEqual({
        type: 'footer_summary',
        text: 'max tools • 2 providers • 1 tool • 842 in • 61 out • 842ms'
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('formats compact aggregate token counts across multiple provider responses', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0);
    nowSpy.mockReturnValueOnce(18_000);

    const emitted: HostEvent[] = [];

    try {
      const controller = createTuiController({
        cwd: '/tmp/qiclaw-token-summary',
        runtime: {
          provider: { name: 'anthropic', model: 'claude-sonnet-4-6' },
          availableTools: [],
          systemPrompt: 'system prompt',
          cwd: '/tmp/qiclaw-token-summary',
          maxToolRounds: 4,
          observer: { record() {} }
        },
        checkpointStore: {
          getLatest() {
            return undefined;
          },
          save() {}
        },
        prepareSessionMemory: vi.fn(async () => ({
          memoryText: '',
          store: { stub: true },
          recalled: [],
          checkpointState: {
            storeSessionId: 'session-token-summary',
            engine: 'file-session-memory',
            version: 1,
            memoryPath: '/tmp/memory.jsonl',
            metaPath: '/tmp/meta.json',
            totalEntries: 0,
            lastCompactedAt: null
          }
        })),
        captureTurnMemory: vi.fn(async () => ({
          saved: true,
          checkpointState: {
            storeSessionId: 'session-token-summary',
            engine: 'file-session-memory',
            version: 1,
            memoryPath: '/tmp/memory.jsonl',
            metaPath: '/tmp/meta.json',
            totalEntries: 1,
            lastCompactedAt: null
          }
        })),
        createSessionId: () => 'session-token-summary',
        executeTurn: async ({ observer }) => {
          observer?.record({
            type: 'provider_called',
            timestamp: '2026-04-16T10:00:00.000Z',
            stage: 'provider_decision',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              messageCount: 2,
              promptRawChars: 120,
              toolNames: [],
              messageSummaries: [],
              totalContentBlockCount: 2,
              hasSystemPrompt: true,
              promptRawPreviewRedacted: 'prompt'
            }
          });
          observer?.record({
            type: 'provider_responded',
            timestamp: '2026-04-16T10:00:01.000Z',
            stage: 'response_composition',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              durationMs: 320,
              responseContentBlockCount: 1,
              toolCallCount: 1,
              hasTextOutput: false,
              usage: {
                inputTokens: 12_000,
                outputTokens: 900,
                totalTokens: 12_900,
                cacheReadInputTokens: 0
              }
            }
          });
          observer?.record({
            type: 'provider_called',
            timestamp: '2026-04-16T10:00:02.000Z',
            stage: 'provider_decision',
            data: {
              turnId: 'turn-1',
              providerRound: 2,
              toolRound: 1,
              messageCount: 4,
              promptRawChars: 260,
              toolNames: ['read_file'],
              messageSummaries: [],
              totalContentBlockCount: 4,
              hasSystemPrompt: true,
              promptRawPreviewRedacted: 'prompt'
            }
          });
          observer?.record({
            type: 'provider_responded',
            timestamp: '2026-04-16T10:00:03.000Z',
            stage: 'response_composition',
            data: {
              turnId: 'turn-1',
              providerRound: 2,
              toolRound: 1,
              durationMs: 280,
              responseContentBlockCount: 1,
              toolCallCount: 0,
              hasTextOutput: true,
              usage: {
                inputTokens: 345,
                outputTokens: 400,
                totalTokens: 745,
                cacheReadInputTokens: 0
              }
            }
          });

          return {
            stopReason: 'completed',
            finalAnswer: 'done',
            history: [
              { role: 'user', content: 'question' },
              { role: 'assistant', content: 'done' }
            ],
            historySummary: undefined,
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 1,
            doneCriteria: {
              goal: 'question',
              checklist: ['question'],
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
            turnStream: (async function* (): AsyncIterable<TurnEvent> {
              yield { type: 'tool_call_started', id: 'tool-1', name: 'read_file', input: { filePath: 'a' } };
              yield { type: 'tool_call_completed', id: 'tool-1', name: 'read_file', resultPreview: 'ok', isError: false, durationMs: 10 };
              yield { type: 'assistant_message_completed', text: 'done' };
            })(),
            finalResult: Promise.resolve({
              stopReason: 'completed',
              finalAnswer: 'done',
              history: [
                { role: 'user', content: 'question' },
                { role: 'assistant', content: 'done' }
              ],
              historySummary: undefined,
              memoryCandidates: [],
              structuredOutputParsed: false,
              toolRoundsUsed: 1,
              doneCriteria: {
                goal: 'question',
                checklist: ['question'],
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
            })
          };
        },
        emit(message) {
          emitted.push(parseBridgeMessage(message));
        }
      });

      await controller.start();
      await controller.handleAction({ type: 'submit_prompt', prompt: 'question' });

      const footerSummaries = emitted.filter((event): event is Extract<HostEvent, { type: 'footer_summary' }> => event.type === 'footer_summary');
      expect(footerSummaries).toHaveLength(1);
      expect(footerSummaries[0]).toEqual({
        type: 'footer_summary',
        text: 'completed • verified • 2 providers • 1 tool • 12k in • 1.3k out • 18s'
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('formats raw token counts and omits verified when verification is false', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0);
    nowSpy.mockReturnValueOnce(842);

    const emitted: HostEvent[] = [];

    try {
      const controller = createTuiController({
        cwd: '/tmp/qiclaw-token-summary-raw',
        runtime: {
          provider: { name: 'openai', model: 'gpt-test' },
          availableTools: [],
          systemPrompt: 'system prompt',
          cwd: '/tmp/qiclaw-token-summary-raw',
          maxToolRounds: 3,
          observer: { record() {} }
        },
        checkpointStore: {
          getLatest() {
            return undefined;
          },
          save() {}
        },
        prepareSessionMemory: vi.fn(async () => undefined),
        captureTurnMemory: vi.fn(async () => ({ saved: false, checkpointState: undefined })),
        createSessionId: () => 'session-token-summary-raw',
        executeTurn: vi.fn(async (input) => {
          input.observer?.record({
            type: 'provider_called',
            timestamp: '2026-04-16T12:00:00.010Z',
            stage: 'provider_decision',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              messageCount: 1,
              promptRawChars: 12,
              toolNames: [],
              messageSummaries: [],
              totalContentBlockCount: 1,
              hasSystemPrompt: true,
              promptRawPreviewRedacted: 'stop now'
            }
          });
          input.observer?.record({
            type: 'provider_responded',
            timestamp: '2026-04-16T12:00:00.020Z',
            stage: 'response_composition',
            data: {
              turnId: 'turn-1',
              providerRound: 1,
              toolRound: 0,
              durationMs: 250,
              responseContentBlockCount: 1,
              toolCallCount: 0,
              hasTextOutput: true,
              usage: {
                inputTokens: 842,
                outputTokens: 61,
                totalTokens: 903,
                cacheReadInputTokens: 0
              }
            }
          });

          return {
            stopReason: 'stopped',
            finalAnswer: 'stopped',
            history: [
              { role: 'user', content: 'stop now' },
              { role: 'assistant', content: 'stopped' }
            ],
            historySummary: undefined,
            memoryCandidates: [],
            structuredOutputParsed: false,
            toolRoundsUsed: 0,
            doneCriteria: {
              goal: 'stop now',
              checklist: ['stop now'],
              requiresNonEmptyFinalAnswer: true,
              requiresToolEvidence: false,
              requiresSubstantiveFinalAnswer: false,
              forbidSuccessAfterToolErrors: false
            },
            verification: {
              isVerified: false,
              finalAnswerIsNonEmpty: true,
              finalAnswerIsSubstantive: true,
              toolEvidenceSatisfied: true,
              noUnresolvedToolErrors: true,
              toolMessagesCount: 0,
              checks: []
            },
            turnStream: (async function* (): AsyncIterable<TurnEvent> {
              yield { type: 'assistant_message_completed', text: 'stopped' };
            })(),
            finalResult: Promise.resolve({
              stopReason: 'stopped',
              finalAnswer: 'stopped',
              history: [
                { role: 'user', content: 'stop now' },
                { role: 'assistant', content: 'stopped' }
              ],
              historySummary: undefined,
              memoryCandidates: [],
              structuredOutputParsed: false,
              toolRoundsUsed: 0,
              doneCriteria: {
                goal: 'stop now',
                checklist: ['stop now'],
                requiresNonEmptyFinalAnswer: true,
                requiresToolEvidence: false,
                requiresSubstantiveFinalAnswer: false,
                forbidSuccessAfterToolErrors: false
              },
              verification: {
                isVerified: false,
                finalAnswerIsNonEmpty: true,
                finalAnswerIsSubstantive: true,
                toolEvidenceSatisfied: true,
                noUnresolvedToolErrors: true,
                toolMessagesCount: 0,
                checks: []
              }
            })
          };
        }),
        emit(message) {
          emitted.push(parseBridgeMessage(message));
        }
      });

      await controller.start();
      await controller.handleAction({ type: 'submit_prompt', prompt: 'stop now' });

      const footerSummaries = emitted.filter((event): event is Extract<HostEvent, { type: 'footer_summary' }> => event.type === 'footer_summary');
      expect(footerSummaries).toHaveLength(1);
      expect(footerSummaries[0]).toEqual({
        type: 'footer_summary',
        text: 'stopped • 1 provider • 0 tools • 842 in • 61 out • 842ms'
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shows current model and updates model when the session is still clean', async () => {
    const emitted: HostEvent[] = [];
    const updateModel = vi.fn((argsText: string) => {
      expect(argsText).toBe('openai:gpt-5');
      return { provider: 'openai', model: 'gpt-5' };
    });

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-model',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-model',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save() {}
      },
      createSessionId: () => 'session-model',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      updateModel,
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'run_slash_command', command: '/model' });
    await controller.handleAction({ type: 'run_slash_command', command: '/model openai:gpt-5' });
    await controller.handleAction({ type: 'run_slash_command', command: '/status' });

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'status',
      text: 'Current model: openai:gpt-test'
    }));
    expect(updateModel).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'status',
      text: 'Model updated to openai:gpt-5'
    }));
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'status',
      text: expect.stringContaining('model openai:gpt-5')
    }));
  });

  it('warns when trying to change model after the session has real history', async () => {
    const emitted: HostEvent[] = [];
    const executeTurn = vi.fn(async () => ({
      stopReason: 'completed',
      finalAnswer: 'answer',
      history: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' }
      ],
      historySummary: 'summary',
      memoryCandidates: [],
      structuredOutputParsed: false,
      toolRoundsUsed: 0,
      doneCriteria: {
        goal: 'question',
        checklist: ['question'],
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
    const updateModel = vi.fn(() => ({ provider: 'openai', model: 'gpt-5' }));

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-model-dirty',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-model-dirty',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save() {}
      },
      createSessionId: () => 'session-model-dirty',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn,
      updateModel,
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await controller.handleAction({ type: 'submit_prompt', prompt: 'question' });
    await controller.handleAction({ type: 'run_slash_command', command: '/model openai:gpt-5' });

    expect(updateModel).not.toHaveBeenCalled();
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'warning',
      text: expect.stringMatching(/session.*clean|clear/i)
    }));
  });

  it('emits a warning instead of failing the session when /model input is invalid', async () => {
    const emitted: HostEvent[] = [];
    const updateModel = vi.fn(() => {
      throw new Error('Unknown provider: nope');
    });

    const controller = createTuiController({
      cwd: '/tmp/qiclaw-controller-model-invalid',
      runtime: {
        provider: { name: 'openai', model: 'gpt-test' },
        availableTools: [],
        systemPrompt: 'system prompt',
        cwd: '/tmp/qiclaw-controller-model-invalid',
        maxToolRounds: 3,
        observer: { record() {} }
      },
      checkpointStore: {
        getLatest() {
          return undefined;
        },
        save() {}
      },
      createSessionId: () => 'session-model-invalid',
      prepareSessionMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      captureTurnMemory: vi.fn(async () => {
        throw new Error('not used');
      }),
      executeTurn: vi.fn(async () => {
        throw new Error('not used');
      }),
      updateModel,
      emit(message) {
        emitted.push(parseBridgeMessage(message));
      }
    });

    await controller.start();
    await expect(controller.handleAction({ type: 'run_slash_command', command: '/model nope:gpt-5' })).resolves.toBe(true);

    expect(updateModel).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'warning',
      text: 'Unknown provider: nope'
    }));
  });
});
