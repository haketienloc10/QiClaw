import React from 'react';
import { render } from 'ink';

import { runAgentTurnStream, type RunAgentTurnInput } from '../agent/loop.js';
import type { AgentRuntime } from '../agent/runtime.js';
import type { CheckpointStore } from '../session/checkpointStore.js';
import { createInteractiveCheckpointJson } from '../session/session.js';
import type { CliRunTurnResult } from '../cli/main.js';
import App, { type AppProps, type AppRunTurnInput } from './App.js';

export interface RunInteractiveAppInput {
  runtime: AgentRuntime;
  checkpointStore: CheckpointStore;
  sessionId: string;
  history: RunAgentTurnInput['history'];
  historySummary?: string;
  executeTurn: (input: RunAgentTurnInput & { sessionId?: string }) => Promise<CliRunTurnResult>;
  flushPendingFooter(): void;
}

export function createInteractiveAppProps(input: RunInteractiveAppInput): AppProps {
  const runTurn = async (turnInput: AppRunTurnInput): Promise<CliRunTurnResult> => {
    const result = input.runtime.provider.generateStream
      ? await runAgentTurnStream({
        provider: input.runtime.provider,
        availableTools: input.runtime.availableTools,
        baseSystemPrompt: input.runtime.systemPrompt,
        userInput: turnInput.userInput,
        cwd: input.runtime.cwd,
        maxToolRounds: input.runtime.maxToolRounds,
        agentSpec: input.runtime.agentSpec,
        observer: input.runtime.observer,
        history: turnInput.history,
        historySummary: turnInput.historySummary,
        onEvent: turnInput.onEvent
      }).then((streamResult) => ({
        ...streamResult,
        historySummary: turnInput.historySummary
      }))
      : await input.executeTurn({
        provider: input.runtime.provider,
        availableTools: input.runtime.availableTools,
        baseSystemPrompt: input.runtime.systemPrompt,
        userInput: turnInput.userInput,
        cwd: input.runtime.cwd,
        maxToolRounds: input.runtime.maxToolRounds,
        history: turnInput.history,
        historySummary: turnInput.historySummary,
        sessionId: input.sessionId
      });

    input.checkpointStore.save({
      sessionId: input.sessionId,
      taskId: 'interactive',
      status: 'completed',
      checkpointJson: createInteractiveCheckpointJson({
        version: 1,
        history: result.history,
        historySummary: result.historySummary
      })
    });

    return result;
  };

  return {
    runtime: input.runtime,
    initialMessages: input.history,
    initialHistorySummary: input.historySummary,
    runTurn,
    onTurnSettled() {
      input.flushPendingFooter();
    }
  };
}

export async function runInteractiveApp(input: RunInteractiveAppInput): Promise<number> {
  const appProps = createInteractiveAppProps(input);
  const instance = render(React.createElement(App, appProps));
  await instance.waitUntilExit();
  return 0;
}
