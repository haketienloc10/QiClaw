import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TaskContract } from '../agent/taskContract.js';
import type { TaskVerdict } from '../agent/taskVerdict.js';

export interface TaskLedgerRecord {
  taskId: string;
  sessionId?: string;
  userInput: string;
  contract: TaskContract;
  verdict: TaskVerdict;
  toolRoundsUsed: number;
  finalAnswer: string;
  timestamp: string;
}

export function appendTaskLedgerRecord(filePath: string, record: TaskLedgerRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}
