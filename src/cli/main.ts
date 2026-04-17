import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import pc from 'picocolors';
import { createAgentPackagePreview } from '../agent/packagePreview.js';
import { resolveAgentPackage as resolveAgentPackageForPreview } from '../agent/packageResolver.js';
import { createAgentRuntime, type AgentRuntime } from '../agent/runtime.js';
import type { ResolvedAgentPackage } from '../agent/spec.js';
import {
  createRunAgentTurnExecution,
  type ModelMemoryCandidate,
  type RunAgentTurnInput,
  type RunAgentTurnResult,
  type TurnEvent
} from '../agent/loop.js';
import { pruneHistoryForContext } from '../context/historyPruner.js';
import { parseProviderId, resolveProviderConfig } from '../provider/config.js';
import type { ProviderId, ResolvedProviderConfig } from '../provider/model.js';
import { CheckpointStore } from '../session/checkpointStore.js';
import {
  createInteractiveCheckpointJson,
  createSessionId,
  getCheckpointStorePath,
  parseInteractiveCheckpointJson
} from '../session/session.js';
import {
  captureInteractiveTurnMemory,
  inspectInteractiveRecall,
  prepareInteractiveSessionMemory,
  type RecallInputsDebugRecord
} from '../memory/sessionMemoryEngine.js';
import { resolveMemoryEmbeddingConfig } from '../memory/memoryEmbeddingConfig.js';
import { createCompositeObserver } from '../telemetry/composite.js';
import {
  createCompactCliTelemetryObserver,
  type CompactCliTelemetryObserver
} from '../telemetry/display.js';
import { createFileJsonLineWriter, createJsonLineLogger, type JsonLineWriter } from '../telemetry/logger.js';
import { createInMemoryMetricsObserver } from '../telemetry/metrics.js';
import type { TelemetryObserver } from '../telemetry/observer.js';
import { createRepl } from './repl.js';
import { createTelemetryEvent } from '../telemetry/observer.js';
import type { Message } from '../core/types.js';
import { createTuiController, type TuiController } from './tuiController.js';
import { launchTui as launchTuiFrontend, type TuiLaunchOptions } from './tuiLauncher.js';
import { parseBridgeMessage, type HostEvent } from './tuiProtocol.js';

export type Cli = {
  run(): Promise<number>;
};

interface AssistantBlockWriter {
  startProviderThinking(): void;
  markResponding(): void;
  writeAssistantLine(text: string, toolCallId?: string): void;
  writeAssistantLineBelow(toolCallId: string, text: string): void;
  replaceAssistantLine(toolCallId: string, text: string): void;
  writeAssistantTextDelta(text: string): void;
  finishAssistantTextBlock(): void;
  hasStreamedAssistantText(): boolean;
  writeAssistantTextBlock(text: string): void;
  writeFooterLine(text: string): void;
  resetTurn(): void;
}

interface InteractiveChromeOptions {
  modelLabel?: string;
}

interface InteractiveStartupLinesOptions extends InteractiveChromeOptions {
  history: Message[];
  historySummary?: string;
  restored: boolean;
}

type CliDisplayMode = 'compact' | 'plain' | 'interactive';

interface PendingFooterRenderState {
  isVerified: boolean;
  toolRoundsUsed: number;
}

