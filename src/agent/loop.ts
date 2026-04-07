import type { Message } from '../core/types.js';
import { buildPromptWithContext } from '../context/promptBuilder.js';
import type { NormalizedEvent, ProviderResponse, ProviderUsageSummary } from '../provider/model.js';
import {
  collectProviderStream,
  toToolErrorMessage,
  toToolResultMessage,
  type ModelProvider,
  type ToolCallRequest,
  type ToolResultMessage
} from '../provider/model.js';
import { validateToolInput } from '../tools/validation.js';
import {
  createNoopObserver,
  createTelemetryEvent,
  type TelemetryEventContextData,
  type TelemetryObserver
} from '../telemetry/observer.js';
import { buildTelemetryPreview } from '../telemetry/preview.js';
import { redactSensitiveTelemetryValue } from '../telemetry/redaction.js';
import { measurePromptTelemetry } from '../telemetry/providerMetrics.js';
import type { Tool } from '../tools/registry.js';

import { buildDoneCriteria, type DoneCriteria } from './doneCriteria.js';
import type { AgentSpec } from './spec.js';
import { verifyAgentTurn, type AgentTurnVerification } from './verifier.js';

export interface RunAgentTurnInput {
  provider: ModelProvider;
  availableTools: Tool[];
  baseSystemPrompt: string;
  userInput: string;
  cwd: string;
  maxToolRounds: number;
  agentSpec?: AgentSpec;
  observer?: TelemetryObserver;
  memoryText?: string;
  skillsText?: string;
  historySummary?: string;
  history?: Message[];
}

export type AgentTurnStopReason = 'completed' | 'max_tool_rounds_reached';

export interface RunAgentTurnResult {
  stopReason: AgentTurnStopReason;
  finalAnswer: string;
  history: Message[];
  toolRoundsUsed: number;
  doneCriteria: DoneCriteria;
  verification: AgentTurnVerification;
}

export interface RunAgentTurnExecution {
  turnStream: AsyncIterable<TurnEvent>;
  turnResult: Promise<RunAgentTurnResult>;
}

export type TurnEvent =
  | { type: 'turn_started' }
  | { type: 'provider_started'; provider: string; model: string }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'tool_call_started'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_completed'; id: string; name: string; resultPreview: string; isError: boolean }
  | { type: 'assistant_message_completed'; text: string; toolCalls?: ToolCallRequest[] }
  | {
      type: 'turn_completed';
      finalAnswer: string;
      stopReason: AgentTurnStopReason;
      history: Message[];
      toolRoundsUsed: number;
      doneCriteria: DoneCriteria;
      turnCompleted: boolean;
    }
  | { type: 'turn_failed'; error: unknown };

interface CollectedTurnState {
  stopReason: AgentTurnStopReason;
  finalAnswer: string;
  history: Message[];
  toolRoundsUsed: number;
  doneCriteria: DoneCriteria;
  turnCompleted: boolean;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_TOOL_RESULT_CONTENT_CHARS = 12_000;

interface TurnTelemetryState {
  turnId: string;
  providerRound: number;
  toolRound: number;
  turnStartedAt: number;
  toolCallsTotal: number;
  toolCallsByName: Record<string, number>;
  inputTokensTotal: number;
  outputTokensTotal: number;
  cacheReadInputTokens: number;
  hasToolErrors: boolean;
  lastPromptRawChars: number;
  lastToolResultChars: number;
  promptCharsMax: number;
  toolResultPromptGrowthCharsTotal: number;
  toolResultCharsAddedAcrossTurn: number;
  finalToolResultChars: number;
  finalAssistantToolCallChars: number;
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const execution = createRunAgentTurnExecution(input);
  const drainTurnStream = (async () => {
    for await (const _event of execution.turnStream) {
      // Drain the stream so turnResult resolves for non-streaming callers.
    }
  })();

