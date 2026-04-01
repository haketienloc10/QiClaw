import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createAgentRuntime, type AgentRuntime } from '../agent/runtime.js';
import { runAgentTurn, type RunAgentTurnInput, type RunAgentTurnResult } from '../agent/loop.js';
import { parseProviderId, resolveProviderConfig } from '../provider/config.js';
import type { ProviderId, ResolvedProviderConfig } from '../provider/model.js';
import { CheckpointStore } from '../session/checkpointStore.js';
import {
  createInteractiveCheckpointJson,
  createSessionId,
  getCheckpointStorePath,
  parseInteractiveCheckpointJson
} from '../session/session.js';
import { createCompositeObserver } from '../telemetry/composite.js';
import { createCompactCliTelemetryObserver, type CompactCliTelemetryObserver } from '../telemetry/display.js';
import { createFileJsonLineWriter, createJsonLineLogger } from '../telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../telemetry/metrics.js';
import type { TelemetryObserver } from '../telemetry/observer.js';
import { createRepl } from './repl.js';

export type Cli = {
  run(): Promise<number>;
};

type CliRunTurnInput = RunAgentTurnInput & {
  sessionId?: string;
};

export type CliRunTurnResult = RunAgentTurnResult & {
  historySummary?: string;
};

export interface BuildCliOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readLine?: (promptLabel: string) => Promise<string | undefined>;
  createRuntime?: (options: ResolvedProviderConfig & { cwd: string; observer?: AgentRuntime['observer'] }) => AgentRuntime;
  createCheckpointStore?: (filename: string) => CheckpointStore;
  createSessionId?: () => string;
  runTurn?: (input: CliRunTurnInput) => Promise<CliRunTurnResult>;
}

export function buildCli(options: BuildCliOptions = {}): Cli {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const metrics = createInMemoryMetricsObserver();
  const createRuntime = options.createRuntime ?? ((runtimeOptions) => createAgentRuntime(runtimeOptions));
  const checkpointStoreFactory = options.createCheckpointStore ?? ((filename) => new CheckpointStore(filename));
  const sessionIdFactory = options.createSessionId ?? createSessionId;
  const executeTurn: (input: CliRunTurnInput) => Promise<CliRunTurnResult> = options.runTurn
    ? options.runTurn
    : async ({ sessionId: _sessionId, ...input }) => runAgentTurn(input);

  return {
    async run() {
      try {
        loadCliEnvFiles(cwd);
        const parsed = parseArgs(argv);
        const providerConfig = resolveProviderConfig({
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey
        });
        const cliObserver = createCliObserver({
          cwd,
          stdout,
          metrics,
          debugLogPath: parsed.debugLogPath,
          envDebugLogPath: process.env.QICLAW_DEBUG_LOG,
          showCompactToolStatus: true
        });
        const runtime = createRuntime({
          ...providerConfig,
          cwd,
          observer: cliObserver.observer
        });

        if (parsed.prompt) {
          const repl = createRepl({
            promptLabel: 'qiclaw> ',
            readLine: options.readLine,
            async runTurn(userInput) {
              return executeTurn({
                provider: runtime.provider,
                availableTools: runtime.availableTools,
                baseSystemPrompt: 'You are a minimal single-agent CLI runtime.',
                userInput,
                cwd: runtime.cwd,
                maxToolRounds: 3,
                observer: cliObserver.observer
              });
            },
            writeLine(text) {
              stdout.write(`${text}\n`);
            }
          });
          const result = await repl.runOnce(parsed.prompt);
          stdout.write(`${result.finalAnswer}\n`);
          cliObserver.flushPendingFooter();
          return 0;
        }

        const checkpointStorePath = getCheckpointStorePath(runtime.cwd);
        mkdirSync(dirname(checkpointStorePath), { recursive: true });
        const checkpointStore = checkpointStoreFactory(checkpointStorePath);
        const latestCheckpoint = checkpointStore.getLatest();
        const restored = latestCheckpoint
          ? parseInteractiveCheckpointJson(latestCheckpoint.checkpointJson)
          : undefined;

        let sessionId = restored ? latestCheckpoint?.sessionId ?? sessionIdFactory() : sessionIdFactory();
        let history = restored?.history ?? [];
        let historySummary = restored?.historySummary;

        const repl = createRepl({
          promptLabel: 'qiclaw> ',
          readLine: options.readLine,
          async runTurn(userInput) {
            const result = await executeTurn({
              provider: runtime.provider,
              availableTools: runtime.availableTools,
              baseSystemPrompt: 'You are a minimal single-agent CLI runtime.',
              userInput,
              cwd: runtime.cwd,
              maxToolRounds: 3,
              observer: cliObserver.observer,
              history,
              historySummary,
              sessionId
            });

            if (result.stopReason === 'completed' || result.stopReason === 'max_tool_rounds_reached') {
              history = result.history;
              historySummary = readTurnHistorySummary(result) ?? historySummary;
              checkpointStore.save({
                sessionId,
                taskId: 'interactive',
                status: result.stopReason === 'completed' ? 'completed' : 'running',
                checkpointJson: createInteractiveCheckpointJson({
                  version: 1,
                  history,
                  historySummary
                })
              });
            }

            return result;
          },
          writeLine(text) {
            stdout.write(`${text}\n`);
          },
          afterTurnRendered() {
            cliObserver.flushPendingFooter();
          }
        });

        return repl.runInteractive();
      } catch (error) {
        stderr.write(`${formatCliError(error)}\n`);
        return 1;
      }
    }
  };
}