interface MemoryCandidatesDebugRecord {
  type: 'memory_candidates';
  timestamp: string;
  sessionId: string;
  sourceTurnId?: string;
  parsed: boolean;
  count: number;
  candidates: ModelMemoryCandidate[];
  parseFallbackUsed: boolean;
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
  stdout?: Pick<NodeJS.WriteStream, 'write'> & { isTTY?: boolean };
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readLine?: (promptLabel: string) => Promise<string | undefined>;
  createRuntime?: (options: ResolvedProviderConfig & {
    cwd: string;
    observer?: AgentRuntime['observer'];
    agentSpecName?: string;
    resolvedPackage?: ResolvedAgentPackage;
  }) => AgentRuntime;
  createCheckpointStore?: (filename: string) => CheckpointStore;
  createSessionId?: () => string;
  runTurn?: (input: CliRunTurnInput) => Promise<CliRunTurnResult>;
  prepareSessionMemory?: typeof prepareInteractiveSessionMemory;
  captureTurnMemory?: typeof captureInteractiveTurnMemory;
  createTuiController?: (options: Parameters<typeof createTuiController>[0]) => TuiController;
  launchTui?: (options: TuiLaunchOptions) => Promise<number>;
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
  const prepareSessionMemory = options.prepareSessionMemory ?? prepareInteractiveSessionMemory;
  const captureTurnMemory = options.captureTurnMemory ?? captureInteractiveTurnMemory;
  const tuiControllerFactory = options.createTuiController ?? ((controllerOptions: Parameters<typeof createTuiController>[0]) => createTuiController(controllerOptions));
  const launchTui = options.launchTui ?? ((launchOptions: TuiLaunchOptions) => launchTuiFrontend(launchOptions));
  const executeTurn: (input: CliRunTurnInput) => Promise<CliRunTurnResult & { finalResult?: Promise<CliRunTurnResult> }> = options.runTurn
    ? options.runTurn
    : async ({ sessionId: _sessionId, ...input }) => {
        const execution = createRunAgentTurnExecution(input);
        const turnResult = execution.turnResult;

        return {
          stopReason: 'completed',
          finalAnswer: '',
          history: [],
          memoryCandidates: [],
          structuredOutputParsed: false,
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false,
            requiresSubstantiveFinalAnswer: false,
            forbidSuccessAfterToolErrors: false
          },
          verification: {
            isVerified: false,
            finalAnswerIsNonEmpty: false,
            finalAnswerIsSubstantive: false,
            toolEvidenceSatisfied: false,
            noUnresolvedToolErrors: false,
            toolMessagesCount: 0,
            checks: []
          },
          turnStream: execution.turnStream,
          finalResult: turnResult
        };
      };

  return {
    async run() {
      let assistantBlockWriter: AssistantBlockWriter | undefined;

      try {
        loadCliEnvFiles(cwd);
        const parsed = parseArgs(argv);

        if (parsed.agentSpecPreviewName) {
          stdout.write(await formatAgentSpecPreview(parsed.agentSpecPreviewName, cwd));
          return 0;
        }

        const providerConfig = resolveProviderConfig({
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: parsed.baseUrl,
          apiKey: parsed.apiKey
        });
        const resolvedPackage = parsed.agentSpecName
          ? await resolveAgentPackageForCliExecution(parsed.agentSpecName, cwd)
          : undefined;
        const runtime = createRuntime({
          ...providerConfig,
          cwd,
          observer: undefined,
          agentSpecName: parsed.agentSpecName,
          resolvedPackage
        });
        const memoryConfig = resolveMemoryEmbeddingConfig(process.env);
        const displayMode: CliDisplayMode = parsed.prompt
          ? 'compact'
          : (shouldLaunchTui(stdout) ? 'interactive' : 'plain');

        if (displayMode === 'interactive') {
          try {
            const checkpointStorePath = getCheckpointStorePath(runtime.cwd);
            mkdirSync(dirname(checkpointStorePath), { recursive: true });
            const checkpointStore = checkpointStoreFactory(checkpointStorePath);
            let controllerSend: ((event: HostEvent) => void) | undefined;
            const controller = tuiControllerFactory({
              cwd,
              runtime,
              checkpointStore,
              executeTurn,
              prepareSessionMemory,
              captureTurnMemory,
              createSessionId: sessionIdFactory,
              updateModel(argsText) {
                const trimmed = argsText.trim();
                const separatorIndex = trimmed.indexOf(':');
                const provider = separatorIndex >= 0
                  ? parseProviderId(trimmed.slice(0, separatorIndex).trim())
                  : parseProviderId(runtime.provider.name);
                const model = separatorIndex >= 0
                  ? trimmed.slice(separatorIndex + 1).trim()
                  : trimmed;

                if (model.length === 0) {
                  throw new Error('Model name is required. Use /model <model> or /model <provider:model>.');
                }

                const nextConfig = resolveProviderConfig({ provider, model });
                const nextRuntime = createRuntime({
                  ...nextConfig,
                  cwd: runtime.cwd,
                  observer: runtime.observer,
                  resolvedPackage: runtime.resolvedPackage
                });

                runtime.provider = nextRuntime.provider;
                runtime.availableTools = nextRuntime.availableTools;
                runtime.systemPrompt = nextRuntime.systemPrompt;
                runtime.maxToolRounds = nextRuntime.maxToolRounds;
                runtime.resolvedPackage = nextRuntime.resolvedPackage;
                runtime.observer = nextRuntime.observer;

                return {
                  provider: runtime.provider.name,
                  model: runtime.provider.model
                };
              },
              emit(message) {
                const event = parseBridgeMessage(message);
                if (event.type === 'submit_prompt'
                  || event.type === 'run_slash_command'
                  || event.type === 'run_shell_command'
                  || event.type === 'request_status'
                  || event.type === 'clear_session'
                  || event.type === 'quit') {
                  throw new Error('TUI controller emitted a frontend action instead of a host event.');
                }
                controllerSend?.(event);
              }
            });

            return await launchTui({
              cwd,
              async onReady(bridge) {
                controllerSend = (event) => bridge.send(event);
                await controller.start();
              },
              async onAction(action) {
                return controller.handleAction(action);
              }
            });
          } catch (error) {
            stderr.write(`Falling back to plain mode: ${formatCliError(error)}\n`);
          }
        }

        assistantBlockWriter = createAssistantBlockWriter(stdout, displayMode === 'compact' ? 'compact' : 'interactive');
        const cliObserver = createCliObserver({
          cwd,
          metrics,
          debugLogPath: parsed.debugLogPath,
          envDebugLogPath: process.env.QICLAW_DEBUG_LOG,
          showCompactToolStatus: true,
          assistantBlockWriter,
          mode: displayMode === 'compact' ? 'compact' : 'interactive'
        });
        const debugRecallInputs = cliObserver.createRecallInputsDebugLogger();
        const debugMemoryCandidates = cliObserver.createMemoryCandidatesDebugLogger();
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
                resolvedPackage: runtime.resolvedPackage,
                observer: cliObserver.observer
              });
            },
            async onTurnEvent(event) {
              handleCliTurnEvent(event, assistantBlockWriter, 'compact', {
                allowTurnEventToolActivityFallback: Boolean(options.runTurn)
              });
            },
            writeLine(text) {
              stdout.write(`${text}\n`);
            },
            renderFinalAnswer(text) {
              if (!assistantBlockWriter?.hasStreamedAssistantText() && text.length > 0) {
                assistantBlockWriter?.writeAssistantTextBlock(text);
              }
            }
          });
          try {
          const result = await repl.runOnce(parsed.prompt);
          if (!assistantBlockWriter?.hasStreamedAssistantText() && result.finalAnswer.length > 0) {
            assistantBlockWriter?.writeAssistantTextBlock(result.finalAnswer);
          }
          cliObserver.flushPendingFooter();
          assistantBlockWriter?.resetTurn();
          return 0;
        } catch (error) {
          if (error instanceof Error && 'replTurnErrorRendered' in error && error.replTurnErrorRendered === true) {
            assistantBlockWriter?.resetTurn();
            return 1;
          }
          throw error;
        }
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
        let sessionMemoryState = restored?.sessionMemory;

        const repl = createRepl({
          promptLabel: pc.cyan('» '),
          multilinePromptLabel: pc.cyan('» '),
          startupLines: formatInteractiveStartupLines({
            modelLabel: runtime.provider.model,
            history,
            historySummary,
            restored: Boolean(restored)
          }),
          helpText: formatInteractiveInfoLine('Commands: /help, /multiline, /skills, /recal, /exit'),
          multilineNoticeText: formatInteractiveInfoLine('Multiline mode on. Enter /send to submit or /cancel to discard.'),
          multilineDiscardedText: formatInteractiveInfoLine('Multiline draft discarded.'),
          readLine: options.readLine,
          async onTurnEvent(event) {
            handleCliTurnEvent(event, assistantBlockWriter, 'interactive', {
              allowTurnEventToolActivityFallback: Boolean(options.runTurn)
            });
          },
          async runTurn(userInput) {
            if (userInput.startsWith('/recal')) {
              const recallInput = userInput.slice('/recal'.length).trim();

              if (recallInput.length === 0) {
                return {
                  stopReason: 'completed' as const,
                  finalAnswer: 'Usage: /recal <input>',
                  history,
                  toolRoundsUsed: 0,
                  verification: {
                    isVerified: true,
                    finalAnswerIsNonEmpty: true,
                    finalAnswerIsSubstantive: true,
                    toolEvidenceSatisfied: true,
                    noUnresolvedToolErrors: true,
                    toolMessagesCount: 0,
                    checks: []
                  }
                };
              }

              const historyContext = buildPromptHistoryContext(history, historySummary);
              const inspection = await inspectInteractiveRecall({
                cwd: runtime.cwd,
                sessionId: sessionMemoryState?.storeSessionId ?? sessionId,
                userInput: recallInput,
                historySummary: historyContext.historySummary,
                checkpointState: sessionMemoryState,
                debugRecallInputs,
                memoryConfig,
                now: new Date().toISOString()
              });

              checkpointStore.save({
                sessionId,
                taskId: 'interactive',
                status: 'running',
                checkpointJson: createInteractiveCheckpointJson({
                  version: 1,
                  history,
                  historySummary,
                  sessionMemory: sessionMemoryState
                })
              });

              return {
                stopReason: 'completed' as const,
                finalAnswer: inspection.renderedText,
                history,
                toolRoundsUsed: 0,
                verification: {
                  isVerified: true,
                  finalAnswerIsNonEmpty: inspection.renderedText.length > 0,
                  finalAnswerIsSubstantive: inspection.renderedText.length > 0,
                  toolEvidenceSatisfied: true,
                  noUnresolvedToolErrors: true,
                  toolMessagesCount: 0,
                  checks: []
                }
              };
            }

            let preparedMemory:
              | Awaited<ReturnType<typeof prepareInteractiveSessionMemory>>
              | undefined;
            const historyContext = buildPromptHistoryContext(history, historySummary);

            try {
              preparedMemory = await prepareSessionMemory({
                cwd: runtime.cwd,
                sessionId: sessionMemoryState?.storeSessionId ?? sessionId,
                userInput,
                historySummary: historyContext.historySummary,
                checkpointState: sessionMemoryState,
                debugRecallInputs,
                memoryConfig
              });
            } catch (error) {
              preparedMemory = undefined;
              recordInteractiveMemoryFallback(cliObserver.observer, {
                sessionId,
                message: formatCliError(error),
                kind: 'prepare'
              });
            }

            const result = await executeTurn({
              provider: runtime.provider,
              availableTools: runtime.availableTools,
              baseSystemPrompt: runtime.systemPrompt,
              userInput,
              cwd: runtime.cwd,
              maxToolRounds: runtime.maxToolRounds,
              resolvedPackage: runtime.resolvedPackage,
              observer: cliObserver.observer,
              history: historyContext.history,
              historySummary: historyContext.historySummary,
              memoryText: preparedMemory?.memoryText ?? '',
              sessionId
            });
            const settledResultPromise = (result.finalResult
              ? result.finalResult
              : Promise.resolve(result))
              .then(async (settledResult) => {
                if (settledResult.stopReason === 'completed' || settledResult.stopReason === 'max_tool_rounds_reached') {
                  const newTurnMessages = settledResult.history.slice(historyContext.history.length);
                  history = [...history, ...newTurnMessages];
                  historySummary = readTurnHistorySummary(settledResult) ?? historyContext.historySummary;

                  const memoryCandidates = settledResult.memoryCandidates ?? [];
                  const structuredOutputParsed = settledResult.structuredOutputParsed === true;

                if (debugMemoryCandidates) {
                  debugMemoryCandidates({
                    type: 'memory_candidates',
                    timestamp: new Date().toISOString(),
                    sessionId: sessionMemoryState?.storeSessionId ?? sessionId,
                    parsed: structuredOutputParsed,
                    count: memoryCandidates.length,
                    candidates: memoryCandidates,
                    parseFallbackUsed: !structuredOutputParsed
                  });
                }

                if (preparedMemory) {
                    try {
                      const captureResult = await captureTurnMemory({
                        store: preparedMemory.store,
                        sessionId: sessionMemoryState?.storeSessionId ?? sessionId,
                        userInput,
                        finalAnswer: settledResult.finalAnswer,
                        history,
                        memoryCandidates,
                        memoryConfig
                      });

                      sessionMemoryState = captureResult.saved
                        ? captureResult.checkpointState
                        : preparedMemory.checkpointState;
                    } catch (error) {
                      sessionMemoryState = preparedMemory.checkpointState;
                      recordInteractiveMemoryFallback(cliObserver.observer, {
                        sessionId,
                        message: formatCliError(error),
                        kind: 'capture'
                      });
                    }
                  }

                  checkpointStore.save({
                    sessionId,
                    taskId: 'interactive',
                    status: settledResult.stopReason === 'completed' ? 'completed' : 'running',
                    checkpointJson: createInteractiveCheckpointJson({
                      version: 1,
                      history,
                      historySummary,
                      sessionMemory: sessionMemoryState
                    })
                  });
                }

                return settledResult;
              });

            return {
              ...result,
              finalResult: settledResultPromise
            };
          },
          writeLine(text) {
            stdout.write(`${text}\n`);
          },
          renderFinalAnswer(text) {
            if (!assistantBlockWriter?.hasStreamedAssistantText() && text.length > 0) {
              assistantBlockWriter?.writeAssistantTextBlock(text);
            }
          },
          afterTurnRendered() {
            cliObserver.flushPendingFooter();
            assistantBlockWriter?.resetTurn();
          }
        });

        try {
          return await repl.runInteractive();
        } catch (error) {
          if (error instanceof Error && 'replTurnErrorRendered' in error && error.replTurnErrorRendered === true) {
            assistantBlockWriter?.resetTurn();
            return 1;
          }
          throw error;
        }
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

