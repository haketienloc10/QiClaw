import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { parseBridgeMessage, serializeBridgeMessage, type FrontendAction, type HostEvent } from './tuiProtocol.js';

interface BridgePipeReader {
  setEncoding(encoding: BufferEncoding): void;
  on(event: 'data', listener: (chunk: string) => void): void;
}

interface BridgePipeWriter {
  write(chunk: string): boolean;
}

interface SpawnedBridgeProcess {
  stdio: [NodeJS.ReadableStream | null, NodeJS.WritableStream | null, NodeJS.WritableStream | null, BridgePipeWriter, BridgePipeReader];
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface TuiBridge {
  send(event: HostEvent): void;
  dispose(): void;
  completion: Promise<number>;
}

export interface TuiLaunchOptions {
  cwd: string;
  onAction(action: FrontendAction): Promise<boolean | void>;
  onReady?(bridge: TuiBridge): Promise<void> | void;
  createBridge?(options: CreateTuiBridgeOptions): Promise<TuiBridge>;
}

export interface CreateTuiBridgeOptions {
  cwd: string;
  binaryPath?: string;
  onAction(action: FrontendAction): Promise<boolean | void>;
  spawnProcess?: (binaryPath: string, cwd: string) => SpawnedBridgeProcess;
}

export async function launchTui(options: TuiLaunchOptions): Promise<number> {
  const bridge = await (options.createBridge ?? createTuiBridge)({
    cwd: options.cwd,
    onAction: options.onAction
  });

  try {
    await options.onReady?.(bridge);
  } catch (error) {
    bridge.dispose();
    throw error;
  }

  return bridge.completion;
}

export async function createTuiBridge(options: CreateTuiBridgeOptions): Promise<TuiBridge> {
  const binaryPath = options.binaryPath ?? await resolveTuiBinaryPath(options.cwd);
  const child = (options.spawnProcess ?? spawnBridgeProcess)(binaryPath, options.cwd);
  const hostWriter = child.stdio[3];
  const actionReader = child.stdio[4];
  let stdoutBuffer = '';
  let settled = false;
  let allowExpectedExit = false;
  let resolveCompletion: ((code: number) => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  let actionQueue = Promise.resolve();

  const completeWithError = (error: Error) => {
    if (settled) {
      return;
    }

    settled = true;
    rejectCompletion?.(error);
  };

  const completeWithExit = (code: number | null, signal: NodeJS.Signals | null) => {
    actionQueue.finally(() => {
      if (settled) {
        return;
      }

      if (allowExpectedExit && code === 0 && signal === null) {
        settled = true;
        resolveCompletion?.(0);
        return;
      }

      settled = true;
      if (signal) {
        rejectCompletion?.(new Error(`qiclaw-tui exited unexpectedly with signal ${signal}.`));
        return;
      }

      if (code === null || code === 0) {
        rejectCompletion?.(new Error('qiclaw-tui exited unexpectedly.'));
        return;
      }

      rejectCompletion?.(new Error(`qiclaw-tui exited with code ${code}.`));
    });
  };

  actionReader.setEncoding('utf8');
  actionReader.on('data', (chunk: string) => {
    if (settled) {
      return;
    }

    stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line.trim().length === 0) {
        continue;
      }

      let message: HostEvent | FrontendAction;
      try {
        message = parseBridgeMessage(line);
      } catch (error) {
        completeWithError(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (!isFrontendAction(message)) {
        completeWithError(new Error('Unexpected host event on action pipe.'));
        return;
      }

      actionQueue = actionQueue
        .then(async () => {
          const shouldContinue = await options.onAction(message);
          if (message.type === 'quit') {
            allowExpectedExit = true;
          }
          if (shouldContinue === false && message.type !== 'quit') {
            completeWithError(new Error(`Unexpected false return for frontend action ${message.type}.`));
          }
        })
        .catch((error) => {
          completeWithError(error instanceof Error ? error : new Error(String(error)));
        });
    }
  });

  const completion = new Promise<number>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      completeWithExit(code, signal);
    });
  });

  return {
    send(event: HostEvent) {
      if (!settled) {
        hostWriter.write(serializeBridgeMessage(event));
      }
    },
    dispose() {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolveCompletion?.(0);
    },
    completion
  };
}

function spawnBridgeProcess(binaryPath: string, cwd: string): SpawnedBridgeProcess {
  return spawn(binaryPath, [], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']
  }) as unknown as SpawnedBridgeProcess;
}

function isFrontendAction(message: HostEvent | FrontendAction): message is FrontendAction {
  return message.type === 'submit_prompt'
    || message.type === 'run_slash_command'
    || message.type === 'run_shell_command'
    || message.type === 'request_status'
    || message.type === 'clear_session'
    || message.type === 'quit';
}

export async function resolveTuiBinaryPath(cwd: string): Promise<string> {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const envPath = process.env.QICLAW_TUI_BIN?.trim();
  const candidates = [
    envPath,
    join(cwd, 'tui', 'target', 'debug', `qiclaw-tui${extension}`),
    join(cwd, 'tui', 'target', 'release', `qiclaw-tui${extension}`)
  ].filter((value): value is string => Boolean(value && value.length > 0));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error('Unable to locate qiclaw-tui binary. Set QICLAW_TUI_BIN or build tui/target/{debug,release}/qiclaw-tui.');
}