  try {
    return await execution.turnResult;
  } finally {
    await drainTurnStream.catch(() => undefined);
  }
}

export function createRunAgentTurnExecution(input: RunAgentTurnInput): RunAgentTurnExecution {
  const observer = input.observer ?? createNoopObserver();
  const telemetry = createTurnTelemetryState();

  observer.record(
    createTelemetryEvent('user_input_received', 'input_received', {
      ...buildTurnContext(telemetry),
      userInput: input.userInput,
      userInputChars: input.userInput.length
    })
  );

  observer.record(
    createTelemetryEvent('turn_started', 'input_received', {
      ...buildTurnContext(telemetry),
      cwd: input.cwd,
      userInput: input.userInput,
      maxToolRounds: input.maxToolRounds,
      toolNames: input.availableTools.map((tool) => tool.name)
    })
  );

  const sourceStream = runAgentTurnStream(input, { telemetry, observer });
  let resolveTurnResult: ((result: RunAgentTurnResult) => void) | undefined;
  let rejectTurnResult: ((error: unknown) => void) | undefined;
  const turnResult = new Promise<RunAgentTurnResult>((resolve, reject) => {
    resolveTurnResult = resolve;
    rejectTurnResult = reject;
  });

  const turnStream = (async function* () {
    let terminal: CollectedTurnState | undefined;

    try {
      for await (const event of sourceStream) {
        if (event.type === 'turn_completed') {
          if (terminal) {
            throw new Error('Turn stream emitted multiple terminal success events.');
          }

          assertValidTurnCompletedEvent(event);
          terminal = {
            stopReason: event.stopReason,
            finalAnswer: event.finalAnswer,
            history: event.history,
            toolRoundsUsed: event.toolRoundsUsed,
            doneCriteria: event.doneCriteria,
            turnCompleted: event.turnCompleted
          };
        }

        yield event;
      }

      if (!terminal) {
        throw new Error('Turn stream ended without terminal event.');
      }

      resolveTurnResult?.(buildResult(observer, telemetry, terminal, input.maxToolRounds));
    } catch (error) {
      observer.record(
        createTelemetryEvent('turn_failed', 'completion_check', {
          ...buildTurnContext(telemetry),
          message: error instanceof Error ? error.message : String(error)
        })
      );
      rejectTurnResult?.(error);
      throw error;
    }
  })();

  return {
    turnStream,
    turnResult
  };
}

export async function collectCompletedTurn(stream: AsyncIterable<TurnEvent>): Promise<CollectedTurnState> {
  let terminal: CollectedTurnState | undefined;

  for await (const event of stream) {
    if (event.type === 'turn_completed') {
      if (terminal) {
        throw new Error('Turn stream emitted multiple terminal success events.');
      }

      assertValidTurnCompletedEvent(event);

      terminal = {
        stopReason: event.stopReason,
        finalAnswer: event.finalAnswer,
        history: event.history,
        toolRoundsUsed: event.toolRoundsUsed,
        doneCriteria: event.doneCriteria,
        turnCompleted: event.turnCompleted
      };
      continue;
    }

    if (terminal) {
      throw new Error(`Turn stream event received after terminal event: ${event.type}`);
    }

    if (event.type === 'turn_failed') {
      throw event.error instanceof Error ? event.error : new Error(String(event.error));
    }
  }

  if (!terminal) {
    throw new Error('Turn stream ended without terminal event.');
  }

  return terminal;
}

function assertValidTurnCompletedEvent(
  event: Extract<TurnEvent, { type: 'turn_completed' }>
): asserts event is Extract<TurnEvent, { type: 'turn_completed' }> {
  if (!Array.isArray(event.history)) {
    throw new Error('Invalid turn_completed payload: history must be an array.');
  }

  if (!Number.isInteger(event.toolRoundsUsed) || event.toolRoundsUsed < 0) {
    throw new Error('Invalid turn_completed payload: toolRoundsUsed must be a non-negative integer.');
  }
}

interface RunAgentTurnStreamState {
  telemetry: TurnTelemetryState;
  observer: TelemetryObserver;
}

export async function* runAgentTurnStream(
  input: RunAgentTurnInput,
  state?: RunAgentTurnStreamState
): AsyncIterable<TurnEvent> {
  const observer = state?.observer ?? input.observer ?? createNoopObserver();
  const history: Message[] = [...(input.history ?? []), { role: 'user', content: input.userInput }];
  const doneCriteria = buildDoneCriteria(input.userInput, input.agentSpec?.completion);
  const telemetry = state?.telemetry ?? createTurnTelemetryState();
  let finalAnswer = '';

  yield { type: 'turn_started' };

  try {
    while (true) {
      const prompt = buildPromptWithContext({
        baseSystemPrompt: input.baseSystemPrompt,
        memoryText: input.memoryText,
        skillsText: input.skillsText,
        historySummary: input.historySummary,
        history
      });

      telemetry.providerRound += 1;
      const promptTelemetry = buildProviderCalledTelemetry(prompt.messages, input.availableTools.map((tool) => tool.name));

      observer.record(
        createTelemetryEvent('prompt_size_summary', 'provider_decision', {
          ...buildTurnContext(telemetry),
          messageCount: prompt.messages.length,
          promptRawChars: promptTelemetry.promptRawChars,
          toolMessagesCount: promptTelemetry.toolMessagesCount,
          assistantToolCallsCount: promptTelemetry.assistantToolCallsCount,
          systemMessageChars: promptTelemetry.systemMessageChars,
          userMessageChars: promptTelemetry.userMessageChars,
          assistantTextChars: promptTelemetry.assistantTextChars,
          assistantToolCallChars: promptTelemetry.assistantToolCallChars,
          toolResultChars: promptTelemetry.toolResultChars,
          promptGrowthSinceLastProviderCallChars:
            telemetry.providerRound > 1 ? promptTelemetry.promptRawChars - telemetry.lastPromptRawChars : undefined,
          toolResultContributionSinceLastProviderCallChars:
            telemetry.providerRound > 1 ? promptTelemetry.toolResultChars - telemetry.lastToolResultChars : undefined
        })
      );

      updatePromptAttributionState(telemetry, promptTelemetry);

      observer.record(
        createTelemetryEvent('provider_called', 'provider_decision', {
          ...buildTurnContext(telemetry),
          ...promptTelemetry
        })
      );

      const providerStartedAt = Date.now();
      let response: ProviderResponse;
      const startedToolCallIds = new Set<string>();

      if (typeof input.provider.stream === 'function') {
        try {
          const providerTimeoutMs = getProviderTimeoutMs();
          const timedStream = readProviderStreamWithTimeout(
            input.provider,
            prompt.messages,
            input.availableTools,
            providerTimeoutMs
          );
          const providerEvents: NormalizedEvent[] = [];

          for await (const event of timedStream) {
            providerEvents.push(event);

            if (event.type === 'start') {
              yield { type: 'provider_started', provider: event.provider, model: event.model };
              continue;
            }

            if (event.type === 'text_delta') {
              yield { type: 'assistant_text_delta', text: event.text };
              continue;
            }

            if (event.type === 'tool_call') {
              if (startedToolCallIds.has(event.id)) {
                continue;
              }

              const toolCall = { id: event.id, name: event.name, input: event.input };
              const redactedToolInput = redactSensitiveTelemetryValue(toolCall.input);
              startedToolCallIds.add(toolCall.id);
              observer.record(
                createTelemetryEvent('tool_call_started', 'tool_execution', {
                  ...buildTurnContext(telemetry),
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  inputPreview: buildTelemetryPreview(redactedToolInput),
                  inputRawRedacted: redactedToolInput
                })
              );
              yield {
                type: 'tool_call_started',
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input
              };
            }
          }

          response = await collectProviderStream((async function* () {
            for (const event of providerEvents) {
              yield event;
            }
          })());
        } catch (error) {
          if (!shouldFallbackToGenerate(input.provider, error)) {
            throw error;
          }

          response = await withProviderTimeout(
            input.provider.generate({
              messages: prompt.messages,
              availableTools: input.availableTools
            }),
            getProviderTimeoutMs(),
            input.provider.name
          );
          yield { type: 'provider_started', provider: input.provider.name, model: input.provider.model };
          if (response.message.content.length > 0) {
            yield { type: 'assistant_text_delta', text: response.message.content };
          }
        }
      } else {
        response = await withProviderTimeout(
          collectProviderResponse(input.provider, prompt.messages, input.availableTools),
          getProviderTimeoutMs(),
          input.provider.name
        );
        yield { type: 'provider_started', provider: input.provider.name, model: input.provider.model };
        if (response.message.content.length > 0) {
          yield { type: 'assistant_text_delta', text: response.message.content };
        }
      }

      if (response.toolCalls.length > 0) {
        telemetry.toolRound += 1;
      }

      accumulateUsageTotals(telemetry, response.usage);

      observer.record(
        createTelemetryEvent(
          'provider_responded',
          'provider_decision',
          buildProviderRespondedTelemetry(response, {
            ...buildTurnContext(telemetry),
            durationMs: Date.now() - providerStartedAt
          })
        )
      );

      history.push(response.message);
      finalAnswer = response.message.content;

      yield {
        type: 'assistant_message_completed',
        text: response.message.content,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined
      };

      if (response.toolCalls.length === 0) {
        yield buildTurnCompletedEvent({
          finalAnswer,
          stopReason: 'completed',
          history,
          toolRoundsUsed: telemetry.toolRound,
          doneCriteria,
          turnCompleted: true
        });
        return;
      }

      if (telemetry.toolRound > input.maxToolRounds) {
        yield buildTurnCompletedEvent({
          finalAnswer,
          stopReason: 'max_tool_rounds_reached',
          history,
          toolRoundsUsed: telemetry.toolRound,
          doneCriteria,
          turnCompleted: false
        });
        return;
      }

      const batchResults: BatchToolResultTelemetry[] = [];

      for (const toolCall of response.toolCalls) {
        const redactedToolInput = redactSensitiveTelemetryValue(toolCall.input);
        if (!startedToolCallIds.has(toolCall.id)) {
          observer.record(
            createTelemetryEvent('tool_call_started', 'tool_execution', {
              ...buildTurnContext(telemetry),
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              inputPreview: buildTelemetryPreview(redactedToolInput),
              inputRawRedacted: redactedToolInput
            })
          );

          yield {
            type: 'tool_call_started',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input
          };
        }

        const toolStartedAt = Date.now();
        const toolResult = truncateToolResultMessage(
          await dispatchAllowedToolCall(toolCall, input.availableTools, input.cwd),
          MAX_TOOL_RESULT_CONTENT_CHARS
        );
        history.push(toolResult);
        telemetry.toolCallsTotal += 1;
        telemetry.toolCallsByName[toolCall.name] = (telemetry.toolCallsByName[toolCall.name] ?? 0) + 1;
        telemetry.hasToolErrors = telemetry.hasToolErrors || toolResult.isError;

        const redactedToolResultPayload = buildRedactedToolResultPayload(toolResult);
        const resultSizeChars = JSON.stringify(redactedToolResultPayload.content).length;
        batchResults.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          isError: toolResult.isError,
          resultSizeChars
        });
        observer.record(
          createTelemetryEvent('tool_call_completed', 'tool_execution', {
            ...buildTurnContext(telemetry),
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            isError: toolResult.isError,
            resultPreview: buildTelemetryPreview({ content: redactedToolResultPayload.content }),
            resultRawRedacted: redactedToolResultPayload,
            durationMs: Date.now() - toolStartedAt,
            resultSizeChars,
            resultSizeBucket: classifyResultSize(resultSizeChars)
          })
        );

        yield {
          type: 'tool_call_completed',
          id: toolCall.id,
          name: toolCall.name,
          resultPreview: buildTelemetryPreview({ content: toolResult.content }, 120),
          isError: toolResult.isError
        };
      }

      observer.record(
        createTelemetryEvent('tool_batch_summary', 'tool_execution', {
          ...buildTurnContext(telemetry),
          ...buildToolBatchSummaryTelemetry(response, telemetry, batchResults)
        })
      );

      if (telemetry.toolRound >= input.maxToolRounds) {
        yield buildTurnCompletedEvent({
          finalAnswer,
          stopReason: 'max_tool_rounds_reached',
          history,
          toolRoundsUsed: telemetry.toolRound,
          doneCriteria,
          turnCompleted: false
        });
        return;
      }
    }
  } catch (error) {
    yield { type: 'turn_failed', error };
    throw error;
  }
}