function buildPromptHistoryContext(history: Message[], historySummary?: string): {
  history: Message[];
  historySummary?: string;
} {
  const pruned = pruneHistoryForContext(history, {
    recentMessageCount: 8,
    oldHistoryBudgetChars: 1_200,
    summaryMaxLines: 8,
    summaryMaxChars: 800,
    summarySnippetLength: 140
  });
  const combinedSummary = [historySummary, pruned.summary].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n\n');

  return {
    history: pruned.messages,
    historySummary: combinedSummary || undefined
  };
}

function recordInteractiveMemoryFallback(
  observer: TelemetryObserver,
  options: {
    sessionId: string;
    message: string;
    kind: 'prepare' | 'capture';
  }
): void {
  observer.record(createTelemetryEvent('interactive_memory_fallback', 'input_received', {
    sessionId: options.sessionId,
    phase: options.kind,
    message: options.message
  }));
}

function handleCliTurnEvent(
  event: TurnEvent,
  assistantBlockWriter: AssistantBlockWriter | undefined,
  mode: CliDisplayMode,
  options: {
    allowTurnEventToolActivityFallback?: boolean;
  } = {}
): void {
  if (event.type === 'assistant_text_delta') {
    assistantBlockWriter?.writeAssistantTextDelta(event.text);
    return;
  }

  if (event.type === 'assistant_message_completed') {
    assistantBlockWriter?.finishAssistantTextBlock();
    return;
  }

  if (event.type === 'tool_call_started') {
    if (!options.allowTurnEventToolActivityFallback) {
      return;
    }

    const activityLine = formatTurnEventToolActivityLine(event, mode);
    if (activityLine) {
      assistantBlockWriter?.writeAssistantLine(activityLine, event.id);
    }
    return;
  }

  if (event.type === 'tool_call_completed') {
    if (!options.allowTurnEventToolActivityFallback) {
      return;
    }

    if (mode === 'interactive') {
      assistantBlockWriter?.writeAssistantLineBelow(event.id, formatTurnEventToolCompletionLine(event));
    } else {
      assistantBlockWriter?.replaceAssistantLine(event.id, formatTurnEventToolCompletionLine(event));
    }

    const previewLine = formatTurnEventToolPreviewLine(event.resultPreview, mode);
    if (previewLine) {
      assistantBlockWriter?.writeAssistantLineBelow(event.id, previewLine);
    }
    return;
  }

  if (event.type === 'turn_failed') {
    assistantBlockWriter?.writeFooterLine(`${pc.dim('─'.repeat(54))}\n${pc.red('✖')} ${pc.red(pc.bold(`FAIL: ${formatCliError(event.error)}`))}`);
  }
}

