import type { Message } from '../core/types.js';
import { buildPromptWithContext } from '../context/promptBuilder.js';
import type { ProviderResponse, ProviderUsageSummary } from '../provider/model.js';
import {
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

interface TurnTelemetryState {
  turnId: string;
  providerRound: number;
  toolRound: number;
  turnStartedAt: number;
  toolCallsTotal: number;
  toolCallsByName: Record<string, number>;
  inputTokensTotal: number;
  outputTokensTotal: number;
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
  const observer = input.observer ?? createNoopObserver();
  const history: Message[] = [...(input.history ?? []), { role: 'user', content: input.userInput }];
  const doneCriteria = buildDoneCriteria(input.userInput, input.agentSpec?.completion);

  let finalAnswer = '';
  let toolRoundsUsed = 0;
  const telemetry: TurnTelemetryState = {
    turnId: createTurnId(),
    providerRound: 0,
    toolRound: 0,
    turnStartedAt: Date.now(),
    toolCallsTotal: 0,
    toolCallsByName: {},
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    hasToolErrors: false,
    lastPromptRawChars: 0,
    lastToolResultChars: 0,
    promptCharsMax: 0,
    toolResultPromptGrowthCharsTotal: 0,
    toolResultCharsAddedAcrossTurn: 0,
    finalToolResultChars: 0,
    finalAssistantToolCallChars: 0
  };

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
      const response = await input.provider.generate({
        messages: prompt.messages,
        availableTools: input.availableTools
      });

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

      if (response.toolCalls.length === 0) {
        return buildResult(observer, telemetry, 'completed', finalAnswer, history, toolRoundsUsed, doneCriteria, true, input.maxToolRounds);
      }

      if (toolRoundsUsed >= input.maxToolRounds) {
        return buildResult(
          observer,
          telemetry,
          'max_tool_rounds_reached',
          finalAnswer,
          history,
          toolRoundsUsed,
          doneCriteria,
          false,
          input.maxToolRounds
        );
      }

      toolRoundsUsed += 1;

      const batchResults: BatchToolResultTelemetry[] = [];

      for (const toolCall of response.toolCalls) {
        const redactedToolInput = redactSensitiveTelemetryValue(toolCall.input);
        observer.record(
          createTelemetryEvent('tool_call_started', 'tool_execution', {
            ...buildTurnContext(telemetry),
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            inputPreview: buildTelemetryPreview(redactedToolInput),
            inputRawRedacted: redactedToolInput
          })
        );

        const toolStartedAt = Date.now();
        const toolResult = await dispatchAllowedToolCall(toolCall, input.availableTools, input.cwd);
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
      }

      observer.record(
        createTelemetryEvent('tool_batch_summary', 'tool_execution', {
          ...buildTurnContext(telemetry),
          ...buildToolBatchSummaryTelemetry(response, telemetry, batchResults)
        })
      );

      if (toolRoundsUsed >= input.maxToolRounds) {
        return buildResult(
          observer,
          telemetry,
          'max_tool_rounds_reached',
          finalAnswer,
          history,
          toolRoundsUsed,
          doneCriteria,
          false,
          input.maxToolRounds
        );
      }
    }
  } catch (error) {
    observer.record(
      createTelemetryEvent('turn_failed', 'completion_check', {
        ...buildTurnContext(telemetry),
        message: error instanceof Error ? error.message : String(error)
      })
    );
    throw error;
  }
}

function buildResult(
  observer: TelemetryObserver,
  telemetry: TurnTelemetryState,
  stopReason: AgentTurnStopReason,
  finalAnswer: string,
  history: Message[],
  toolRoundsUsed: number,
  doneCriteria: DoneCriteria,
  turnCompleted: boolean,
  maxToolRounds: number
): RunAgentTurnResult {
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
    totalTokens: usage.totalTokens
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