function buildResult(
  observer: TelemetryObserver,
  telemetry: TurnTelemetryState,
  collected: CollectedTurnState,
  maxToolRounds: number
): RunAgentTurnResult {
  const { stopReason, finalAnswer, history, toolRoundsUsed, doneCriteria, turnCompleted } = collected;
  const verification = verifyAgentTurn({
    criteria: doneCriteria,
    finalAnswer,
    history,
    turnCompleted
  });

  observer.record(
    createTelemetryEvent('verification_completed', 'completion_check', {
      ...buildTurnContext(telemetry),
      isVerified: verification.isVerified,
      toolMessagesCount: verification.toolMessagesCount,
      turnCompleted
    })
  );

  observer.record(
    createTelemetryEvent('completion_check', 'completion_check', {
      ...buildTurnContext(telemetry),
      hasFinalText: finalAnswer.trim().length > 0,
      hasToolErrors: telemetry.hasToolErrors,
      maxToolRoundsReached: toolRoundsUsed >= maxToolRounds,
      stoppedNormally: stopReason === 'completed'
    })
  );

  observer.record(
    createTelemetryEvent(turnCompleted ? 'turn_completed' : 'turn_stopped', 'completion_check', {
      ...buildTurnContext(telemetry),
      stopReason,
      toolRoundsUsed,
      isVerified: verification.isVerified,
      durationMs: Date.now() - telemetry.turnStartedAt
    })
  );

  observer.record(
    createTelemetryEvent('turn_summary', 'completion_check', {
      ...buildTurnContext(telemetry),
      providerRounds: telemetry.providerRound,
      toolRoundsUsed,
      toolCallsTotal: telemetry.toolCallsTotal,
      toolCallsByName: telemetry.toolCallsByName,
      inputTokensTotal: telemetry.inputTokensTotal,
      outputTokensTotal: telemetry.outputTokensTotal,
      cacheReadInputTokens: telemetry.cacheReadInputTokens,
      promptCharsMax: telemetry.promptCharsMax,
      toolResultCharsInFinalPrompt: telemetry.finalToolResultChars,
      assistantToolCallCharsInFinalPrompt: telemetry.finalAssistantToolCallChars,
      toolResultPromptGrowthCharsTotal: telemetry.toolResultPromptGrowthCharsTotal,
      toolResultCharsAddedAcrossTurn: telemetry.toolResultCharsAddedAcrossTurn,
      turnCompleted,
      stopReason
    })
  );

  return {
    stopReason,
    finalAnswer,
    history,
    toolRoundsUsed,
    doneCriteria,
    verification
  };
}

