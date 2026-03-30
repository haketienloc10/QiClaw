import { createAgentRuntime, type AgentRuntime } from '../agent/runtime.js';
import { runAgentTurn, type RunAgentTurnInput, type RunAgentTurnResult } from '../agent/loop.js';
import { createInMemoryMetricsObserver } from '../telemetry/metrics.js';
import { createRepl } from './repl.js';

export type Cli = {
  run(): Promise<number>;
};

export interface BuildCliOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  createRuntime?: (options: { model: string; cwd: string; observer?: AgentRuntime['observer'] }) => AgentRuntime;
  runTurn?: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult>;
}

export function buildCli(options: BuildCliOptions = {}): Cli {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const metrics = createInMemoryMetricsObserver();
  const createRuntime = options.createRuntime ?? ((runtimeOptions) => createAgentRuntime(runtimeOptions));
  const executeTurn = options.runTurn ?? runAgentTurn;

  return {
    async run() {
      try {
        const parsed = parseArgs(argv);
        const runtime = createRuntime({
          model: parsed.model,
          cwd,
          observer: metrics
        });
        const observer = runtime.observer;
        const repl = createRepl({
          promptLabel: 'qiclaw> ',
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

        if (parsed.prompt) {
          const result = await repl.runOnce(parsed.prompt);
          stdout.write(`${result.finalAnswer}\n`);
          return 0;
        }

        return repl.runInteractive();
      } catch (error) {
        stderr.write(`${formatCliError(error)}\n`);
        return 1;
      }
    }
  };
}

function parseArgs(argv: string[]): { prompt?: string; model: string } {
  let prompt: string | undefined;
  let model = 'claude-sonnet-4-20250514';

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

    if (token === '--model') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --model');
      }

      model = value;
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
    model
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
