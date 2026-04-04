import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import pc from 'picocolors';
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
import {
  createCompactCliTelemetryObserver,
  type CompactCliTelemetryObserver
} from '../telemetry/display.js';
import { createFileJsonLineWriter, createJsonLineLogger } from '../telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../telemetry/metrics.js';
import type { TelemetryObserver } from '../telemetry/observer.js';
import { createRepl } from './repl.js';

export type Cli = {
  run(): Promise<number>;
};

interface AssistantBlockWriter {
  startProviderThinking(): void;
  markResponding(): void;
  writeAssistantLine(text: string, toolCallId?: string): void;
  writeAssistantLineBelow(toolCallId: string, text: string): void;
  replaceAssistantLine(toolCallId: string, text: string): void;
  writeAssistantTextBlock(text: string): void;
  writeFooterLine(text: string): void;
  resetTurn(): void;
}

interface InteractiveChromeOptions {
  modelLabel?: string;
}

type CliDisplayMode = 'compact' | 'interactive';

interface PendingFooterRenderState {
  isVerified: boolean;
  toolRoundsUsed: number;
}

type CliStdout = Pick<NodeJS.WriteStream, 'write'> & {
  isTTY?: boolean;
  clearLine?(dir: -1 | 0 | 1, callback?: () => void): boolean;
  moveCursor?(dx: number, dy: number, callback?: () => void): boolean;
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
  createRuntime?: (options: ResolvedProviderConfig & { cwd: string; observer?: AgentRuntime['observer']; agentSpecName?: string }) => AgentRuntime;
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
      let assistantBlockWriter: AssistantBlockWriter | undefined;

      try {
        loadCliEnvFiles(cwd);
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
          observer: undefined,
          agentSpecName: parsed.agentSpecName
        });

        assistantBlockWriter = createAssistantBlockWriter(stdout, parsed.prompt ? 'compact' : 'interactive');
        const cliObserver = createCliObserver({
          cwd,
          metrics,
          debugLogPath: parsed.debugLogPath,
          envDebugLogPath: process.env.QICLAW_DEBUG_LOG,
          showCompactToolStatus: true,
          assistantBlockWriter,
          mode: parsed.prompt ? 'compact' : 'interactive'
        });
        runtime.observer = cliObserver.observer;

        if (parsed.prompt) {
          const repl = createRepl({
            promptLabel: '> ',
            readLine: options.readLine,
            async runTurn(userInput) {
              return executeTurn({
                provider: runtime.provider,
                availableTools: runtime.availableTools,
                baseSystemPrompt: runtime.systemPrompt,
                userInput,
                cwd: runtime.cwd,
                maxToolRounds: runtime.maxToolRounds,
                agentSpec: runtime.agentSpec,
                observer: cliObserver.observer
              });
            },
            writeLine(text) {
              stdout.write(`${text}\n`);
            },
            renderFinalAnswer(text) {
              assistantBlockWriter?.writeAssistantTextBlock(text);
            }
          });
          const result = await repl.runOnce(parsed.prompt);
          if (result.finalAnswer.length > 0) {
            assistantBlockWriter?.writeAssistantTextBlock(result.finalAnswer);
          }
          cliObserver.flushPendingFooter();
          assistantBlockWriter?.resetTurn();
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
          promptLabel: pc.cyan('» '),
          multilinePromptLabel: pc.cyan('» '),
          startupLines: formatInteractiveChrome({ modelLabel: runtime.provider.model }),
          helpText: formatInteractiveInfoLine('Commands: /help, /multiline, /skills, /exit'),
          multilineNoticeText: formatInteractiveInfoLine('Multiline mode on. Enter /send to submit or /cancel to discard.'),
          multilineDiscardedText: formatInteractiveInfoLine('Multiline draft discarded.'),
          readLine: options.readLine,
          async runTurn(userInput) {
            const result = await executeTurn({
              provider: runtime.provider,
              availableTools: runtime.availableTools,
              baseSystemPrompt: runtime.systemPrompt,
              userInput,
              cwd: runtime.cwd,
              maxToolRounds: runtime.maxToolRounds,
              agentSpec: runtime.agentSpec,
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
          renderFinalAnswer(text) {
            assistantBlockWriter?.writeAssistantTextBlock(text);
          },
          afterTurnRendered() {
            cliObserver.flushPendingFooter();
            assistantBlockWriter?.resetTurn();
          }
        });

        return repl.runInteractive();
      } catch (error) {
        stderr.write(`${formatCliError(error)}\n`);
        return 1;
      } finally {
        assistantBlockWriter?.resetTurn();
      }
    }
  };
}