function buildTurnCompletedEvent(input: Omit<Extract<TurnEvent, { type: 'turn_completed' }>, 'type'>): Extract<TurnEvent, { type: 'turn_completed' }> {
  return {
    type: 'turn_completed',
    finalAnswer: input.finalAnswer,
    stopReason: input.stopReason,
    history: [...input.history],
    toolRoundsUsed: input.toolRoundsUsed,
    doneCriteria: input.doneCriteria,
    turnCompleted: input.turnCompleted
  };
}

function buildProviderCalledTelemetry(messages: Message[], toolNames: string[]) {
  const promptTelemetry = measurePromptTelemetry(messages);

  return {
    messageCount: messages.length,
    toolNames,
    ...promptTelemetry
  };
}

interface BatchToolResultTelemetry {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  resultSizeChars: number;
}

const LARGE_TOOL_RESULT_CHARS = 100;
const LARGE_TOOL_BATCH_RESULT_CHARS = 140;
const LONG_TOOL_BATCH_CALLS = 4;
const MULTI_TOOL_BATCH_CALLS = 2;

function updatePromptAttributionState(
  telemetry: TurnTelemetryState,
  promptTelemetry: ReturnType<typeof measurePromptTelemetry>
): void {
  telemetry.promptCharsMax = Math.max(telemetry.promptCharsMax, promptTelemetry.promptRawChars);
  telemetry.toolResultPromptGrowthCharsTotal += Math.max(0, promptTelemetry.toolResultChars - telemetry.lastToolResultChars);
  telemetry.toolResultCharsAddedAcrossTurn += Math.max(0, promptTelemetry.toolResultChars - telemetry.lastToolResultChars);
  telemetry.lastPromptRawChars = promptTelemetry.promptRawChars;
  telemetry.lastToolResultChars = promptTelemetry.toolResultChars;
  telemetry.finalToolResultChars = promptTelemetry.toolResultChars;
  telemetry.finalAssistantToolCallChars = promptTelemetry.assistantToolCallChars;
}

