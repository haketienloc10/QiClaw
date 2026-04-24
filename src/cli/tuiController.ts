import type { AgentRuntime } from '../agent/runtime.js';
import { pruneHistoryForContext } from '../context/historyPruner.js';
import type { RunAgentTurnResult, TurnEvent } from '../agent/loop.js';
import type { Message } from '../core/types.js';
import {
  captureInteractiveTurnMemory,
  inspectInteractiveRecall,
  prepareInteractiveSessionMemory,
  type CaptureInteractiveTurnMemoryResult,
  type PrepareInteractiveSessionMemoryResult,
  type SessionMemoryCheckpointState
} from '../memory/sessionMemoryEngine.js';
import { resolveMemoryEmbeddingConfig } from '../memory/memoryEmbeddingConfig.js';
import {
  captureInteractiveBlueprintOutcome,
  prepareInteractiveBlueprintContext
} from '../blueprint/engine.js';
import type { CheckpointStore } from '../session/checkpointStore.js';
import {
  createInteractiveCheckpointJson,
  createSessionId,
  parseInteractiveCheckpointJson
} from '../session/session.js';
import { createRunAgentTurnExecution, type RunAgentTurnInput } from '../agent/loop.js';
import { buildSlashCommandCatalog, normalizeSlashCommandInput, resolveSlashCommand } from './slashCommands.js';
import { runDirectCommand, type DirectCommandRequest } from './directCommands.js';
import { mapTurnEventToBridgeEvent, createTranscriptSeed } from './tuiTranscriptMapper.js';
import { serializeBridgeMessage, type FrontendAction, type HostEvent, type TranscriptCell } from './tuiProtocol.js';

export interface TuiControllerOptions {
  cwd: string;
  runtime: Pick<AgentRuntime, 'provider' | 'availableTools' | 'systemPrompt' | 'cwd' | 'maxToolRounds' | 'resolvedPackage' | 'observer'>;
  checkpointStore: Pick<CheckpointStore, 'getLatest' | 'save'>;
  executeTurn?: (input: RunAgentTurnInput & { sessionId?: string }) => Promise<RunAgentTurnResult & {
    historySummary?: string;
    turnStream?: AsyncIterable<TurnEvent>;
    finalResult?: Promise<RunAgentTurnResult & { historySummary?: string }>;
  }>;
  prepareSessionMemory?: typeof prepareInteractiveSessionMemory;
  captureTurnMemory?: typeof captureInteractiveTurnMemory;
  prepareBlueprint?: typeof prepareInteractiveBlueprintContext;
  captureBlueprint?: typeof captureInteractiveBlueprintOutcome;
  createSessionId?: () => string;
  runDirectCommand?: (request: DirectCommandRequest) => Promise<{ transcriptCells: Array<{ id: string; kind: 'user' | 'assistant' | 'tool' | 'status' | 'diff' | 'shell' | 'summary'; text: string; title?: string; toolName?: string; isError?: boolean }>; footer?: string }>;
  updateModel?: (argsText: string) => { provider: string; model: string };
  emit(message: string): void;
}

export interface TuiController {
  start(): Promise<void>;
  handleAction(action: FrontendAction): Promise<boolean>;
}