function readTurnHistorySummary(result: RunAgentTurnResult): string | undefined {
  const maybeResult = result as RunAgentTurnResult & { historySummary?: string };
  return maybeResult.historySummary;
}

function createAssistantBlockWriter(stdout: CliStdout, mode: CliDisplayMode): AssistantBlockWriter {
  const showAssistantLabel = mode === 'compact';
  let hasStartedTurn = false;
  let hasWrittenOutput = false;
  let trailingNewlineCount = 0;
  let activeActivityLineCount = 0;
  let providerStatus: 'thinking' | 'responding' | undefined;
  let providerStatusFrameIndex = 0;
  let hasRenderedProviderStatusLine = false;
  let providerStatusTimer: ReturnType<typeof setInterval> | undefined;
  const activityLineIndexes = new Map<string, number>();
  const renderedActivityLines: string[] = [];
  const providerThinkingFrames = [
    `${pc.cyan('🧠 Thinking.')}`,
    `${pc.cyan('🧠 Thinking..')}`,
    `${pc.cyan('🧠 Thinking...')}`
  ]

  function write(text: string): void {
    stdout.write(text);
    hasWrittenOutput = true;

    let newlineCount = 0;
    for (let index = text.length - 1; index >= 0 && text[index] === '\n'; index -= 1) {
      newlineCount += 1;
    }

    trailingNewlineCount = newlineCount === text.length ? trailingNewlineCount + newlineCount : newlineCount;
    if (newlineCount === 0) {
      trailingNewlineCount = 0;
    }
  }

  function writeRaw(text: string): void {
    write(text);
  }

  function clearProviderStatusTimer(): void {
    if (!providerStatusTimer) {
      return;
    }

    clearInterval(providerStatusTimer);
    providerStatusTimer = undefined;
  }

  function resetActivityTracking(): void {
    activeActivityLineCount = 0;
    activityLineIndexes.clear();
    renderedActivityLines.length = 0;
  }

  function updateActivityLineIndexes(startIndex: number): void {
    for (const [toolCallId, index] of activityLineIndexes) {
      if (index >= startIndex) {
        activityLineIndexes.set(toolCallId, index + 1);
      }
    }
  }

  function writeRenderedActivityLine(text: string): void {
    const line = mode === 'interactive' ? `${text}\n` : `  ${text}\n`;
    writeRaw(line);
    activeActivityLineCount += 1;
  }

  function canRewriteTerminalLines(): boolean {
    return Boolean(stdout.isTTY && stdout.moveCursor && stdout.clearLine);
  }

  function rewritePreviousLine(): void {
    if (!stdout.isTTY) {
      return;
    }

    if (canRewriteTerminalLines()) {
      stdout.moveCursor?.(0, -1);
      stdout.clearLine?.(0);
      return;
    }

    writeRaw('\u001b[1A\u001b[2K');
  }

  function clearActiveActivityLines(): void {
    if (!stdout.isTTY || activeActivityLineCount === 0) {
      activeActivityLineCount = 0;
      return;
    }

    for (let index = 0; index < activeActivityLineCount; index += 1) {
      rewritePreviousLine();
    }

    activeActivityLineCount = 0;
  }

  function renderActivityLines(): void {
    for (const line of renderedActivityLines) {
      writeRenderedActivityLine(line);
    }
  }

  function rerenderActivityLines(): void {
    if (!stdout.isTTY) {
      return;
    }

    clearActiveActivityLines();
    renderActivityLines();
  }

  function ensureTurnPrelude(): void {
    if (hasStartedTurn) {
      return;
    }

    if (!hasWrittenOutput) {
      write('\n');
    } else if (trailingNewlineCount === 0) {
      write('\n');
    } else if (trailingNewlineCount === 1) {
      write('\n');
    }

    if (showAssistantLabel) {
      write(`${pc.bold('QiClaw')}\n`);
    }

    hasStartedTurn = true;
  }

  function writeProviderStatusLine(text: string): void {
    writeRaw(`${text}\n`);
    hasRenderedProviderStatusLine = true;
  }

  function rewriteProviderStatusLine(): void {
    if (!stdout.isTTY || !hasRenderedProviderStatusLine) {
      return;
    }

    rewritePreviousLine();
  }

  function renderThinkingFrame(): void {
    const frame = providerThinkingFrames[providerStatusFrameIndex] ?? providerThinkingFrames[0];
    providerStatusFrameIndex = (providerStatusFrameIndex + 1) % providerThinkingFrames.length;

    if (stdout.isTTY && providerStatus === 'thinking') {
      rewriteProviderStatusLine();
    }

    writeProviderStatusLine(frame);
  }

  function prepareForProviderRound(): void {
    if (!hasStartedTurn) {
      ensureTurnPrelude();
    }

    resetActivityTracking();
    providerStatus = undefined;
    hasRenderedProviderStatusLine = false;
  }

  function ensureRespondingStatus(): void {
    if (providerStatus !== 'thinking') {
      return;
    }

    clearProviderStatusTimer();

    if (stdout.isTTY) {
      rewriteProviderStatusLine();
      writeProviderStatusLine('\u001b[32m✓\u001b[39m Responding');
    } else {
      writeProviderStatusLine(pc.green('✓ Responding'));
    }

    providerStatus = 'responding';
  }

  return {
    startProviderThinking() {
      clearProviderStatusTimer();
      prepareForProviderRound();
      providerStatus = 'thinking';
      providerStatusFrameIndex = 0;
      renderThinkingFrame();

      if (!stdout.isTTY) {
        return;
      }

      providerStatusTimer = setInterval(() => {
        if (providerStatus !== 'thinking') {
          clearProviderStatusTimer();
          return;
        }

        renderThinkingFrame();
      }, 500);
    },
    markResponding() {
      ensureRespondingStatus();
    },
    writeAssistantLine(text: string, toolCallId?: string) {
      ensureTurnPrelude();
      ensureRespondingStatus();
      if (toolCallId) {
        activityLineIndexes.set(toolCallId, renderedActivityLines.length);
      }
      renderedActivityLines.push(text);
      writeRenderedActivityLine(text);
    },
    writeAssistantLineBelow(toolCallId: string, text: string) {
      ensureTurnPrelude();
      ensureRespondingStatus();
      const index = activityLineIndexes.get(toolCallId);

      if (index !== undefined) {
        const insertIndex = index + 1;
        renderedActivityLines.splice(insertIndex, 0, text);
        updateActivityLineIndexes(insertIndex);

        if (stdout.isTTY) {
          rerenderActivityLines();
          return;
        }
      }

      renderedActivityLines.push(text);
      writeRenderedActivityLine(text);
    },
    replaceAssistantLine(toolCallId: string, text: string) {
      ensureTurnPrelude();
      ensureRespondingStatus();

      if (mode === 'interactive' && !stdout.isTTY) {
        return;
      }

      const index = activityLineIndexes.get(toolCallId);
      if (index !== undefined) {
        renderedActivityLines[index] = text;
        if (stdout.isTTY) {
          rerenderActivityLines();
          return;
        }
      }

      writeRenderedActivityLine(text);
    },
    writeAssistantTextBlock(text: string) {
      ensureTurnPrelude();
      ensureRespondingStatus();
      activeActivityLineCount = 0;

      if (mode === 'interactive') {
        write(`${pc.dim('─'.repeat(54))}\n`);
        write('\n');

        for (const line of text.split('\n')) {
          write(`${line}\n`);
        }
      } else {
        for (const line of text.split('\n')) {
          write(`  ${line}\n`);
        }
      }

      providerStatus = undefined;
    },
    writeFooterLine(text: string) {
      ensureTurnPrelude();
      ensureRespondingStatus();
      activeActivityLineCount = 0;
      write(`${text}\n\n`);
      providerStatus = undefined;
    },
    resetTurn() {
      clearProviderStatusTimer();
      hasStartedTurn = false;
      activeActivityLineCount = 0;
      providerStatus = undefined;
      providerStatusFrameIndex = 0;
      hasRenderedProviderStatusLine = false;
      activityLineIndexes.clear();
      renderedActivityLines.length = 0;
    }
  };
}