function buildToolBatchSummaryTelemetry(
  response: ProviderResponse,
  telemetry: TurnTelemetryState,
  batchResults: BatchToolResultTelemetry[]
) {
  const resultSizeCharsTotal = batchResults.reduce((total, result) => total + result.resultSizeChars, 0);
  const resultSizeCharsMax = batchResults.reduce((max, result) => Math.max(max, result.resultSizeChars), 0);
  const errorCount = batchResults.filter((result) => result.isError).length;
  const duplicateToolNameCount = Math.max(0, response.toolCalls.length - Object.keys(countToolCallsByName(response.toolCalls)).length);
  const sameToolNameRepeated = duplicateToolNameCount > 0;
  const oversizedToolCallIds = batchResults
    .filter((result) => result.resultSizeChars >= LARGE_TOOL_RESULT_CHARS)
    .map((result) => result.toolCallId);

  return {
    toolCallsTotal: response.toolCalls.length,
    toolCallsByName: countToolCallsByName(response.toolCalls),
    batchSource: 'single_provider_response' as const,
    batchIndexWithinTurn: telemetry.toolRound,
    providerResponseToolCallCount: response.toolCalls.length,
    providerResponseHadTextOutput: response.message.content.trim().length > 0,
    toolCallIds: response.toolCalls.map((toolCall) => toolCall.id),
    resultSizeCharsTotal,
    resultSizeCharsMax,
    errorCount,
    duplicateToolNameCount,
    sameToolNameRepeated,
    batchLengthHint: getBatchLengthHint(response.toolCalls.length),
    largeResultHint: getLargeResultHint(resultSizeCharsTotal, resultSizeCharsMax),
    oversizedToolCallIds: oversizedToolCallIds.length > 0 ? oversizedToolCallIds : undefined,
    redundancyHint: detectRedundancyHint(response.toolCalls)
  };
}

