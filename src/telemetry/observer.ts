import type { ProviderToolCallSummary, ProviderUsageSummary } from '../provider/model.js';

export type TelemetryEventType =
  | 'user_input_received'
  | 'turn_started'
  | 'prompt_size_summary'
  | 'provider_called'
  | 'provider_responded'
  | 'tool_batch_summary'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'verification_completed'
  | 'completion_check'
  | 'turn_completed'
  | 'turn_stopped'
  | 'turn_summary'
  | 'turn_failed'
  | 'interactive_memory_fallback';

export type TelemetryStage =
  | 'input_received'
  | 'provider_decision'
  | 'tool_execution'
  | 'response_composition'
  | 'completion_check';

export interface TelemetryEventContextData {
  turnId: string;
  providerRound: number;
  toolRound: number;
}

export interface UserInputReceivedTelemetryData extends TelemetryEventContextData {
  userInput: string;
  userInputChars: number;
}

export interface TurnStartedTelemetryData extends TelemetryEventContextData {
  cwd: string;
  userInput: string;
  maxToolRounds: number;
  toolNames: string[];
}

export type TelemetryMessageSource = 'system' | 'user' | 'assistant_text' | 'assistant_tool_call' | 'tool_result';

export interface ProviderCalledMessageSummary {
  role: string;
  rawChars: number;
  contentBlockCount: number;
  messageSource: TelemetryMessageSource;
  toolCallCount?: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface PromptSizeSummaryTelemetryData extends TelemetryEventContextData {
  messageCount: number;
  promptRawChars: number;
  toolMessagesCount: number;
  assistantToolCallsCount: number;
  systemMessageChars: number;
  userMessageChars: number;
  assistantTextChars: number;
  assistantToolCallChars: number;
  toolResultChars: number;
  promptGrowthSinceLastProviderCallChars?: number;
  toolResultContributionSinceLastProviderCallChars?: number;
}

export interface ProviderCalledTelemetryData extends TelemetryEventContextData {
  messageCount: number;
  promptRawChars: number;
  toolNames: string[];
  messageSummaries: ProviderCalledMessageSummary[];
  totalContentBlockCount: number;
  hasSystemPrompt: boolean;
  promptRawPreviewRedacted: string;
}

export interface ProviderRespondedTelemetryData extends TelemetryEventContextData {
  stopReason?: string;
  usage?: ProviderUsageSummary;
  responseContentBlockCount: number;
  toolCallCount: number;
  hasTextOutput: boolean;
  responseContentBlocksByType?: Record<string, number>;
  toolCallSummaries?: ProviderToolCallSummary[];
  providerUsageRawRedacted?: unknown;
  providerStopDetails?: unknown;
  responsePreviewRedacted?: string;
  durationMs: number;
}

export interface ToolBatchSummaryTelemetryData extends TelemetryEventContextData {
  toolCallsTotal: number;
  toolCallsByName: Record<string, number>;
  batchSource: 'single_provider_response';
  batchIndexWithinTurn: number;
  providerResponseToolCallCount: number;
  providerResponseHadTextOutput: boolean;
  toolCallIds: string[];
  resultSizeCharsTotal: number;
  resultSizeCharsMax: number;
  errorCount: number;
  duplicateToolNameCount: number;
  sameToolNameRepeated: boolean;
  batchLengthHint?: 'multi_call_batch' | 'long_batch';
  largeResultHint?: 'batch_result_large' | 'single_result_large';
  oversizedToolCallIds?: string[];
  redundancyHint?: 'possible_case_variant_duplication' | 'repeated_same_tool_name' | 'repeated_same_tool_input';
}

export interface ToolCallStartedTelemetryData extends TelemetryEventContextData {
  toolName: string;
  toolCallId: string;
  inputPreview: string;
  inputRawRedacted: unknown;
}

export interface ToolCallCompletedTelemetryData extends TelemetryEventContextData {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  resultPreview: string;
  resultRawRedacted: Record<string, unknown>;
  durationMs: number;
  resultSizeChars: number;
  resultSizeBucket: 'small' | 'medium' | 'large';
}

export interface VerificationCompletedTelemetryData extends TelemetryEventContextData {
  isVerified: boolean;
  toolMessagesCount: number;
  turnCompleted: boolean;
}

export interface CompletionCheckTelemetryData extends TelemetryEventContextData {
  hasFinalText: boolean;
  hasToolErrors: boolean;
  maxToolRoundsReached: boolean;
  stoppedNormally: boolean;
}

export interface TurnFinishedTelemetryData extends TelemetryEventContextData {
  stopReason: string;
  toolRoundsUsed: number;
  isVerified: boolean;
  durationMs: number;
}

export interface TurnSummaryTelemetryData extends TelemetryEventContextData {
  providerRounds: number;
  toolRoundsUsed: number;
  toolCallsTotal: number;
  toolCallsByName: Record<string, number>;
  inputTokensTotal: number;
  outputTokensTotal: number;
  promptCharsMax: number;
  toolResultCharsInFinalPrompt: number;
  assistantToolCallCharsInFinalPrompt: number;
  toolResultPromptGrowthCharsTotal: number;
  toolResultCharsAddedAcrossTurn: number;
  turnCompleted: boolean;
  stopReason: string;
}

export interface TurnFailedTelemetryData extends TelemetryEventContextData {
  message: string;
}

export interface InteractiveMemoryFallbackTelemetryData {
  sessionId: string;
  phase: 'prepare' | 'capture';
  message: string;
}

export interface TelemetryEventDataMap {
  user_input_received: UserInputReceivedTelemetryData;
  turn_started: TurnStartedTelemetryData;
  prompt_size_summary: PromptSizeSummaryTelemetryData;
  provider_called: ProviderCalledTelemetryData;
  provider_responded: ProviderRespondedTelemetryData;
  tool_batch_summary: ToolBatchSummaryTelemetryData;
  tool_call_started: ToolCallStartedTelemetryData;
  tool_call_completed: ToolCallCompletedTelemetryData;
  verification_completed: VerificationCompletedTelemetryData;
  completion_check: CompletionCheckTelemetryData;
  turn_completed: TurnFinishedTelemetryData;
  turn_stopped: TurnFinishedTelemetryData;
  turn_summary: TurnSummaryTelemetryData;
  turn_failed: TurnFailedTelemetryData;
  interactive_memory_fallback: InteractiveMemoryFallbackTelemetryData;
}

export type TelemetryEvent<TType extends TelemetryEventType = TelemetryEventType> = {
  [Type in TType]: {
    type: Type;
    timestamp: string;
    stage: TelemetryStage;
    data: TelemetryEventDataMap[Type];
  };
}[TType];

export interface TelemetryObserver {
  record(event: TelemetryEvent): void;
}

export function createNoopObserver(): TelemetryObserver {
  return {
    record() {}
  };
}

export function createTelemetryEvent<TType extends TelemetryEventType>(
  type: TType,
  stage: TelemetryStage,
  data: TelemetryEventDataMap[TType]
): TelemetryEvent<TType> {
  return {
    type,
    timestamp: new Date().toISOString(),
    stage,
    data
  };
}