function createCliObserver(options: {
  cwd: string;
  metrics: TelemetryObserver;
  debugLogPath?: string;
  envDebugLogPath?: string;
  showCompactToolStatus?: boolean;
  assistantBlockWriter: AssistantBlockWriter;
  mode?: 'compact' | 'interactive';
}): {
  observer: TelemetryObserver;
  flushPendingFooter(): void;
} {
  const observers: TelemetryObserver[] = [options.metrics];
  let compactObserver: CompactCliTelemetryObserver | undefined;
  let pendingFooterRenderState: PendingFooterRenderState | undefined;

  if (options.showCompactToolStatus) {
    compactObserver = createCompactCliTelemetryObserver({
      mode: options.mode,
      writeActivityLine(text, toolCallId) {
        options.assistantBlockWriter.writeAssistantLine(text, toolCallId);
      },
      writeActivityLineBelow(toolCallId, text) {
        options.assistantBlockWriter.writeAssistantLineBelow(toolCallId, text);
      },
      replaceActivityLine(toolCallId, text) {
        options.assistantBlockWriter.replaceAssistantLine(toolCallId, text);
      },
      writeFooterLine(text) {
        let renderedText = text;

        if ((options.mode ?? 'compact') === 'compact') {
          if (pendingFooterRenderState?.isVerified) {
            renderedText = renderedText.replace('─ completed', '─ completed • verified');
          }

          if (pendingFooterRenderState && pendingFooterRenderState.toolRoundsUsed > 0) {
            renderedText = renderedText.replace(
              ' provider',
              ` provider • ${pendingFooterRenderState.toolRoundsUsed} tool round`
            );
          }
        }

        options.assistantBlockWriter.writeFooterLine(renderedText);
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

  const compositeObserver = createCompositeObserver(observers);

  return {
    observer: {
      record(event) {
        if (event.type === 'provider_called') {
          options.assistantBlockWriter.startProviderThinking();
        } else if (event.type === 'provider_responded') {
          options.assistantBlockWriter.markResponding();
        } else if (event.type === 'turn_completed' || event.type === 'turn_stopped') {
          pendingFooterRenderState = {
            isVerified: event.data.isVerified,
            toolRoundsUsed: event.data.toolRoundsUsed
          };
        }

        compositeObserver.record(event);
      }
    },
    flushPendingFooter() {
      compactObserver?.flushPendingFooter();
      pendingFooterRenderState = undefined;
    }
  };
}

function resolveCliPath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(cwd, filePath);
}

function formatInteractiveChrome(options: InteractiveChromeOptions): string[] {
  const width = 54;
  const innerWidth = width - 5;
  const leftPlain = '⚡QiClaw';
  const rightPlain = `🤖 Model: ${options.modelLabel ?? 'unknown'}`;
  const spaces = ' '.repeat(Math.max(1, innerWidth - leftPlain.length - rightPlain.length));

  return [
    `${pc.cyan('┌')}${pc.cyan('─'.repeat(width - 2))}${pc.cyan('┐')}`,
    `${pc.cyan('│')} ${pc.bold(pc.cyan(leftPlain))}${spaces}${pc.dim(rightPlain)} ${pc.cyan('│')}`,
    `${pc.cyan('└')}${pc.cyan('─'.repeat(width - 2))}${pc.cyan('┘')}`
  ];
}

function formatInteractiveInfoLine(text: string): string {
  return `${pc.cyan('ℹ')} ${pc.dim(text)}`;
}

function parseArgs(argv: string[]): {
  prompt?: string;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  debugLogPath?: string;
  agentSpecName?: string;
} {
  let prompt: string | undefined;
  let provider = resolveDefaultProviderFromEnv();
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let debugLogPath: string | undefined;
  let agentSpecName: string | undefined;

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

    if (token === '--agent-spec') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --agent-spec');
      }

      agentSpecName = value;
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
    debugLogPath,
    agentSpecName
  };
}

function resolveDefaultProviderFromEnv(): ProviderId {
  const providerFromEnv = process.env.MODEL?.trim();

  if (!providerFromEnv) {
    return 'openai';
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