function formatTurnEventToolActivityLine(
  event: Extract<TurnEvent, { type: 'tool_call_started' }>,
  mode: CliDisplayMode
): string | undefined {
  const label = formatTurnEventToolLabel(event.name, event.input);

  if (!label) {
    return undefined;
  }

  return mode === 'interactive' ? ` ${pc.cyan('✦')} ${label}` : `· ${label}`;
}

function formatTurnEventToolCompletionLine(
  event: Extract<TurnEvent, { type: 'tool_call_completed' }>
): string {
  const status = event.isError
    ? `${pc.red('✖')} ${pc.red('Fail')}`
    : `${pc.green('✔')} ${pc.green('Success')}`;

  return typeof event.durationMs === 'number'
    ? ` └─ ${status} (${event.durationMs}ms)`
    : ` └─ ${status}`;
}

function formatTurnEventToolPreviewLine(resultPreview: string, mode: CliDisplayMode): string | undefined {
  const preview = resultPreview.trim();

  if (preview.length === 0) {
    return undefined;
  }

  return mode === 'interactive' ? `  ${preview}` : `· ${preview}`;
}

function formatTurnEventToolLabel(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'shell') {
    return `shell ${formatTurnEventCommandLabel(input)}`;
  }

  if (toolName === 'file') {
    const action = typeof input.action === 'string' ? input.action.trim() : '';

    if (action === 'search') {
      return `file search ${formatTurnEventSearchLabel(input)}`;
    }

    if (action === 'list') {
      return `file list ${formatTurnEventPathLabel(input, '.')}`;
    }

    if (action === 'read' || action === 'write') {
      return `file ${action} ${formatTurnEventPathLabel(input, 'file')}`;
    }

    return action.length > 0 ? `file ${action}` : 'file';
  }

  if (toolName === 'read_file' || toolName === 'edit_file') {
    const action = toolName === 'read_file' ? 'read' : 'write';
    return `file ${action} ${formatTurnEventPathLabel(input, 'file')}`;
  }

  if (toolName === 'search') {
    return `file search ${formatTurnEventSearchLabel(input)}`;
  }

  return undefined;
}