function readTurnHistorySummary(result: RunAgentTurnResult): string | undefined {
  const maybeResult = result as RunAgentTurnResult & { historySummary?: string };
  return maybeResult.historySummary;
}

function createCliObserver(options: {
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  metrics: TelemetryObserver;
  debugLogPath?: string;
  envDebugLogPath?: string;
  showCompactToolStatus?: boolean;
}): { observer: TelemetryObserver; flushPendingFooter(): void } {
  const observers: TelemetryObserver[] = [options.metrics];
  let compactObserver: CompactCliTelemetryObserver | undefined;

  if (options.showCompactToolStatus) {
    compactObserver = createCompactCliTelemetryObserver({
      writeLine(text) {
        options.stdout.write(`${text}\n`);
      }
    });
    observers.push(compactObserver);
  }
  const selectedDebugLogPath = options.debugLogPath ?? options.envDebugLogPath;

  if (selectedDebugLogPath) {
    const resolvedDebugLogPath = resolveCliPath(options.cwd, selectedDebugLogPath);
    mkdirSync(dirname(resolvedDebugLogPath), { recursive: true });
    observers.push(createJsonLineLogger(createFileJsonLineWriter(resolvedDebugLogPath)));
  }

  return {
    observer: createCompositeObserver(observers),
    flushPendingFooter() {
      compactObserver?.flushPendingFooter();
    }
  };
}

function resolveCliPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(cwd, filePath);
}

function parseArgs(argv: string[]): {
  prompt?: string;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  debugLogPath?: string;
} {
  let prompt: string | undefined;
  let provider = resolveDefaultProviderFromEnv();
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let debugLogPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--prompt') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --prompt');
      }

      prompt = value;
      index += 1;
      continue;
    }

    if (token === '--provider') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --provider');
      }

      provider = parseProviderId(value);
      index += 1;
      continue;
    }

    if (token === '--model') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --model');
      }

      model = value;
      index += 1;
      continue;
    }

    if (token === '--base-url') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --base-url');
      }

      baseUrl = value;
      index += 1;
      continue;
    }

    if (token === '--api-key') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --api-key');
      }

      apiKey = value;
      index += 1;
      continue;
    }

    if (token === '--debug-log') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --debug-log');
      }

      debugLogPath = value;
      index += 1;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    throw new Error(`Unexpected positional argument: ${token}`);
  }

  return {
    prompt,
    provider,
    model,
    baseUrl,
    apiKey,
    debugLogPath
  };
}

function resolveDefaultProviderFromEnv(): ProviderId {
  const providerFromEnv = process.env.MODEL?.trim();

  if (!providerFromEnv) {
    return 'anthropic';
  }

  return parseProviderId(providerFromEnv);
}

function loadCliEnvFiles(cwd: string): void {
  const originalEnvKeys = new Set(Object.keys(process.env));
  const fileLoadedKeys = new Set<string>();

  applyEnvFile(join(cwd, '.env'), originalEnvKeys, fileLoadedKeys);
  applyEnvFile(join(cwd, '.env.local'), originalEnvKeys, fileLoadedKeys);
}

function applyEnvFile(filePath: string, originalEnvKeys: Set<string>, fileLoadedKeys: Set<string>): void {
  let fileContents: string;

  try {
    fileContents = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    throw error;
  }

  for (const [key, value] of parseEnvFile(fileContents)) {
    if (originalEnvKeys.has(key) && !fileLoadedKeys.has(key)) {
      continue;
    }

    process.env[key] = value;
    fileLoadedKeys.add(key);
  }
}

function parseEnvFile(fileContents: string): Array<[string, string]> {
  return fileContents.split(/\r?\n/u).flatMap((line, index) => {
    const normalizedLine = index === 0 ? line.replace(/^\uFEFF/u, '') : line;
    const trimmedLine = normalizedLine.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
      return [];
    }

    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u.exec(trimmedLine);

    if (!match?.groups) {
      throw new Error(`Malformed env file line ${index + 1}: ${trimmedLine}`);
    }

    return [[match.groups.key, match.groups.value.trim()] as [string, string]];
  });
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const cli = buildCli();

  void cli.run()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    });
}
