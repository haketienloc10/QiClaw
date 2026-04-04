import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import type { AgentTurnStopReason, RunAgentTurnResult } from '../agent/loop.js';

export interface ReplTurnResult {
  finalAnswer: string;
  stopReason: AgentTurnStopReason;
}

export interface CreateReplOptions {
  promptLabel: string;
  multilinePromptLabel?: string;
  startupLines?: string[];
  helpText?: string;
  multilineNoticeText?: string;
  multilineDiscardedText?: string;
  runTurn(input: string): Promise<Pick<RunAgentTurnResult, 'finalAnswer' | 'stopReason' | 'toolRoundsUsed' | 'verification'>>;
  readLine?(promptLabel: string): Promise<string | undefined>;
  writeLine?(text: string): void;
  renderFinalAnswer?(text: string): void;
  afterTurnRendered?(): void;
}

export interface Repl {
  runOnce(input: string): Promise<ReplTurnResult>;
  runInteractive(): Promise<number>;
}

export function createRepl(options: CreateReplOptions): Repl {
  const readLine = options.readLine ?? createConsoleReadLine();
  const writeLine = options.writeLine ?? ((text: string) => process.stdout.write(`${text}\n`));
  const renderFinalAnswer = options.renderFinalAnswer ?? writeLine;
  let multilineMode = false;
  let multilineBuffer: string[] = [];

  function formatHelpText(): string {
    return options.helpText ?? 'Commands: /help, /multiline, /skills, /exit';
  }

  function isExitCommand(trimmed: string): boolean {
    return trimmed === '/exit' || trimmed === 'exit';
  }

  function isMultilineActive(): boolean {
    return multilineMode;
  }

  function clearMultilineBuffer(): void {
    multilineBuffer = [];
    multilineMode = false;
  }

  function appendMultilineLine(line: string): void {
    multilineBuffer.push(line);
  }

  function readBufferedMultilineText(): string {
    return multilineBuffer.join('\n').trim();
  }

  return {
    async runOnce(input: string): Promise<ReplTurnResult> {
      const result = await options.runTurn(input);

      return {
        finalAnswer: result.finalAnswer,
        stopReason: result.stopReason
      };
    },
    async runInteractive(): Promise<number> {
      for (const startupLine of options.startupLines ?? []) {
        writeLine(startupLine);
      }

      while (true) {
        const line = await readLine(isMultilineActive() ? (options.multilinePromptLabel ?? '… ') : options.promptLabel);

        if (line === undefined) {
          writeLine('Goodbye.');
          return 0;
        }

        const trimmed = line.trim();

        if (isMultilineActive()) {
          if (trimmed === '/send') {
            const multilineInput = readBufferedMultilineText();
            clearMultilineBuffer();

            if (multilineInput.length === 0) {
              continue;
            }

            const result = await this.runOnce(multilineInput);
            renderFinalAnswer(result.finalAnswer);
            options.afterTurnRendered?.();
            continue;
          }

          if (trimmed === '/cancel') {
            clearMultilineBuffer();
            writeLine(options.multilineDiscardedText ?? 'Multiline draft discarded.');
            continue;
          }

          appendMultilineLine(line);
          continue;
        }

        if (trimmed.length === 0) {
          continue;
        }

        if (isExitCommand(trimmed)) {
          writeLine('Goodbye.');
          return 0;
        }

        if (trimmed === '/help') {
          writeLine(formatHelpText());
          continue;
        }

        if (trimmed === '/skills') {
          writeLine('Skills coming soon.');
          continue;
        }

        if (trimmed === '/multiline') {
          multilineMode = true;
          multilineBuffer = [];
          writeLine(options.multilineNoticeText ?? 'Multiline mode on. Enter /send to submit or /cancel to discard.');
          continue;
        }

        const result = await this.runOnce(trimmed);
        renderFinalAnswer(result.finalAnswer);
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
