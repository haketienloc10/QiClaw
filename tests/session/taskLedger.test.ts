import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendTaskLedgerRecord } from '../../src/session/taskLedger.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('appendTaskLedgerRecord', () => {
  it('appends one JSON record per turn without overwriting previous records', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'task-ledger-'));
    tempDirs.push(tempDir);

    const ledgerPath = join(tempDir, 'witness-ledger.jsonl');

    appendTaskLedgerRecord(ledgerPath, {
      taskId: 'task-1',
      sessionId: 'session-1',
      userInput: 'Inspect file A',
      contract: {
        taskId: 'task-1',
        goal: 'Inspect file A',
        requiresToolEvidence: true,
        requiresSubstantiveFinalAnswer: true,
        forbidSuccessAfterToolErrors: true,
        expectedEvidence: ['at least one successful tool result'],
        createdAt: '2026-04-23T10:00:00.000Z'
      },
      verdict: {
        taskId: 'task-1',
        status: 'passed',
        isCompleted: true,
        checks: [],
        evidenceSummary: 'Observed 1 successful tool result.',
        finalAnswerSummary: 'Final answer is substantive.',
        createdAt: '2026-04-23T10:00:01.000Z'
      },
      toolRoundsUsed: 1,
      finalAnswer: 'Inspected file A.',
      timestamp: '2026-04-23T10:00:01.000Z'
    });

    appendTaskLedgerRecord(ledgerPath, {
      taskId: 'task-2',
      sessionId: 'session-1',
      userInput: 'Inspect file B',
      contract: {
        taskId: 'task-2',
        goal: 'Inspect file B',
        requiresToolEvidence: true,
        requiresSubstantiveFinalAnswer: true,
        forbidSuccessAfterToolErrors: true,
        expectedEvidence: ['at least one successful tool result'],
        createdAt: '2026-04-23T10:00:02.000Z'
      },
      verdict: {
        taskId: 'task-2',
        status: 'failed',
        isCompleted: false,
        checks: [],
        evidenceSummary: 'No successful tool result observed.',
        finalAnswerSummary: 'Final answer overclaimed success.',
        createdAt: '2026-04-23T10:00:03.000Z'
      },
      toolRoundsUsed: 1,
      finalAnswer: 'Done.',
      timestamp: '2026-04-23T10:00:03.000Z'
    });

    const content = await readFile(ledgerPath, 'utf8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      {
        taskId: 'task-1',
        userInput: 'Inspect file A',
        verdict: { status: 'passed' }
      },
      {
        taskId: 'task-2',
        userInput: 'Inspect file B',
        verdict: { status: 'failed' }
      }
    ]);
  });
});
