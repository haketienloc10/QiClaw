import { describe, expect, it, vi } from 'vitest';

import {
  captureInteractiveTurnMemory,
  prepareInteractiveSessionMemory,
  recallSessionMemories
} from '../../src/memory/sessionMemoryEngine.js';
import type { SessionMemoryCandidate } from '../../src/memory/sessionMemoryTypes.js';

function createCandidate(overrides: Partial<SessionMemoryCandidate> = {}): SessionMemoryCandidate {
  return {
    hash: 'abc123def456',
    sessionId: 'session_1',
    memoryType: 'fact',
    fullText: 'User explicitly asked to always answer in Vietnamese with concise wording.',
    summaryText: 'Answer in Vietnamese.',
    essenceText: 'Vietnamese responses.',
    tags: ['language'],
    source: 'turn-1',
    sourceTurnId: 'turn-1',
    createdAt: '2026-04-05T10:00:00.000Z',
    lastAccessed: '2026-04-05T10:00:00.000Z',
    accessCount: 0,
    importance: 0.5,
    explicitSave: false,
    retrievalScore: 0.5,
    finalScore: 0,
    fidelity: 'summary',
    ...overrides
  };
}

describe('captureInteractiveTurnMemory', () => {
  it('does not persist question-style remember phrasing as an explicit save', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal } as never,
      sessionId: 'session_1',
      userInput: 'do you remember that I prefer concise answers?',
      finalAnswer: 'Yes, I remember that preference.'
    });

    expect(result.saved).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });

  it('persists a procedure memory when the turn ends with a successful tool result and concise conclusion', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal } as never,
      sessionId: 'session_1',
      userInput: 'show me the package version',
      finalAnswer: 'package.json shows version 1.2.3.',
      history: [
        { role: 'user', content: 'show me the package version' },
        {
          role: 'assistant',
          content: 'I will inspect the package metadata.',
          toolCalls: [{ id: 'tool_1', name: 'Read', input: { file_path: '/tmp/package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_1',
          content: '{"version":"1.2.3"}',
          isError: false
        },
        { role: 'assistant', content: 'package.json shows version 1.2.3.' }
      ]
    });

    expect(result.saved).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(result.entry).toMatchObject({
      memoryType: 'procedure',
      summaryText: expect.stringContaining('Read'),
      essenceText: expect.stringContaining('version 1.2.3'),
      explicitSave: false
    });
  });

  it('does not persist a procedure memory when the current turn has no tool result', async () => {
    const put = vi.fn(async () => undefined);
    const seal = vi.fn(async () => undefined);

    const result = await captureInteractiveTurnMemory({
      store: { put, seal } as never,
      sessionId: 'session_1',
      userInput: 'how should you check package version next time?',
      finalAnswer: 'You can read package.json to confirm the version quickly.',
      history: [
        { role: 'user', content: 'show me the package version' },
        {
          role: 'assistant',
          content: 'I will inspect the package metadata.',
          toolCalls: [{ id: 'tool_1', name: 'Read', input: { file_path: '/tmp/package.json' } }]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'tool_1',
          content: '{"version":"1.2.3"}',
          isError: false
        },
        { role: 'assistant', content: 'package.json shows version 1.2.3.' },
        { role: 'user', content: 'how should you check package version next time?' },
        { role: 'assistant', content: 'You can read package.json to confirm the version quickly.' }
      ]
    });

    expect(result.saved).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
  });
});

describe('prepareInteractiveSessionMemory', () => {
  it('keeps latestSummaryText from the checkpoint when no new memory is recalled', async () => {
    const result = await prepareInteractiveSessionMemory({
      cwd: '/tmp/session-memory-engine-empty',
      sessionId: 'session_1',
      userInput: 'brand new question',
      checkpointState: {
        storeSessionId: 'session_1',
        latestSummaryText: 'remembered summary'
      },
      totalBudgetChars: 200
    });

    expect(result.memoryText).toBe('');
    expect(result.checkpointState).toEqual({
      storeSessionId: 'session_1',
      latestSummaryText: 'remembered summary'
    });
  });
});

describe('recallSessionMemories', () => {
  it('uses the memory budget bucket to pack hot, warm, and faded memories into memoryText', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({ hash: 'hot123def456', retrievalScore: 0.9, importance: 0.9, explicitSave: true }),
        createCandidate({ hash: 'warm23def456', retrievalScore: 0.6, importance: 0.5, summaryText: 'Warm summary.' }),
        createCandidate({ hash: 'cool33def456', retrievalScore: 0.2, importance: 0.1, essenceText: 'Cool essence.' })
      ],
      budgetChars: 200,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.usedBudgetChars).toBeLessThanOrEqual(200);
    expect(result.memoryText.length).toBeLessThanOrEqual(200);

    expect(result.memoryText).toContain('Memory:');
    expect(result.memoryText).toContain('Hot memories:');
    expect(result.memoryText).toContain('Warm summaries:');
    expect(result.memoryText).toContain('Faded references:');
    expect(result.memoryText).toMatch(/Cool essence\.|#cool33def456/u);
  });

  it('does not overflow the final assembled memory text budget or render empty headers', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({
          hash: 'hot123def456',
          retrievalScore: 0.9,
          importance: 0.9,
          explicitSave: true,
          fullText: 'A moderately long memory that should not fit once section headers are included.',
          summaryText: 'A moderately long summary that also should not fit.',
          essenceText: 'brief essence'
        })
      ],
      budgetChars: 15,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.memoryText.length).toBeLessThanOrEqual(15);
    expect(result.usedBudgetChars).toBe(result.memoryText.length);
    expect(result.memoryText).toBe('');
    expect(result.recalled).toEqual([]);
    expect(result.memoryText).not.toContain('Hot memories:');
    expect(result.memoryText).not.toContain('Warm summaries:');
    expect(result.memoryText).not.toContain('Faded references:');
  });

  it('renders a compact block when the memory budget is low', () => {
    const result = recallSessionMemories({
      candidates: [
        createCandidate({
          hash: 'fact123def456',
          memoryType: 'fact',
          retrievalScore: 0.95,
          importance: 0.9,
          explicitSave: true,
          summaryText: 'Prefer concise answers in Vietnamese.',
          essenceText: 'Vietnamese concise.'
        }),
        createCandidate({
          hash: 'proc123def456',
          memoryType: 'procedure',
          retrievalScore: 0.7,
          importance: 0.6,
          summaryText: 'Use Read on package.json to confirm the package version.',
          essenceText: 'Read package.json for version.'
        })
      ],
      budgetChars: 90,
      now: '2026-04-05T12:00:00.000Z'
    });

    expect(result.memoryText.length).toBeLessThanOrEqual(90);
    expect(result.memoryText).toContain('Mem:');
    expect(result.memoryText).not.toContain('Hot memories:');
    expect(result.memoryText).not.toContain('Warm summaries:');
    expect(result.memoryText).not.toContain('Faded references:');
  });
});
