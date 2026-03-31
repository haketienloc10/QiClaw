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
import {
  createNoopObserver,
  createTelemetryEvent,
  type ProviderCalledMessageSummary,
  type TelemetryObserver
} from '../telemetry/observer.js';
import { buildTelemetryPreview } from '../telemetry/preview.js';
import { redactSensitiveTelemetryValue } from '../telemetry/redaction.js';
import type { Tool } from '../tools/registry.js';

import { buildDoneCriteria, type DoneCriteria } from './doneCriteria.js';
import { verifyAgentTurn, type AgentTurnVerification } from './verifier.js';

export interface RunAgentTurnInput {
  provider: ModelProvider;
  availableTools: Tool[];
  baseSystemPrompt: string;
  userInput: string;
  cwd: string;
  maxToolRounds: number;
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

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const observer = input.observer ?? createNoopObserver();
  const history: Message[] = [...(input.history ?? []), { role: 'user', content: input.userInput }];
  const doneCriteria = buildDoneCriteria(input.userInput);

  let finalAnswer = '';
  let toolRoundsUsed = 0;

  observer.record(
    createTelemetryEvent('turn_started', {
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

      const promptTelemetry = buildProviderCalledTelemetry(prompt.messages, input.availableTools.map((tool) => tool.name));

      observer.record(createTelemetryEvent('provider_called', promptTelemetry));

      const response = await input.provider.generate({
        messages: prompt.messages,
        availableTools: input.availableTools
      });

      observer.record(createTelemetryEvent('provider_responded', buildProviderRespondedTelemetry(response)));

      history.push(response.message);
      finalAnswer = response.message.content;

      if (response.toolCalls.length === 0) {
        return buildResult(observer, 'completed', finalAnswer, history, toolRoundsUsed, doneCriteria, true);
      }

      if (toolRoundsUsed >= input.maxToolRounds) {
        return buildResult(observer, 'max_tool_rounds_reached', finalAnswer, history, toolRoundsUsed, doneCriteria, false);
      }

      toolRoundsUsed += 1;

      for (const toolCall of response.toolCalls) {
        const redactedToolInput = redactSensitiveTelemetryValue(toolCall.input);
        observer.record(
          createTelemetryEvent('tool_call_started', {
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            inputPreview: buildTelemetryPreview(redactedToolInput),
            inputRawRedacted: redactedToolInput
          })
        );

        const toolResult = await dispatchAllowedToolCall(toolCall, input.availableTools, input.cwd);
        history.push(toolResult);

        const redactedToolResultPayload = buildRedactedToolResultPayload(toolResult);
        observer.record(
          createTelemetryEvent('tool_call_completed', {
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            isError: toolResult.isError,
            resultPreview: buildTelemetryPreview({ content: redactedToolResultPayload.content }),
            resultRawRedacted: redactedToolResultPayload
          })
        );
      }

      if (toolRoundsUsed >= input.maxToolRounds) {
        return buildResult(observer, 'max_tool_rounds_reached', finalAnswer, history, toolRoundsUsed, doneCriteria, false);
      }
    }
  } catch (error) {
    observer.record(
      createTelemetryEvent('turn_failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    );
    throw error;
  }
}

function buildResult(
  observer: TelemetryObserver,
  stopReason: AgentTurnStopReason,
  finalAnswer: string,
  history: Message[],
  toolRoundsUsed: number,
  doneCriteria: DoneCriteria,
  turnCompleted: boolean
): RunAgentTurnResult {
  const verification = verifyAgentTurn({
    criteria: doneCriteria,
    finalAnswer,
    history,
    turnCompleted
  });

  observer.record(
    createTelemetryEvent('verification_completed', {
      isVerified: verification.isVerified,
      toolMessagesCount: verification.toolMessagesCount,
      turnCompleted
    })
  );

  observer.record(
    createTelemetryEvent(turnCompleted ? 'turn_completed' : 'turn_stopped', {
      stopReason,
      toolRoundsUsed,
      isVerified: verification.isVerified
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
  const messageSummaries = messages.map((message) => summarizePromptMessage(message));
  const promptRawPreviewRedacted = buildTelemetryPreview(
    {
      messages: messages.map((message) => ({
        role: message.role,
        content: redactSensitiveTelemetryValue(message.content)
      }))
    },
    512
  );

  return {
    messageCount: messages.length,
    promptRawChars: messages.reduce((total, message) => total + message.content.length, 0),
    toolNames,
    messageSummaries,
    totalContentBlockCount: messageSummaries.reduce((total, message) => total + message.contentBlockCount, 0),
    hasSystemPrompt: messages.some((message) => message.role === 'system' && message.content.trim().length > 0),
    promptRawPreviewRedacted
  };
}

function summarizePromptMessage(message: Message): ProviderCalledMessageSummary {
  return {
    role: message.role,
    contentPreviewRedacted: buildTelemetryPreview(redactSensitiveTelemetryValue(message.content)),
    contentBlockCount: countContentBlocks(message.content),
    hasToolCalls: Array.isArray(message.toolCalls) && message.toolCalls.length > 0
  };
}

function countContentBlocks(content: string): number {
  return content.length > 0 ? 1 : 0;
}

function buildProviderRespondedTelemetry(response: ProviderResponse) {
  const responseContentBlockCount = response.responseMetrics?.contentBlockCount ?? countContentBlocks(response.message.content);
  const toolCallCount = response.responseMetrics?.toolCallCount ?? response.toolCalls.length;
  const hasTextOutput = response.responseMetrics?.hasTextOutput ?? response.message.content.length > 0;

  return {
    stopReason: response.finish?.stopReason,
    usage: normalizeUsageSummary(response.usage),
    responseContentBlockCount,
    toolCallCount,
    hasTextOutput,
    responseContentBlocksByType: response.debug?.responseContentBlocksByType ?? response.responseMetrics?.contentBlocksByType,
    toolCallSummaries: response.debug?.toolCallSummaries,
    providerUsageRawRedacted: response.debug?.providerUsageRawRedacted,
    providerStopDetails: response.debug?.providerStopDetails,
    responsePreviewRedacted: response.debug?.responsePreviewRedacted
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
    const result = await allowedTool.execute(toolCall.input, { cwd });
    return toToolResultMessage(toolCall, result);
  } catch (error) {
    return toToolErrorMessage(toolCall, error);
  }
}
