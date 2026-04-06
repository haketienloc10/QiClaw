import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultAgentSpec } from '../../src/agent/defaultAgentSpec.js';
import { buildCli } from '../../src/cli/main.js';
import { CheckpointStore } from '../../src/session/checkpointStore.js';
import { createInteractiveCheckpointJson, getCheckpointStorePath } from '../../src/session/session.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('interactive session memory flow', () => {
  it('keeps first interactive turn empty then recalls stored memory on the next turn in the same session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const interactiveInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
    const interactiveCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-1',
      readLine: (() => {
        const inputs = ['remember that my favorite editor is neovim', 'what editor do i prefer?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        interactiveInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        const finalAnswer = input.userInput.includes('remember')
          ? 'I will remember that your favorite editor is neovim.'
          : 'You prefer neovim.';

        return {
          stopReason: 'completed',
          finalAnswer,
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: finalAnswer }
          ],
          historySummary: 'editor preference stored',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
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
      }
    });

    await expect(interactiveCli.run()).resolves.toBe(0);
    expect(interactiveInputs).toHaveLength(2);
    expect(interactiveInputs[0]).toEqual({
      userInput: 'remember that my favorite editor is neovim',
      sessionId: 'session-memory-1',
      memoryText: ''
    });
    expect(interactiveInputs[1].sessionId).toBe('session-memory-1');
    expect(interactiveInputs[1].memoryText).toContain('Memory:');
    expect(interactiveInputs[1].memoryText).toContain('favorite editor is neovim');
  });

  it('persists procedure memory after a turn with a successful tool result and recalls it on the next turn', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const interactiveInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
    const interactiveCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-procedure',
      readLine: (() => {
        const inputs = ['show me the package version', 'how should you check package version next time?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        interactiveInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        const firstTurn = input.userInput === 'show me the package version';
        const finalAnswer = firstTurn
          ? 'package.json shows version 1.2.3.'
          : 'You can read package.json to confirm the version quickly.';
        const priorHistory = input.history ?? [];
        const toolMessages = firstTurn
          ? [
              {
                role: 'assistant' as const,
                content: 'I will inspect the package metadata.',
                toolCalls: [{ id: 'tool_read_package', name: 'Read', input: { file_path: '/tmp/package.json' } }]
              },
              {
                role: 'tool' as const,
                name: 'Read',
                toolCallId: 'tool_read_package',
                content: '{"name":"demo","version":"1.2.3"}',
                isError: false
              },
              { role: 'assistant' as const, content: finalAnswer }
            ]
          : [{ role: 'assistant' as const, content: finalAnswer }];

        return {
          stopReason: 'completed' as const,
          finalAnswer,
          history: [
            ...priorHistory,
            { role: 'user' as const, content: input.userInput },
            ...toolMessages
          ],
          historySummary: firstTurn ? 'package version checked from package.json' : 'procedure memory recalled',
          toolRoundsUsed: firstTurn ? 1 : 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
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
            toolMessagesCount: firstTurn ? 1 : 0,
            checks: []
          }
        };
      }
    });

    await expect(interactiveCli.run()).resolves.toBe(0);
    expect(interactiveInputs).toHaveLength(2);
    expect(interactiveInputs[0]).toEqual({
      userInput: 'show me the package version',
      sessionId: 'session-memory-procedure',
      memoryText: ''
    });
    expect(interactiveInputs[1].memoryText).toContain('package.json');
    expect(interactiveInputs[1].memoryText).toContain('1.2.3');
  });

  it('restores the checkpoint sessionId and recalls the same session memory after restarting the CLI', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const firstRunCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-restore',
      readLine: (() => {
        const inputs = ['remember that i deploy to staging first', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'I will remember that you deploy to staging first.',
        history: [
          ...(input.history ?? []),
          { role: 'user', content: input.userInput },
          { role: 'assistant', content: 'I will remember that you deploy to staging first.' }
        ],
        historySummary: 'staging deployment preference stored',
        toolRoundsUsed: 0,
        doneCriteria: {
          goal: input.userInput,
          checklist: [input.userInput],
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
    });

    await expect(firstRunCli.run()).resolves.toBe(0);

    const restoredInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
    const restoredCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'new-session-id-should-not-be-used',
      readLine: (() => {
        const inputs = ['where do i deploy first?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        restoredInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        return {
          stopReason: 'completed',
          finalAnswer: 'You deploy to staging first.',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'You deploy to staging first.' }
          ],
          historySummary: 'staging deployment preference restored',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
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
      }
    });

    await expect(restoredCli.run()).resolves.toBe(0);
    expect(restoredInputs).toEqual([
      {
        userInput: 'where do i deploy first?',
        sessionId: 'session-memory-restore',
        memoryText: expect.stringContaining('deploy to staging first')
      }
    ]);
  });

  it('does not bleed restored memory from another session when a newer checkpoint in the same cwd has no session memory state', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const checkpointStorePath = getCheckpointStorePath(tempDir);
    await mkdir(join(tempDir, '.qiclaw'), { recursive: true });
    const checkpointStore = new CheckpointStore(checkpointStorePath);

    checkpointStore.save({
      sessionId: 'session-with-memory',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [
          { role: 'user', content: 'remember that i prefer tmux' },
          { role: 'assistant', content: 'I will remember that you prefer tmux.' }
        ],
        historySummary: 'tmux preference stored',
        sessionMemory: {
          storeSessionId: 'session-with-memory',
          engine: 'memvid-session-store',
          version: 1,
          memoryPath: join(tempDir, '.qiclaw', 'sessions', 'session-with-memory', 'memory.mv2'),
          metaPath: join(tempDir, '.qiclaw', 'sessions', 'session-with-memory', 'memory.meta.json'),
          totalEntries: 1,
          lastCompactedAt: null,
          latestSummaryText: 'prefer tmux'
        }
      }),
      updatedAt: '2026-04-05T10:00:00.000Z'
    });

    checkpointStore.save({
      sessionId: 'session-without-memory',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: [
          { role: 'user', content: 'new clean session' },
          { role: 'assistant', content: 'clean slate' }
        ],
        historySummary: 'fresh unrelated summary'
      }),
      updatedAt: '2026-04-05T10:05:00.000Z'
    });

    const restoredInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
    const restoredCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'new-session-id-should-not-be-used',
      readLine: (() => {
        const inputs = ['what do i prefer?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        restoredInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        return {
          stopReason: 'completed',
          finalAnswer: 'No stored preference in this session.',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'No stored preference in this session.' }
          ],
          historySummary: 'no restored memory bleed',
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
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
      }
    });

    await expect(restoredCli.run()).resolves.toBe(0);
    expect(restoredInputs).toEqual([
      {
        userInput: 'what do i prefer?',
        sessionId: 'session-without-memory',
        memoryText: ''
      }
    ]);
  });

  it('keeps prompt mode stateless without session memory state', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const promptInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
    const promptCli = buildCli({
      argv: ['--prompt', 'one-shot question'],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      runTurn: async (input) => {
        promptInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        return {
          stopReason: 'completed',
          finalAnswer: 'one-shot answer',
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
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
      }
    });

    await expect(promptCli.run()).resolves.toBe(0);
    expect(promptInputs).toEqual([
      {
        userInput: 'one-shot question',
        sessionId: undefined,
        memoryText: undefined
      }
    ]);
  });
});