function classifyResultSize(resultSizeChars: number): 'small' | 'medium' | 'large' {
  if (resultSizeChars >= LARGE_TOOL_RESULT_CHARS) {
    return 'large';
  }

  if (resultSizeChars >= 40) {
    return 'medium';
  }

  return 'small';
}

function getBatchLengthHint(toolCallsTotal: number): 'multi_call_batch' | 'long_batch' | undefined {
  if (toolCallsTotal >= LONG_TOOL_BATCH_CALLS) {
    return 'long_batch';
  }

  if (toolCallsTotal >= MULTI_TOOL_BATCH_CALLS) {
    return 'multi_call_batch';
  }

  return undefined;
}

function getLargeResultHint(
  resultSizeCharsTotal: number,
  resultSizeCharsMax: number
): 'batch_result_large' | 'single_result_large' | undefined {
  if (resultSizeCharsTotal >= LARGE_TOOL_BATCH_RESULT_CHARS) {
    return 'batch_result_large';
  }

  if (resultSizeCharsMax >= LARGE_TOOL_RESULT_CHARS) {
    return 'single_result_large';
  }

  return undefined;
}

function countContentBlocks(content: string): number {
  return content.length > 0 ? 1 : 0;
}

function buildProviderRespondedTelemetry(
  response: ProviderResponse,
  context: TelemetryEventContextData & { durationMs: number }
) {
  const responseContentBlockCount = response.responseMetrics?.contentBlockCount ?? countContentBlocks(response.message.content);
  const toolCallCount = response.responseMetrics?.toolCallCount ?? response.toolCalls.length;
  const hasTextOutput = response.responseMetrics?.hasTextOutput ?? response.message.content.length > 0;

  return {
    ...context,
    stopReason: response.finish?.stopReason,
    usage: normalizeUsageSummary(response.usage),
    responseContentBlockCount,
    toolCallCount,
    hasTextOutput,
    responseContentBlocksByType: response.debug?.responseContentBlocksByType ?? response.responseMetrics?.contentBlocksByType,
    toolCallSummaries: response.debug?.toolCallSummaries,
    providerUsageRawRedacted: response.debug?.providerUsageRawRedacted,
    providerStopDetails: response.debug?.providerStopDetails,
    responsePreviewRedacted: response.debug?.responsePreviewRedacted,
    durationMs: context.durationMs
  };
}