interface TurnSummaryMetrics {
  providerCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

function summarizeStopReason(stopReason: string): string {
  if (stopReason === 'completed') {
    return 'completed';
  }
  if (stopReason === 'max_tool_rounds_reached') {
    return 'max tools';
  }
  return 'stopped';
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTurnDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }

  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

function formatCompactMetric(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  if (rounded < 1000) {
    return `${rounded}`;
  }

  if (rounded >= 10_000) {
    return `${Math.round(rounded / 1000)}k`;
  }

  const compact = Math.round((rounded / 1000) * 10) / 10;
  if (Number.isInteger(compact)) {
    return `${compact}k`;
  }

  return `${compact.toFixed(1)}k`;
}

function formatFooterSummary(args: {
  stopReason: string;
  isVerified: boolean;
  providerCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}): string {
  const parts = [
    summarizeStopReason(args.stopReason),
    ...(args.isVerified ? ['verified'] : []),
    pluralize(args.providerCalls, 'provider', 'providers'),
    pluralize(args.toolCalls, 'tool', 'tools'),
    `${formatCompactMetric(args.inputTokens)} in`,
    `${formatCompactMetric(args.outputTokens)} out`,
    formatTurnDuration(args.durationMs)
  ];

  return parts.join(' • ');
}

export function createTuiController(options: TuiControllerOptions): TuiController {
  const emit = (event: HostEvent) => {
    if (event.type === 'status' || event.type === 'warning' || event.type === 'error') {
      persistLocalTranscriptEvent(event);
    }

    options.emit(serializeBridgeMessage(event));
  };

  const executeTurn = options.executeTurn ?? ((input) => {
    const execution = createRunAgentTurnExecution(input);
    return Promise.resolve({
      stopReason: 'completed' as const,
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
      finalResult: execution.turnResult as Promise<RunAgentTurnResult & { historySummary?: string }>
    });
  });
  const prepareSessionMemory = options.prepareSessionMemory ?? prepareInteractiveSessionMemory;
  const captureTurnMemory = options.captureTurnMemory ?? captureInteractiveTurnMemory;
  const prepareBlueprint = options.prepareBlueprint ?? prepareInteractiveBlueprintContext;
  const captureBlueprint = options.captureBlueprint ?? captureInteractiveBlueprintOutcome;
  const createSession = options.createSessionId ?? createSessionId;
  const directCommandRunner = options.runDirectCommand ?? ((request) => runDirectCommand(request, options.cwd));
  const memoryConfig = resolveMemoryEmbeddingConfig(process.env);

  let sessionId = createSession();
  let history: Message[] = [];
  let historySummary: string | undefined;
  let sessionMemoryState: SessionMemoryCheckpointState | undefined;
  let turnOrdinal = 0;
  let assistantMessageOrdinal = 0;
  let transcriptCellOrdinal = 0;
  let transcriptCells: TranscriptCell[] = [];

  interface LiveTurnTranscriptState {
    assistantCellId?: string;
    startedToolCellIds: Map<string, string>;
  }

  function buildPromptHistoryContext(currentHistory: Message[], currentHistorySummary?: string): {
    history: Message[];
    historySummary?: string;
  } {
    const pruned = pruneHistoryForContext(currentHistory, {
      recentMessageCount: 8,
      oldHistoryBudgetChars: 1_200,
      summaryMaxLines: 8,
      summaryMaxChars: 800,
      summarySnippetLength: 140
    });
    const combinedSummary = [currentHistorySummary, pruned.summary]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n');

    return {
      history: pruned.messages,
      historySummary: combinedSummary || undefined
    };
  }

  async function saveCheckpoint(status: 'running' | 'completed') {
    options.checkpointStore.save({
      sessionId,
      taskId: 'interactive',
      status,
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history,
        historySummary,
        sessionMemory: sessionMemoryState,
        transcriptCells
      })
    });
  }

  function appendTranscriptCells(cells: TranscriptCell[]): void {
    transcriptCells = [...transcriptCells, ...cells];
    emit({ type: 'transcript_append', cells });
  }

  function appendTranscriptUserCell(text: string): void {
    transcriptCellOrdinal += 1;
    appendTranscriptCells([{ id: `user-live-${transcriptCellOrdinal}`, kind: 'user', text }]);
  }

  function appendTranscriptCell(cell: TranscriptCell): void {
    appendTranscriptCells([cell]);
  }

  function updateTranscriptCell(cellId: string, update: Partial<Omit<TranscriptCell, 'id'>>): void {
    transcriptCells = transcriptCells.map((cell) => (cell.id === cellId ? { ...cell, ...update } : cell));
  }

  function createLiveTurnTranscriptState(): LiveTurnTranscriptState {
    return {
      startedToolCellIds: new Map<string, string>()
    };
  }

  function pruneStalePartialAssistantCells(cells: TranscriptCell[], currentHistory: Message[]): TranscriptCell[] {
    const assistantCountFromHistory = currentHistory.filter((message) => message.role === 'assistant').length;
    const assistantCellIndexes = cells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => cell.kind === 'assistant');

    if (assistantCellIndexes.length <= assistantCountFromHistory) {
      return cells;
    }

    const trailingAssistant = assistantCellIndexes.at(-1);
    if (!trailingAssistant || trailingAssistant.index !== cells.length - 1) {
      return cells;
    }

    return cells.filter((_, index) => index !== trailingAssistant.index);
  }

  function pruneTransientAssistantCells(cells: TranscriptCell[]): TranscriptCell[] {
    const lastUserIndex = cells.map((cell) => cell.kind).lastIndexOf('user');
    if (lastUserIndex < 0) {
      return cells;
    }

    const assistantIndexesAfterLastUser = cells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell, index }) => index > lastUserIndex && cell.kind === 'assistant');

    if (assistantIndexesAfterLastUser.length <= 1) {
      return cells;
    }

    const keepIndex = assistantIndexesAfterLastUser.at(-1)?.index;
    return cells.filter((cell, index) => {
      if (cell.kind !== 'assistant' || index <= lastUserIndex) {
        return true;
      }
      return index === keepIndex;
    });
  }

  function persistProviderTranscriptEvent(
    event: HostEvent,
    state: LiveTurnTranscriptState
  ): void {
    const recoverTrailingAssistantCellId = (): string | undefined => {
      const trailing = transcriptCells.at(-1);
      return trailing?.kind === 'assistant' ? trailing.id : undefined;
    };

    if (event.type === 'assistant_delta') {
      if (!state.assistantCellId) {
        state.assistantCellId = recoverTrailingAssistantCellId();
      }

      if (!state.assistantCellId) {
        transcriptCellOrdinal += 1;
        state.assistantCellId = `assistant-live-${transcriptCellOrdinal}`;
        transcriptCells = [
          ...transcriptCells,
          { id: state.assistantCellId, kind: 'assistant', text: event.text }
        ];
        return;
      }

      const current = transcriptCells.find((cell) => cell.id === state.assistantCellId);
      updateTranscriptCell(state.assistantCellId, { text: `${current?.text ?? ''}${event.text}` });
      return;
    }

    if (event.type === 'assistant_completed') {
      if (!state.assistantCellId) {
        state.assistantCellId = recoverTrailingAssistantCellId();
      }

      if (!state.assistantCellId) {
        transcriptCellOrdinal += 1;
        state.assistantCellId = `assistant-live-${transcriptCellOrdinal}`;
        appendTranscriptCell({ id: state.assistantCellId, kind: 'assistant', text: event.text });
        return;
      }

      updateTranscriptCell(state.assistantCellId, { text: event.text });
      return;
    }

    if (event.type === 'tool_started') {
      state.assistantCellId = undefined;
      transcriptCellOrdinal += 1;
      const toolCellId = `tool-live-${transcriptCellOrdinal}`;
      state.startedToolCellIds.set(event.toolCallId, toolCellId);
      appendTranscriptCell({
        id: toolCellId,
        kind: 'tool',
        text: 'collecting output…',
        title: event.label,
        toolName: event.toolName,
        streaming: true,
        turnId: event.turnId,
        toolCallId: event.toolCallId
      });
      return;
    }

    if (event.type === 'tool_completed') {
      const existingToolCellId = state.startedToolCellIds.get(event.toolCallId);
      if (existingToolCellId) {
        updateTranscriptCell(existingToolCellId, {
          text: event.resultPreview,
          isError: event.status === 'error',
          streaming: false,
          durationMs: event.durationMs
        });
        return;
      }

      transcriptCellOrdinal += 1;
      appendTranscriptCell({
        id: `tool-live-${transcriptCellOrdinal}`,
        kind: 'tool',
        text: event.resultPreview,
        title: event.toolName,
        toolName: event.toolName,
        isError: event.status === 'error',
        streaming: false,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        durationMs: event.durationMs
      });
      return;
    }

    if (event.type === 'turn_completed') {
      return;
    }
  }

  function persistLocalTranscriptEvent(event: Extract<HostEvent, { type: 'status' | 'warning' | 'error' }>): void {
    transcriptCellOrdinal += 1;
    transcriptCells = [
      ...transcriptCells,
      {
        id: `${event.type}-live-${transcriptCellOrdinal}`,
        kind: 'status',
        text: event.text,
        title: event.type === 'status' ? 'Status' : event.type === 'warning' ? 'Warning' : 'Error',
        isError: event.type === 'status' ? undefined : true
      }
    ];
  }

  async function runPrompt(prompt: string): Promise<void> {
    turnOrdinal += 1;
    assistantMessageOrdinal += 1;
    const liveTranscriptState = createLiveTurnTranscriptState();
    const turnStartedAt = Date.now();
    const turnSummaryMetrics: TurnSummaryMetrics = {
      providerCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0
    };
    const countingObserver = {
      record(event: Parameters<NonNullable<typeof options.runtime.observer>['record']>[0]) {
        if (event.type === 'provider_called') {
          turnSummaryMetrics.providerCalls += 1;
        }
        if (event.type === 'provider_responded') {
          turnSummaryMetrics.inputTokens += event.data.usage?.inputTokens ?? 0;
          turnSummaryMetrics.outputTokens += event.data.usage?.outputTokens ?? 0;
        }
        options.runtime.observer?.record(event);
      }
    };
    let preparedMemory: PrepareInteractiveSessionMemoryResult | undefined;
    let preparedBlueprint: Awaited<ReturnType<typeof prepareInteractiveBlueprintContext>> | undefined;

    try {
      preparedMemory = await prepareSessionMemory({
        cwd: options.cwd,
        sessionId: sessionMemoryState?.storeSessionId ?? sessionId,
        userInput: prompt,
        historySummary,
        checkpointState: sessionMemoryState,
        memoryConfig
      });
    } catch (error) {
      emit({ type: 'warning', text: error instanceof Error ? error.message : String(error) });
    }

    const historyContext = buildPromptHistoryContext(history, historySummary);

    try {
      preparedBlueprint = await prepareBlueprint({
        userInput: prompt,
        historySummary: historyContext.historySummary
      });
    } catch {
      preparedBlueprint = undefined;
    }

    try {
      const result = await executeTurn({
        provider: options.runtime.provider,
        availableTools: options.runtime.availableTools,
        baseSystemPrompt: options.runtime.systemPrompt,
        userInput: prompt,
        cwd: options.runtime.cwd,
        maxToolRounds: options.runtime.maxToolRounds,
        resolvedPackage: options.runtime.resolvedPackage,
        observer: countingObserver,
        history: historyContext.history,
        historySummary: historyContext.historySummary,
        memoryText: preparedMemory?.memoryText ?? '',
        blueprintText: preparedBlueprint?.blueprintText ?? '',
        sessionId
      });
      const resultWithSummary = result as RunAgentTurnResult & {
        historySummary?: string;
        turnStream?: AsyncIterable<TurnEvent>;
        finalResult?: Promise<RunAgentTurnResult & { historySummary?: string }>;
      };
      const finalResultPromise = resultWithSummary.finalResult;
      finalResultPromise?.catch(() => undefined);

      if (resultWithSummary.turnStream) {
        for await (const event of resultWithSummary.turnStream) {
          if (event.type === 'tool_call_completed') {
            turnSummaryMetrics.toolCalls += 1;
          }

          const mapped = mapTurnEventToBridgeEvent(event, {
            turnOrdinal,
            assistantMessageOrdinal
          });

          if (mapped) {
            persistProviderTranscriptEvent(mapped, liveTranscriptState);
            emit(mapped);
            await saveCheckpoint('running');
            if (mapped.type === 'assistant_completed') {
              assistantMessageOrdinal += 1;
            }
          }
        }
      }

      const settled = finalResultPromise ? await finalResultPromise : resultWithSummary;
      turnSummaryMetrics.durationMs = Date.now() - turnStartedAt;

      if (settled.stopReason === 'completed' || settled.stopReason === 'max_tool_rounds_reached') {
        const newTurnMessages = settled.history.slice(historyContext.history.length);
        history = [...history, ...newTurnMessages];
        historySummary = settled.historySummary ?? historyContext.historySummary;
      }

      if (preparedMemory) {
        try {
          const captureResult: CaptureInteractiveTurnMemoryResult = await captureTurnMemory({
            store: preparedMemory.store,
            sessionId: sessionMemoryState?.storeSessionId ?? sessionId,
            userInput: prompt,
            finalAnswer: settled.finalAnswer,
            history,
            memoryCandidates: settled.memoryCandidates,
            memoryConfig
          });

          sessionMemoryState = captureResult.checkpointState;
        } catch (error) {
          emit({ type: 'warning', text: error instanceof Error ? error.message : String(error) });
        }
      }

      try {
        await captureBlueprint({
          matchedBlueprint: preparedBlueprint?.matchedBlueprint,
          result: settled
        });
      } catch {
        // best effort only
      }

      emit({
        type: 'footer_summary',
        text: formatFooterSummary({
          stopReason: settled.stopReason,
          isVerified: settled.verification.isVerified,
          providerCalls: turnSummaryMetrics.providerCalls,
          toolCalls: turnSummaryMetrics.toolCalls,
          inputTokens: turnSummaryMetrics.inputTokens,
          outputTokens: turnSummaryMetrics.outputTokens,
          durationMs: turnSummaryMetrics.durationMs
        })
      });

      await saveCheckpoint(settled.stopReason === 'completed' ? 'completed' : 'running');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorEvent: HostEvent = { type: 'error', text: message };
      persistProviderTranscriptEvent(errorEvent, liveTranscriptState);
      emit(errorEvent);
      await saveCheckpoint('running');
      throw error;
    }
  }

  function formatProviderModel(): string {
    return `${options.runtime.provider.name}:${options.runtime.provider.model}`;
  }

  function formatSessionStatus(): string {
    return `Session ${sessionId} • ${history.length} messages • model ${formatProviderModel()}`;
  }

  function isSessionClean(): boolean {
    return history.length === 0 && !historySummary && !sessionMemoryState;
  }

  async function runSlashCommand(commandText: string): Promise<void> {
    const normalized = normalizeSlashCommandInput(commandText);
    if (!normalized) {
      emit({ type: 'warning', text: `Unknown slash input: ${commandText}` });
      return;
    }

    const command = resolveSlashCommand(normalized.name);
    if (!command) {
      emit({ type: 'warning', text: `Unknown command: ${normalized.name}` });
      return;
    }

    if (command.name === '/clear') {
      history = [];
      historySummary = undefined;
      sessionMemoryState = undefined;
      transcriptCellOrdinal = 0;
      transcriptCells = [];
      emit({ type: 'transcript_seed', cells: [] });
      emit({ type: 'status', text: 'Session cleared.' });
      await saveCheckpoint('running');
      return;
    }

    appendTranscriptUserCell(commandText);

    if (command.kind === 'prompt' && command.promptTemplate) {
      await runPrompt(command.promptTemplate(normalized.argsText));
      return;
    }

    if (command.name === '/help') {
      emit({ type: 'slash_catalog', commands: buildSlashCommandCatalog() });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/status') {
      emit({ type: 'status', text: formatSessionStatus() });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/tools') {
      emit({
        type: 'status',
        text: options.runtime.availableTools.length > 0
          ? `Tools: ${options.runtime.availableTools.map((tool) => tool.name).join(', ')}`
          : 'Tools: none'
      });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/memory') {
      emit({
        type: 'status',
        text: sessionMemoryState
          ? `Memory entries: ${sessionMemoryState.totalEntries}`
          : 'Memory unavailable for this session yet.'
      });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/recal') {
      if (normalized.argsText.length === 0) {
        emit({ type: 'warning', text: 'Usage: /recal <input>' });
        await saveCheckpoint('running');
        return;
      }

      const inspection = await inspectInteractiveRecall({
        cwd: options.cwd,
        sessionId,
        userInput: normalized.argsText,
        historySummary,
        checkpointState: sessionMemoryState,
        memoryConfig,
        now: new Date().toISOString()
      });

      transcriptCellOrdinal += 1;
      appendTranscriptCell({
        id: `memory-recall-${transcriptCellOrdinal}`,
        kind: 'status',
        title: 'Memory recall',
        text: inspection.renderedText
      });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/doctor') {
      emit({ type: 'status', text: `cwd=${options.cwd} provider=${options.runtime.provider.name} model=${options.runtime.provider.model}` });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/compact') {
      emit({ type: 'status', text: historySummary ?? 'No compact summary available yet.' });
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/model') {
      if (normalized.argsText.length === 0) {
        emit({ type: 'status', text: `Current model: ${formatProviderModel()}` });
        await saveCheckpoint('running');
        return;
      }

      if (!options.updateModel) {
        emit({ type: 'warning', text: 'Model switching is unavailable in this TUI session.' });
        await saveCheckpoint('running');
        return;
      }

      if (!isSessionClean()) {
        emit({
          type: 'warning',
          text: `Cannot change model after the session has real history. Use /clear first, then run /model ${normalized.argsText}.`
        });
        await saveCheckpoint('running');
        return;
      }

      try {
        const updated = options.updateModel(normalized.argsText);
        options.runtime.provider.name = updated.provider;
        options.runtime.provider.model = updated.model;
        emit({ type: 'status', text: `Model updated to ${updated.provider}:${updated.model}` });
      } catch (error) {
        emit({ type: 'warning', text: error instanceof Error ? error.message : String(error) });
      }
      await saveCheckpoint('running');
      return;
    }

    if (command.name === '/diff') {
      const result = await directCommandRunner({ type: 'diff' });
      appendTranscriptCells(result.transcriptCells);
      if (result.footer) {
        emit({ type: 'status', text: result.footer });
      }
      await saveCheckpoint('running');
      return;
    }
  }

  return {
    async start() {
      const latest = options.checkpointStore.getLatest();
      const restored = latest ? parseInteractiveCheckpointJson(latest.checkpointJson) : undefined;

      if (restored) {
        sessionId = latest?.sessionId ?? sessionId;
        history = restored.history;
        historySummary = restored.historySummary;
        sessionMemoryState = restored.sessionMemory;
      }

      transcriptCells = pruneTransientAssistantCells(
        pruneStalePartialAssistantCells(
          restored?.transcriptCells ?? createTranscriptSeed(history, historySummary),
          history
        )
      );
      transcriptCellOrdinal = transcriptCells.length;
      turnOrdinal = history.filter((message) => message.role === 'user').length;
      assistantMessageOrdinal = Math.max(
        history.filter((message) => message.role === 'assistant').length,
        transcriptCells.filter((cell) => cell.kind === 'assistant').length
      );

      emit({
        type: 'hello',
        protocolVersion: 1,
        sessionId,
        model: options.runtime.provider.model,
        cwd: options.cwd
      });
      emit({
        type: 'session_loaded',
        restored: Boolean(restored),
        sessionId,
        historySummary
      });
      emit({ type: 'transcript_seed', cells: transcriptCells });
      emit({ type: 'slash_catalog', commands: buildSlashCommandCatalog() });
    },
    async handleAction(action: FrontendAction): Promise<boolean> {
      if (action.type === 'quit') {
        return false;
      }

      if (action.type === 'request_status') {
        emit({ type: 'status', text: formatSessionStatus() });
        await saveCheckpoint('running');
        return true;
      }

      if (action.type === 'clear_session') {
        await runSlashCommand('/clear');
        return true;
      }

      if (action.type === 'submit_prompt') {
        appendTranscriptUserCell(action.prompt);
        await runPrompt(action.prompt);
        return true;
      }

      if (action.type === 'run_slash_command') {
        await runSlashCommand([action.command, action.argsText].filter(Boolean).join(' ').trim());
        return true;
      }

      if (action.type === 'run_shell_command') {
        appendTranscriptUserCell(`!${[action.command, ...(action.args ?? [])].join(' ')}`);
        const result = await directCommandRunner({
          type: 'shell',
          command: action.command,
          args: action.args ?? []
        });
        appendTranscriptCells(result.transcriptCells);
        if (result.footer) {
          emit({ type: 'status', text: result.footer });
        }
        await saveCheckpoint('running');
        return true;
      }

      return true;
    }
  };
}
