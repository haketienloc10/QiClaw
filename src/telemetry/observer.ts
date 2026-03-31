export type TelemetryEventType =
  | 'turn_started'
  | 'provider_called'
  | 'provider_responded'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'verification_completed'
  | 'turn_completed'
  | 'turn_stopped'
  | 'turn_failed';

import type { ProviderToolCallSummary, ProviderUsageSummary } from '../provider/model.js';

export interface TurnStartedTelemetryData {
  cwd: string;
  userInput: string;
  maxToolRounds: number;
  toolNames: string[];
}

export interface ProviderCalledMessageSummary {
  role: string;
  contentPreviewRedacted: string;
  contentBlockCount: number;
  hasToolCalls: boolean;
}

export interface ProviderCalledTelemetryData {
  messageCount: number;
  promptRawChars: number;
  toolNames: string[];
  messageSummaries: ProviderCalledMessageSummary[];
  totalContentBlockCount: number;
  hasSystemPrompt: boolean;
  promptRawPreviewRedacted: string;
}

export interface ProviderRespondedTelemetryData {
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
}

export interface ToolCallStartedTelemetryData {
  toolName: string;
  toolCallId: string;
  inputPreview: string;
  inputRawRedacted: unknown;
}

export interface ToolCallCompletedTelemetryData {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  resultPreview: string;
  resultRawRedacted: Record<string, unknown>;
}

export interface VerificationCompletedTelemetryData {
  isVerified: boolean;
  toolMessagesCount: number;
  turnCompleted: boolean;
}

export interface TurnFinishedTelemetryData {
  stopReason: string;
  toolRoundsUsed: number;
  isVerified: boolean;
}

export interface TurnFailedTelemetryData {
  message: string;
}

export interface TelemetryEventDataMap {
  turn_started: TurnStartedTelemetryData;
  provider_called: ProviderCalledTelemetryData;
  provider_responded: ProviderRespondedTelemetryData;
  tool_call_started: ToolCallStartedTelemetryData;
  tool_call_completed: ToolCallCompletedTelemetryData;
  verification_completed: VerificationCompletedTelemetryData;
  turn_completed: TurnFinishedTelemetryData;
  turn_stopped: TurnFinishedTelemetryData;
  turn_failed: TurnFailedTelemetryData;
}

export interface TelemetryEvent<TType extends TelemetryEventType = TelemetryEventType> {
  type: TType;
  timestamp: string;
  data: TelemetryEventDataMap[TType];
}

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
  data: TelemetryEventDataMap[TType]
): TelemetryEvent<TType> {
  return {
    type,
    timestamp: new Date().toISOString(),
    data
  };
}
