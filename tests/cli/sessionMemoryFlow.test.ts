import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveBuiltinAgentPackage } from '../../src/agent/specRegistry.js';
import { buildCli } from '../../src/cli/main.js';
import { CheckpointStore } from '../../src/session/checkpointStore.js';
import { createInteractiveCheckpointJson, getCheckpointStorePath, parseInteractiveCheckpointJson } from '../../src/session/session.js';
import type { CaptureInteractiveTurnMemoryInput, PrepareInteractiveSessionMemoryResult } from '../../src/memory/sessionMemoryEngine.js';

const tempDirs: string[] = [];
const defaultResolvedPackage = resolveBuiltinAgentPackage('default');
let previousGlobalMemoryDir: string | undefined;

beforeEach(async () => {
  previousGlobalMemoryDir = process.env.QICLAW_GLOBAL_MEMORY_DIR;
  const isolatedGlobalDir = await mkdtemp(join(tmpdir(), 'qiclaw-global-memory-'));
  tempDirs.push(isolatedGlobalDir);
  process.env.QICLAW_GLOBAL_MEMORY_DIR = isolatedGlobalDir;
});

afterEach(async () => {
  restoreEnv('QICLAW_GLOBAL_MEMORY_DIR', previousGlobalMemoryDir);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe('interactive session memory flow', () => {
  it('passes Ollama memory embedding config from CLI env into prepare and capture paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const originalModel = process.env.MODEL;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const originalMemoryProvider = process.env.QICLAW_MEMORY_PROVIDER;
    const originalMemoryModel = process.env.QICLAW_MEMORY_MODEL;
    const originalMemoryBaseUrl = process.env.QICLAW_MEMORY_BASE_URL;

    process.env.MODEL = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.QICLAW_MEMORY_PROVIDER = 'ollama';
    process.env.QICLAW_MEMORY_MODEL = 'nomic-embed-text';
    process.env.QICLAW_MEMORY_BASE_URL = 'http://localhost:11434';

    const prepareSessionMemory = async (input: Parameters<NonNullable<import('../../src/cli/main.js').BuildCliOptions['prepareSessionMemory']>>[0]): Promise<PrepareInteractiveSessionMemoryResult> => {
      expect(input.memoryConfig).toEqual({
        provider: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434'
      });

      return {
        memoryText: '',
        store: {} as never,
        globalStore: undefined,
        recalled: [],
        checkpointState: {
          storeSessionId: 'session-memory-env',
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/memory/index.json',
          metaPath: '/tmp/memory/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      };
    };

    const captureTurnMemory = async (input: CaptureInteractiveTurnMemoryInput) => {
      expect(input.memoryConfig).toEqual({
        provider: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434'
      });

      return {
        saved: false,
        checkpointState: {
          storeSessionId: 'session-memory-env',
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/memory/index.json',
          metaPath: '/tmp/memory/meta.json',
          totalEntries: 0,
          lastCompactedAt: null
        }
      };
    };

    const interactiveCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        resolvedPackage: defaultResolvedPackage,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-env',
      readLine: (() => {
        const inputs = ['remember that i use neovim', '/exit'];
        return async () => inputs.shift();
      })(),
      prepareSessionMemory,
      captureTurnMemory,
      runTurn: async (input) => ({
        stopReason: 'completed',
        finalAnswer: 'I will remember that you use neovim.',
        history: [
          ...(input.history ?? []),
          { role: 'user', content: input.userInput },
          { role: 'assistant', content: 'I will remember that you use neovim.' }
        ],
        historySummary: 'editor preference stored',
        memoryCandidates: [],
        structuredOutputParsed: false,
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

    try {
      await expect(interactiveCli.run()).resolves.toBe(0);
    } finally {
      restoreEnv('MODEL', originalModel);
      restoreEnv('OPENAI_API_KEY', originalOpenAiApiKey);
      restoreEnv('QICLAW_MEMORY_PROVIDER', originalMemoryProvider);
      restoreEnv('QICLAW_MEMORY_MODEL', originalMemoryModel);
      restoreEnv('QICLAW_MEMORY_BASE_URL', originalMemoryBaseUrl);
    }
  });
  it('sends only the base system prompt and current user input when first-turn recall is empty', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const providerCalls: Array<Parameters<import('../../src/provider/model.js').ModelProvider['generate']>[0]> = [];
    const interactiveCli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: {
          name: 'test-provider',
          model: 'test-model',
          async generate(request) {
            providerCalls.push(request);
            return {
              message: { role: 'assistant', content: 'First-turn answer.' },
              toolCalls: []
            };
          },
          stream: undefined
        },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        resolvedPackage: defaultResolvedPackage,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-first-turn',
      readLine: (() => {
        const inputs = ['hello there', '/exit'];
        return async () => inputs.shift();
      })()
    });

    await expect(interactiveCli.run()).resolves.toBe(0);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.messages).toEqual([
      { role: 'system', content: 'Test prompt' },
      { role: 'user', content: 'hello there' }
    ]);
  });

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
        resolvedPackage: defaultResolvedPackage,
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

        const firstTurn = input.userInput.includes('remember');
        const finalAnswer = firstTurn
          ? 'I will remember that your favorite editor is neovim.'
          : 'You prefer neovim.';

        return {
          stopReason: 'completed',
          finalAnswer,
          memoryCandidates: firstTurn
            ? [
                {
                  operation: 'create' as const,
                  target_memory_ids: '',
                  kind: 'decision' as const,
                  title: 'Default editor choice',
                  summary: 'Your favorite editor is neovim.',
                  keywords: 'decision | editor | neovim',
                  confidence: 0.95,
                  durability: 'durable' as const,
                  speculative: false,
                  novelty_basis: 'The user explicitly stated the preferred editor in this turn.'
                }
              ]
            : [],
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: finalAnswer }
          ],
          structuredOutputParsed: false,
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
  }, 15000);

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
        resolvedPackage: defaultResolvedPackage,
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
          memoryCandidates: [],
          structuredOutputParsed: false,
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

  it('does not recall a successful procedure after a turn whose tool result ended with isError true', async () => {
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
        resolvedPackage: defaultResolvedPackage,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-failed-procedure',
      readLine: (() => {
        const inputs = ['open the unavailable deployment runbook', 'what should you remember when deployment docs are unavailable?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        interactiveInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        const firstTurn = input.userInput === 'open the unavailable deployment runbook';
        const finalAnswer = firstTurn
          ? 'The runbook path failed to open; retry with a valid runbook path before giving deployment steps.'
          : 'I should remember the failure recovery guidance, not invent a successful runbook-reading procedure.';
        const priorHistory = input.history ?? [];
        const toolMessages = firstTurn
          ? [
              {
                role: 'assistant' as const,
                content: 'I will try to open the deployment runbook.',
                toolCalls: [{ id: 'tool_failed_runbook_read', name: 'Read', input: { file_path: '/tmp/deploy/runbook.md' } }]
              },
              {
                role: 'tool' as const,
                name: 'Read',
                toolCallId: 'tool_failed_runbook_read',
                content: 'ENOENT: no such file or directory',
                isError: true
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
          memoryCandidates: [],
          structuredOutputParsed: false,
          historySummary: firstTurn ? 'deployment runbook read failed; retry with a valid path before giving steps' : 'checked failed procedure recall',
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
      userInput: 'open the unavailable deployment runbook',
      sessionId: 'session-memory-failed-procedure',
      memoryText: ''
    });

    const recalledMemory = interactiveInputs[1].memoryText ?? '';
    expect(recalledMemory).toContain('retry with a valid runbook path');
    expect(recalledMemory).toContain('before giving deployment steps');
    expect(recalledMemory).not.toMatch(/Read .* to confirm/i);
    expect(recalledMemory).not.toMatch(/shows version/i);
    expect(recalledMemory).not.toMatch(/package version/i);
    expect(recalledMemory).not.toContain('package.json');
  });

  it('keeps first Vietnamese explicit save turn empty then recalls stored memory on the next turn in the same session', async () => {
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
        resolvedPackage: defaultResolvedPackage,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-vi-explicit',
      readLine: (() => {
        const inputs = ['hãy nhớ rằng tôi thích trả lời bằng tiếng Việt', 'tôi thích trả lời bằng ngôn ngữ nào?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        interactiveInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        const finalAnswer = input.userInput.includes('hãy nhớ')
          ? 'Tôi sẽ nhớ rằng bạn thích trả lời bằng tiếng Việt.'
          : 'Bạn thích trả lời bằng tiếng Việt.';

        return {
          stopReason: 'completed',
          finalAnswer,
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: finalAnswer }
          ],
          memoryCandidates: [],
          structuredOutputParsed: false,
          historySummary: 'đã lưu sở thích trả lời bằng tiếng Việt',
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
      userInput: 'hãy nhớ rằng tôi thích trả lời bằng tiếng Việt',
      sessionId: 'session-memory-vi-explicit',
      memoryText: ''
    });
    expect(interactiveInputs[1].memoryText).toContain('Memory:');
    expect(interactiveInputs[1].memoryText).toContain('tiếng Việt');
  });

  it('persists Vietnamese procedure memory after a turn with a successful tool result and recalls it on the next turn', async () => {
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
        resolvedPackage: defaultResolvedPackage,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'session-memory-vi-procedure',
      readLine: (() => {
        const inputs = ['hãy kiểm tra phiên bản package', 'lần sau nên kiểm tra phiên bản package thế nào?', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        interactiveInputs.push({
          userInput: input.userInput,
          sessionId: input.sessionId,
          memoryText: input.memoryText
        });

        const firstTurn = input.userInput === 'hãy kiểm tra phiên bản package';
        const finalAnswer = firstTurn
          ? 'package.json cho thấy phiên bản 1.2.3.'
          : 'Bạn có thể đọc package.json để kiểm tra phiên bản nhanh.';
        const priorHistory = input.history ?? [];
        const toolMessages = firstTurn
          ? [
              {
                role: 'assistant' as const,
                content: 'Tôi sẽ đọc package.json.',
                toolCalls: [{ id: 'tool_read_package_vi', name: 'Read', input: { file_path: '/tmp/package.json' } }]
              },
              {
                role: 'tool' as const,
                name: 'Read',
                toolCallId: 'tool_read_package_vi',
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
          memoryCandidates: [],
          structuredOutputParsed: false,
          historySummary: firstTurn ? 'đã kiểm tra phiên bản package từ package.json' : 'đã recall procedure memory tiếng Việt',
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
      userInput: 'hãy kiểm tra phiên bản package',
      sessionId: 'session-memory-vi-procedure',
      memoryText: ''
    });
    expect(interactiveInputs[1].memoryText).toContain('package.json');
    expect(interactiveInputs[1].memoryText).toContain('phiên bản 1.2.3');
  });

  it('recalls user-global memory from a different session on restart without using the default global store', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);
    const previousGlobalMemoryDir = process.env.QICLAW_GLOBAL_MEMORY_DIR;
    process.env.QICLAW_GLOBAL_MEMORY_DIR = join(tempDir, 'global-memory');

    try {
      const globalInputs: Array<{ userInput: string; sessionId?: string; memoryText?: string }> = [];
      const firstRunCli = buildCli({
        argv: [],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? { record() {} },
          resolvedPackage: defaultResolvedPackage,
          systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        createSessionId: () => 'global-session-1',
        readLine: (() => {
          const inputs = ['remember that I always want concise answers', '/exit'];
          return async () => inputs.shift();
        })(),
        runTurn: async (input) => ({
          stopReason: 'completed',
          finalAnswer: 'I will remember that you always want concise answers.',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'I will remember that you always want concise answers.' }
          ],
          memoryCandidates: [],
          structuredOutputParsed: false,
          historySummary: 'concise answer preference stored',
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

      const secondRunCli = buildCli({
        argv: [],
        cwd: tempDir,
        stdout: { write() { return true; } },
        createRuntime: (runtimeOptions) => ({
          provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
          availableTools: [],
          cwd: tempDir,
          observer: runtimeOptions.observer ?? { record() {} },
          resolvedPackage: defaultResolvedPackage,
          systemPrompt: 'Test prompt',
          maxToolRounds: 3
        }),
        createSessionId: () => 'global-session-2',
        readLine: (() => {
          const inputs = ['how should you answer by default?', '/exit'];
          return async () => inputs.shift();
        })(),
        runTurn: async (input) => {
          globalInputs.push({
            userInput: input.userInput,
            sessionId: input.sessionId,
            memoryText: input.memoryText
          });

          return {
            stopReason: 'completed',
            finalAnswer: 'I should answer concisely by default.',
            history: [
              ...(input.history ?? []),
              { role: 'user', content: input.userInput },
              { role: 'assistant', content: 'I should answer concisely by default.' }
            ],
            memoryCandidates: [],
          structuredOutputParsed: false,
          historySummary: 'global preference recalled',
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

      await expect(secondRunCli.run()).resolves.toBe(0);
      expect(globalInputs).toEqual([
        {
          userInput: 'how should you answer by default?',
          sessionId: 'global-session-1',
          memoryText: expect.stringContaining('concise answers')
        }
      ]);
    } finally {
      if (previousGlobalMemoryDir === undefined) {
        delete process.env.QICLAW_GLOBAL_MEMORY_DIR;
      } else {
        process.env.QICLAW_GLOBAL_MEMORY_DIR = previousGlobalMemoryDir;
      }
    }
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
        resolvedPackage: defaultResolvedPackage,
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
        memoryCandidates: [],
        structuredOutputParsed: false,
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
        resolvedPackage: defaultResolvedPackage,
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
          memoryCandidates: [],
          structuredOutputParsed: false,
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
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: join(tempDir, '.qiclaw', 'sessions', 'session-with-memory', 'memory/index.json'),
          metaPath: join(tempDir, '.qiclaw', 'sessions', 'session-with-memory', 'memory/meta.json'),
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
        resolvedPackage: defaultResolvedPackage,
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
          memoryCandidates: [],
          structuredOutputParsed: false,
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

  it('passes compact recent history and a combined summary to the agent without truncating checkpoint history', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'qiclaw-session-memory-'));
    tempDirs.push(tempDir);

    const checkpointStorePath = getCheckpointStorePath(tempDir);
    await mkdir(join(tempDir, '.qiclaw'), { recursive: true });
    const checkpointStore = new CheckpointStore(checkpointStorePath);
    const oldHistory = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `old conversation message ${index} ${'x'.repeat(200)}`
    }));

    checkpointStore.save({
      sessionId: 'session-with-long-history',
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: oldHistory,
        historySummary: 'previous durable summary'
      }),
      updatedAt: '2026-04-05T10:10:00.000Z'
    });

    const runInputs: Array<{ historyLength: number; historySummary?: string }> = [];
    const cli = buildCli({
      argv: [],
      cwd: tempDir,
      stdout: { write() { return true; } },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} },
        resolvedPackage: defaultResolvedPackage,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      }),
      createSessionId: () => 'unused-new-session',
      prepareSessionMemory: async (input) => ({
        memoryText: '',
        store: { close: async () => undefined } as never,
        globalStore: { close: async () => undefined } as never,
        recalled: [],
        checkpointState: {
          storeSessionId: input.sessionId,
          engine: 'file-session-memory-store',
          version: 1,
          memoryPath: '/tmp/memory/index.json',
          metaPath: '/tmp/memory/meta.json',
          totalEntries: 0,
          lastCompactedAt: null,
          latestSummaryText: input.historySummary
        }
      }) as PrepareInteractiveSessionMemoryResult,
      captureTurnMemory: async (input) => ({ saved: false, checkpointState: {
        storeSessionId: input.sessionId,
        engine: 'file-session-memory-store',
        version: 1,
        memoryPath: '/tmp/memory/index.json',
        metaPath: '/tmp/memory/meta.json',
        totalEntries: 0,
        lastCompactedAt: null
      } }),
      readLine: (() => {
        const inputs = ['continue from there', '/exit'];
        return async () => inputs.shift();
      })(),
      runTurn: async (input) => {
        runInputs.push({
          historyLength: input.history?.length ?? 0,
          historySummary: input.historySummary
        });

        return {
          stopReason: 'completed',
          finalAnswer: 'continued',
          history: [
            ...(input.history ?? []),
            { role: 'user', content: input.userInput },
            { role: 'assistant', content: 'continued' }
          ],
          memoryCandidates: [],
          structuredOutputParsed: false,
          historySummary: 'turn summary',
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

    await expect(cli.run()).resolves.toBe(0);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0].historyLength).toBeLessThan(oldHistory.length);
    expect(runInputs[0].historySummary).toContain('previous durable summary');
    expect(runInputs[0].historySummary).toContain('History summary:');

    const restored = parseInteractiveCheckpointJson(checkpointStore.getLatest()?.checkpointJson ?? '');
    expect(restored?.history).toHaveLength(oldHistory.length + 2);
    expect(restored?.history.at(0)?.content).toContain('old conversation message 0');
    expect(restored?.history.at(-1)?.content).toBe('continued');
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
        resolvedPackage: defaultResolvedPackage,
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
          memoryCandidates: [],
          structuredOutputParsed: false,
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
