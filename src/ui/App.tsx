import React, { useMemo, useState } from 'react';
import { Box } from 'ink';

import type { AgentRuntime } from '../agent/runtime.js';
import type { CliRunTurnResult } from '../cli/main.js';
import type { Message, ChatSessionRecord } from '../core/types.js';
import type { ProviderStreamEvent, ProviderToolCallSummary, ProviderUsageSummary } from '../provider/model.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatPane } from './components/ChatPane.js';
import { Composer } from './components/Composer.js';
import { StatusBar } from './components/StatusBar.js';

export interface AppRunTurnInput {
  userInput: string;
  history: Message[];
  historySummary?: string;
  onEvent(event: ProviderStreamEvent): void;
}

export interface AppProps {
  runtime: AgentRuntime;
  initialMessages?: Message[];
  initialHistorySummary?: string;
  runTurn?: (input: AppRunTurnInput) => Promise<Pick<CliRunTurnResult, 'finalAnswer' | 'history' | 'historySummary'>>;
  onTurnSettled?(): void;
}

export interface ToolActivityItem {
  id: string;
  name: string;
  status: 'running' | 'completed';
}

export interface InteractiveTurnControllerSnapshot {
  draft: string;
  messages: Message[];
  historySummary?: string;
  composerLocked: boolean;
  isThinking: boolean;
  toolActivities: ToolActivityItem[];
  latestUsage?: ProviderUsageSummary;
  statusText?: string;
}

export interface InteractiveTurnController {
  getSnapshot(): InteractiveTurnControllerSnapshot;
  setDraft(value: string): void;
  submitTurn(value: string): Promise<{ accepted: boolean }>;
}

export function createInteractiveTurnController(input: {
  initialMessages?: Message[];
  initialHistorySummary?: string;
  runTurn: (input: AppRunTurnInput) => Promise<Pick<CliRunTurnResult, 'finalAnswer' | 'history' | 'historySummary'>>;
  onUpdate?(snapshot: InteractiveTurnControllerSnapshot): void;
  onTurnSettled?(): void;
}): InteractiveTurnController {
  let draft = '';
  let messages = [...(input.initialMessages ?? [])];
  let historySummary = input.initialHistorySummary;
  let toolActivities: ToolActivityItem[] = [];
  let latestUsage: ProviderUsageSummary | undefined;
  let statusText: string | undefined;
  let inFlightTurnToken: symbol | undefined;

  const publish = () => {
    input.onUpdate?.({
      draft,
      messages,
      historySummary,
      composerLocked: inFlightTurnToken !== undefined,
      isThinking: inFlightTurnToken !== undefined,
      toolActivities,
      latestUsage,
      statusText
    });
  };

  const appendAssistantDelta = (delta: string) => {
    const lastMessage = messages.at(-1);
    if (lastMessage?.role !== 'assistant') {
      return;
    }

    messages = [
      ...messages.slice(0, -1),
      {
        ...lastMessage,
        content: `${lastMessage.content}${delta}`
      }
    ];
    statusText = 'Streaming';
    publish();
  };

  const setToolActivity = (toolCall: ProviderToolCallSummary) => {
    toolActivities = [...toolActivities, {
      id: toolCall.id,
      name: toolCall.name,
      status: 'running'
    }];
    statusText = `Using ${toolCall.name}`;
    publish();
  };

  const setUsage = (usage: ProviderUsageSummary) => {
    latestUsage = usage;
    publish();
  };

  const completeStreaming = () => {
    toolActivities = toolActivities.map((activity) => ({
      ...activity,
      status: 'completed'
    }));
    statusText = 'Completed';
    publish();
  };

  return {
    getSnapshot() {
      return {
        draft,
        messages,
        historySummary,
        composerLocked: inFlightTurnToken !== undefined,
        isThinking: inFlightTurnToken !== undefined,
        toolActivities,
        latestUsage,
        statusText
      };
    },
    setDraft(value: string) {
      if (inFlightTurnToken) {
        return;
      }

      draft = value;
      publish();
    },
    submitTurn(value: string) {
      const trimmed = value.trim();

      if (inFlightTurnToken || trimmed.length === 0) {
        return Promise.resolve({ accepted: false });
      }

      const turnHistory = [...messages];
      const previousDraft = draft;
      const previousActivityLines = toolActivities;
      const previousLatestUsage = latestUsage;
      const previousStatusText = statusText;
      const optimisticMessages: Message[] = [
        ...turnHistory,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '' }
      ];

      draft = '';
      messages = optimisticMessages;
      toolActivities = [];
      latestUsage = undefined;
      statusText = 'Streaming';

      const turnToken = Symbol('interactive-turn');
      inFlightTurnToken = turnToken;
      publish();

      const turnPromise = input.runTurn({
        userInput: trimmed,
        history: turnHistory,
        historySummary,
        onEvent(event) {
          if (event.type === 'text_delta') {
            appendAssistantDelta(event.delta);
            return;
          }

          if (event.type === 'tool_call') {
            setToolActivity(event.toolCall);
            return;
          }

          if (event.type === 'usage') {
            setUsage(event.usage);
            return;
          }

          if (event.type === 'completed') {
            completeStreaming();
          }
        }
      }).then((result) => {
        messages = result.history;
        historySummary = result.historySummary ?? historySummary;
        statusText = 'Completed';
        publish();
        return { accepted: true };
      }).catch((error) => {
        draft = previousDraft;
        messages = turnHistory;
        toolActivities = previousActivityLines;
        latestUsage = previousLatestUsage;
        statusText = previousStatusText;
        publish();
        throw error;
      }).finally(() => {
        if (inFlightTurnToken === turnToken) {
          inFlightTurnToken = undefined;
          publish();
        }
        input.onTurnSettled?.();
      });

      return turnPromise;
    }
  };
}

