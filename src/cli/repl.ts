import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import type { AgentTurnStopReason, RunAgentTurnResult } from '../agent/loop.js';

export interface ReplTurnResult {
  finalAnswer: string;
  stopReason: AgentTurnStopReason;
}

export interface CreateReplOptions {
  promptLabel: string;
  runTurn(input: string): Promise<Pick<RunAgentTurnResult, 'finalAnswer' | 'stopReason' | 'toolRoundsUsed' | 'verification'>>;
  readLine?(promptLabel: string): Promise<string | undefined>;
  writeLine?(text: string): void;
  afterTurnRendered?(): void;
}

export interface Repl {
  runOnce(input: string): Promise<ReplTurnResult>;
  runInteractive(): Promise<number>;
}

export function createRepl(options: CreateReplOptions): Repl {
  const readLine = options.readLine ?? createConsoleReadLine();
  const writeLine = options.writeLine ?? ((text: string) => process.stdout.write(`${text}\n`));

  return {
    async runOnce(input: string): Promise<ReplTurnResult> {
      const result = await options.runTurn(input);

      return {
        finalAnswer: result.finalAnswer,
        stopReason: result.stopReason
      };
    },
    async runInteractive(): Promise<number> {
      while (true) {
        const line = await readLine(options.promptLabel);

        if (line === undefined) {
          writeLine('Goodbye.');
          return 0;
        }

        const trimmed = line.trim();

        if (trimmed.length === 0) {
          continue;
        }

        if (trimmed === '/exit' || trimmed === 'exit') {
          writeLine('Goodbye.');
          return 0;
        }

        const result = await this.runOnce(trimmed);
        writeLine(result.finalAnswer);
        options.afterTurnRendered?.();
      }
    }
  };
}

function createConsoleReadLine(): (promptLabel: string) => Promise<string | undefined> {
  return async (promptLabel: string) => {
    const terminal = createInterface({
      input: process.stdin as Readable,
      output: process.stdout as Writable
    });

    try {
      const line = await terminal.question(promptLabel);
      return line;
    } catch {
      return undefined;
    } finally {
      terminal.close();
    }
  };
}
