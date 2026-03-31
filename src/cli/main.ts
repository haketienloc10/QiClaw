import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { createInMemoryMetricsObserver } from '../telemetry/metrics.js';
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
        const parsed = parseArgs(argv);
        const providerConfig = resolveProviderConfig({
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey
        });
        const runtime = createRuntime({
          ...providerConfig,
          cwd,
          observer: metrics
        });
        const observer = runtime.observer;

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
                observer
              });
            },
            writeLine(text) {
              stdout.write(`${text}\n`);
            }
          });
          const result = await repl.runOnce(parsed.prompt);
          stdout.write(`${result.finalAnswer}\n`);
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
              observer,
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

function parseArgs(argv: string[]): { prompt?: string; provider: ProviderId; model?: string; baseUrl?: string; apiKey?: string } {
  let prompt: string | undefined;
  let provider: ProviderId = 'anthropic';
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;

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
    apiKey
  };
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