function normalizeUsageSummary(usage?: ProviderUsageSummary): ProviderUsageSummary | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens
  };
}

function buildRedactedToolResultPayload(toolResult: ToolResultMessage): Record<string, unknown> {
  return {
    ...toolResult,
    content: redactSensitiveTelemetryValue(parseToolResultContent(toolResult.content))
  };
}

function parseToolResultContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function buildTurnContext(telemetry: TurnTelemetryState): TelemetryEventContextData {
  return {
    turnId: telemetry.turnId,
    providerRound: telemetry.providerRound,
    toolRound: telemetry.toolRound
  };
}

function accumulateUsageTotals(telemetry: TurnTelemetryState, usage?: ProviderUsageSummary): void {
  if (!usage) {
    return;
  }

  telemetry.inputTokensTotal += usage.inputTokens ?? 0;
  telemetry.outputTokensTotal += usage.outputTokens ?? 0;
  telemetry.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
}

function countToolCallsByName(toolCalls: ToolCallRequest[]): Record<string, number> {
  return toolCalls.reduce<Record<string, number>>((counts, toolCall) => {
    counts[toolCall.name] = (counts[toolCall.name] ?? 0) + 1;
    return counts;
  }, {});
}

function detectRedundancyHint(
  toolCalls: ToolCallRequest[]
): 'possible_case_variant_duplication' | 'repeated_same_tool_name' | 'repeated_same_tool_input' | undefined {
  const seen = new Map<string, Set<string>>();
  const seenNames = new Set<string>();

  for (const toolCall of toolCalls) {
    const normalizedInput = JSON.stringify(toolCall.input).toLowerCase();
    const rawInput = JSON.stringify(toolCall.input);
    const toolInputs = seen.get(toolCall.name) ?? new Set<string>();

    if (toolInputs.has(normalizedInput)) {
      return rawInput !== normalizedInput ? 'possible_case_variant_duplication' : 'repeated_same_tool_input';
    }

    if (seenNames.has(toolCall.name)) {
      return 'repeated_same_tool_name';
    }

    toolInputs.add(normalizedInput);
    seen.set(toolCall.name, toolInputs);
    seenNames.add(toolCall.name);
  }

  return undefined;
}