export default function App({
  runtime,
  initialMessages = [],
  initialHistorySummary,
  runTurn,
  onTurnSettled
}: AppProps) {
  const [snapshot, setSnapshot] = useState<InteractiveTurnControllerSnapshot>({
    draft: '',
    messages: initialMessages,
    historySummary: initialHistorySummary,
    composerLocked: false,
    isThinking: false,
    toolActivities: [],
    latestUsage: undefined,
    statusText: undefined
  });
  const [controller] = useState(() => runTurn
    ? createInteractiveTurnController({
      initialMessages,
      initialHistorySummary,
      runTurn,
      onUpdate(nextSnapshot) {
        setSnapshot(nextSnapshot);
      },
      onTurnSettled
    })
    : undefined);
  const sessions = useMemo<ChatSessionRecord[]>(() => [{
    sessionId: 'current',
    title: 'New Chat',
    provider: runtime.provider.name === 'anthropic' ? 'anthropic' : 'openai',
    model: runtime.provider.model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }], [runtime.provider.model, runtime.provider.name]);

  const handleSubmit = async (value: string) => {
    if (!controller) {
      return;
    }

    const nextDraft = value.trim();
    if (nextDraft.length === 0 || snapshot.composerLocked) {
      return;
    }

    await controller.submitTurn(nextDraft);
  };

  return (
    <Box flexDirection="column" height={process.stdout.rows ? process.stdout.rows - 1 : undefined}>
      <Box flexGrow={1}>
        <Sidebar sessions={sessions} activeSessionId="current" />
        <ChatPane messages={snapshot.messages} toolActivities={snapshot.toolActivities} />
      </Box>
      <Box flexDirection="column">
        <Composer value={snapshot.draft} onChange={(value) => controller?.setDraft(value)} onSubmit={handleSubmit} isDisabled={snapshot.isThinking} />
        <StatusBar
          model={runtime.provider.model}
          usage={snapshot.latestUsage}
          statusText={snapshot.statusText}
          toolCount={snapshot.toolActivities.length}
        />
      </Box>
    </Box>
  );
}