function formatTurnEventCommandLabel(input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const args = Array.isArray(input.args)
    ? input.args.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
    : [];
  const label = [command, ...args].filter((part) => part.length > 0).join(' ').trim();

  return label.length > 0 ? label : 'command';
}

function formatTurnEventPathLabel(input: Record<string, unknown>, fallbackNoun: string): string {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  return path.length > 0 ? path : fallbackNoun;
}

function formatTurnEventSearchLabel(input: Record<string, unknown>): string {
  const query = typeof input.query === 'string' ? input.query.trim() : '';

  if (query.length > 0) {
    return query;
  }

  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
  return pattern.length > 0 ? pattern : 'pattern';
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
  let hasStreamedAssistantTextInTurn = false;
  let hasOpenedInteractiveStreamTextBlock = false;
  let isAssistantTextLineOpen = false;
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

  function writeAssistantTextPrefixIfNeeded(): void {
    if (mode !== 'compact') {
      return;
    }

    if (!isAssistantTextLineOpen) {
      write('  ');
      isAssistantTextLineOpen = true;
    }
  }

  function closeAssistantTextLineIfNeeded(): void {
    if (!isAssistantTextLineOpen) {
      return;
    }

    write('\n');
    isAssistantTextLineOpen = false;
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
    writeAssistantTextDelta(text: string) {
      if (text.length === 0) {
        return;
      }

      ensureTurnPrelude();
      ensureRespondingStatus();
      activeActivityLineCount = 0;
      if (mode === 'interactive') {
        resetActivityTracking();
      }
      hasStreamedAssistantTextInTurn = true;

      if (mode === 'interactive') {
        if (!hasOpenedInteractiveStreamTextBlock) {
          write(`${pc.dim('─'.repeat(54))}\n`);
          write('\n');
          hasOpenedInteractiveStreamTextBlock = true;
        }

        write(text);
        return;
      }

      writeAssistantTextPrefixIfNeeded();
      write(text);
    },
    finishAssistantTextBlock() {
      closeAssistantTextLineIfNeeded();

      if (mode === 'interactive' && hasStreamedAssistantTextInTurn && trailingNewlineCount === 0) {
        write('\n');
      }

      providerStatus = undefined;
    },
    hasStreamedAssistantText(): boolean {
      return hasStreamedAssistantTextInTurn;
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
        closeAssistantTextLineIfNeeded();
        for (const line of text.split('\n')) {
          write(`  ${line}\n`);
        }
      }

      providerStatus = undefined;
    },
    writeFooterLine(text: string) {
      ensureTurnPrelude();
      ensureRespondingStatus();
      closeAssistantTextLineIfNeeded();
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
      hasStreamedAssistantTextInTurn = false;
      hasOpenedInteractiveStreamTextBlock = false;
      isAssistantTextLineOpen = false;
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
  createRecallInputsDebugLogger(): ((record: RecallInputsDebugRecord) => void) | undefined;
  createMemoryCandidatesDebugLogger(): ((record: MemoryCandidatesDebugRecord) => void) | undefined;
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
  let recallInputsDebugWriter: JsonLineWriter | undefined;

  if (selectedDebugLogPath) {
    const resolvedDebugLogPath = resolveCliPath(options.cwd, selectedDebugLogPath);
    mkdirSync(dirname(resolvedDebugLogPath), { recursive: true });
    const debugWriter = createFileJsonLineWriter(resolvedDebugLogPath);
    recallInputsDebugWriter = debugWriter;
    observers.push(createJsonLineLogger(debugWriter));
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
    },
    createRecallInputsDebugLogger() {
      if (!recallInputsDebugWriter) {
        return undefined;
      }

      return (record: RecallInputsDebugRecord) => {
        recallInputsDebugWriter?.appendLine(`${JSON.stringify(record)}\n`);
      };
    },
    createMemoryCandidatesDebugLogger() {
      if (!recallInputsDebugWriter) {
        return undefined;
      }

      return (record: MemoryCandidatesDebugRecord) => {
        recallInputsDebugWriter?.appendLine(`${JSON.stringify(record)}\n`);
      };
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

function formatInteractiveStartupLines(options: InteractiveStartupLinesOptions): string[] {
  const startupLines = formatInteractiveChrome(options);

  if (!options.restored) {
    return startupLines;
  }

  const summaryAvailability = options.historySummary ? 'summary available' : 'summary unavailable';
  const previewMessages = getCheckpointPreviewMessages(options.history, 5);
  const previewLines = previewMessages.map((message) => formatCheckpointPreviewLine(message));

  return [
    ...startupLines,
    formatInteractiveInfoLine(`Resumed checkpoint • ${previewMessages.length} messages • ${summaryAvailability}`),
    ...previewLines
  ];
}

function getCheckpointPreviewMessages(history: Message[], limit: number): Message[] {
  return history
    .filter((message) => message.role === 'user' || (message.role === 'assistant' && !message.toolCalls?.length))
    .slice(-limit);
}

function formatCheckpointPreviewLine(message: Message): string {
  const content = message.content.trim();

  if (message.role === 'user') {
    return `${pc.cyan('»')} ${content}`;
  }

  if (message.role === 'assistant') {
    return `${pc.dim('─'.repeat(54))}\n${content}`;
  }

  if (message.role === 'tool') {
    return `${pc.dim(`tool(${message.name ?? 'unknown'})`)}: ${content}`;
  }

  return `${pc.dim(message.role)}: ${content}`;
}

function formatInteractiveInfoLine(text: string): string {
  return `${pc.cyan('ℹ')} ${pc.dim(text)}`;
}

async function formatAgentSpecPreview(agentSpecName: string, cwd: string): Promise<string> {
  const preview = createAgentPackagePreview(await resolveAgentPackagePreview(agentSpecName, cwd));
  const promptFileLines = preview.promptFiles
    .map((entry) => `- ${entry.fileName}: ${entry.filePath}`)
    .join('\n');
  const effectivePolicyText = JSON.stringify(preview.effectiveRuntimePolicy, null, 2);

  return [
    `Agent spec preview: ${preview.preset}`,
    `Source tier: ${preview.sourceTier}`,
    `Inheritance chain: ${preview.extendsChain.join(' -> ')}`,
    'Prompt files:',
    promptFileLines || '- (none)',
    'Effective runtime policy:',
    effectivePolicyText,
    'Rendered system prompt:',
    preview.renderedPromptText,
    ''
  ].join('\n');
}

async function resolveAgentPackagePreview(agentSpecName: string, cwd: string) {
  try {
    return await resolveAgentPackageForPreview(agentSpecName, { cwd });
  } catch (error) {
    if (error instanceof Error && error.message === `Agent package "${agentSpecName}" extends unknown package "${agentSpecName}".`) {
      throw new Error(`Unknown agent spec: ${agentSpecName}`);
    }

    throw error;
  }
}

async function resolveAgentPackageForCliExecution(agentSpecName: string, cwd: string) {
  try {
    return await resolveAgentPackageForPreview(agentSpecName, { cwd });
  } catch (error) {
    if (error instanceof Error && error.message === `Agent package "${agentSpecName}" extends unknown package "${agentSpecName}".`) {
      throw new Error(`Unknown agent spec: ${agentSpecName}`);
    }

    throw error;
  }
}

function shouldLaunchTui(stdout: Pick<NodeJS.WriteStream, 'write'> & { isTTY?: boolean }): boolean {
  return Boolean(stdout.isTTY) && process.env.QICLAW_TUI_ENABLED === 'true';
}

function parseArgs(argv: string[]): {
  prompt?: string;
  provider: ProviderId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  debugLogPath?: string;
  agentSpecName?: string;
  agentSpecPreviewName?: string;
} {
  let prompt: string | undefined;
  let provider = resolveDefaultProviderFromEnv();
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let debugLogPath: string | undefined;
  let agentSpecName: string | undefined;
  let agentSpecPreviewName: string | undefined;

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

    if (token === '--agent-spec-preview') {
      const value = argv[index + 1];

      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --agent-spec-preview');
      }

      agentSpecPreviewName = value;
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
    agentSpecName,
    agentSpecPreviewName
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