function truncateToolResultMessage(toolResult: ToolResultMessage, maxChars: number): ToolResultMessage {
  if (toolResult.content.length <= maxChars) {
    return toolResult;
  }

  return {
    ...toolResult,
    content: `${toolResult.content.slice(0, Math.max(0, maxChars - 64))}\n… truncated from ${toolResult.content.length} chars`
  };
}

function createTurnTelemetryState(): TurnTelemetryState {
  return {
    turnId: createTurnId(),
    providerRound: 0,
    toolRound: 0,
    turnStartedAt: Date.now(),
    toolCallsTotal: 0,
    toolCallsByName: {},
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    cacheReadInputTokens: 0,
    hasToolErrors: false,
    lastPromptRawChars: 0,
    lastToolResultChars: 0,
    promptCharsMax: 0,
    toolResultPromptGrowthCharsTotal: 0,
    toolResultCharsAddedAcrossTurn: 0,
    finalToolResultChars: 0,
    finalAssistantToolCallChars: 0
  };
}

async function collectProviderResponse(
  provider: ModelProvider,
  messages: Message[],
  availableTools: Tool[]
): Promise<ProviderResponse> {
  if (typeof provider.stream === 'function') {
    return collectProviderStream(readProviderStream(provider, messages, availableTools));
  }

  return provider.generate({ messages, availableTools });
}

async function* readProviderStream(
  provider: ModelProvider,
  messages: Message[],
  availableTools: Tool[]
): AsyncIterable<NormalizedEvent> {
  for await (const event of provider.stream({ messages, availableTools })) {
    yield event;
  }
}

function readProviderStreamWithTimeout(
  provider: ModelProvider,
  messages: Message[],
  availableTools: Tool[],
  timeoutMs: number
): AsyncIterable<NormalizedEvent> {
  return withProviderStreamTimeout(provider.stream({ messages, availableTools }), timeoutMs, provider.name);
}

function shouldFallbackToGenerate(provider: ModelProvider, error: unknown): boolean {
  return provider.name === 'anthropic'
    && error instanceof Error
    && error.message === 'Anthropic provider does not support streaming yet.';
}

async function* withProviderStreamTimeout(
  stream: AsyncIterable<NormalizedEvent>,
  timeoutMs: number,
  providerName: string
): AsyncIterable<NormalizedEvent> {
  const iterator = stream[Symbol.asyncIterator]();

  try {
    while (true) {
      const nextResult = await withProviderTimeout(iterator.next(), timeoutMs, providerName);
      if (nextResult.done) {
        return;
      }

      yield nextResult.value;
    }
  } finally {
    await iterator.return?.();
  }
}

function getProviderTimeoutMs(): number {
  const raw = process.env.QICLAW_PROVIDER_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  return Math.floor(parsed);
}

function withProviderTimeout<T>(promise: Promise<T>, timeoutMs: number, providerName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${providerName} provider timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createTurnId(): string {
  return `turn_${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 5)}`;
}

async function dispatchAllowedToolCall(
  toolCall: ToolCallRequest,
  availableTools: Tool[],
  cwd: string
): Promise<ToolResultMessage> {
  const allowedTool = availableTools.find((tool) => tool.name === toolCall.name);

  if (!allowedTool) {
    return {
      role: 'tool',
      name: toolCall.name,
      toolCallId: toolCall.id,
      content: `Tool not allowed for this turn: ${toolCall.name}`,
      isError: true
    };
  }

  try {
    validateToolInput(allowedTool, toolCall.input);
    const result = await allowedTool.execute(toolCall.input, { cwd });
    return toToolResultMessage(toolCall, result);
  } catch (error) {
    return toToolErrorMessage(toolCall, error);
  }
}
