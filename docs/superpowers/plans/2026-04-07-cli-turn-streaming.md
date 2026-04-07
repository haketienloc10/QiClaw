# CLI Turn Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm interactive CLI/REPL stream được assistant text theo thời gian thực và hiển thị live tool activity, trong khi vẫn giữ final answer parity với luồng `runAgentTurn()` hiện tại.

**Architecture:** Giữ `provider.stream()` làm primitive ở provider layer và thêm `runAgentTurnStream()` ở agent loop để phát `TurnEvent`. `runAgentTurn()` sẽ collect từ cùng luồng turn event này để giữ một semantic model duy nhất cho cả live rendering lẫn final result. CLI/REPL chỉ render từ `TurnEvent`, không consume provider event thô.

**Tech Stack:** TypeScript, Node.js, Vitest, existing agent loop/runtime, existing CLI REPL and telemetry observers.

---

## File structure

- `src/agent/loop.ts`
  - Thêm `TurnEvent`, `runAgentTurnStream()`, và helper collect turn stream thành `RunAgentTurnResult`.
  - Giữ telemetry hiện có nhưng phát thêm live turn events từ cùng vòng lặp tool/provider.
- `src/cli/repl.ts`
  - Mở rộng REPL contract để forward `TurnEvent` trong lúc chờ kết quả cuối.
  - Vẫn trả `ReplTurnResult` để không phá caller hiện có.
- `src/cli/main.ts`
  - Đổi interactive/compact CLI sang consume turn stream.
  - Bổ sung writer API nhỏ cho incremental assistant text và live tool activity.
- `tests/agent/loop.test.ts`
  - Thêm regression tests cho `runAgentTurnStream()` và parity với `runAgentTurn()`.
- `tests/cli/repl.test.ts`
  - Thêm tests cho REPL/CLI render text delta và tool activity live.

Nếu `TurnEvent` làm `src/agent/loop.ts` quá dài, tách type sang `src/agent/turnEvents.ts`. Trong plan này mặc định giữ trong `src/agent/loop.ts` để giảm scope tạo file mới.

### Task 1: Add turn-level streaming contract in the agent loop

**Files:**
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing test for streamed assistant text and final parity**

Add this test to `tests/agent/loop.test.ts`:

```ts
it('streams assistant text deltas and preserves final answer parity', async () => {
  const provider = {
    name: 'openai',
    model: 'gpt-test',
    async *stream() {
      yield { type: 'start' as const, provider: 'openai', model: 'gpt-test' };
      yield { type: 'text_delta' as const, text: 'Hello' };
      yield { type: 'text_delta' as const, text: ' world' };
      yield {
        type: 'finish' as const,
        finish: { stopReason: 'stop' },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
      };
    },
    async generate() {
      throw new Error('runAgentTurn should collect from stream in this test');
    }
  };

  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of runAgentTurnStream({
    provider,
    availableTools: [],
    baseSystemPrompt: 'system',
    userInput: 'say hi',
    cwd: process.cwd(),
    maxToolRounds: 1
  })) {
    events.push(event as { type: string; [key: string]: unknown });
  }

  expect(events).toEqual([
    { type: 'turn_started' },
    { type: 'provider_started', provider: 'openai', model: 'gpt-test' },
    { type: 'assistant_text_delta', text: 'Hello' },
    { type: 'assistant_text_delta', text: ' world' },
    { type: 'assistant_message_completed', text: 'Hello world', toolCalls: undefined },
    { type: 'turn_completed', finalAnswer: 'Hello world', stopReason: 'completed' }
  ]);

  const result = await runAgentTurn({
    provider,
    availableTools: [],
    baseSystemPrompt: 'system',
    userInput: 'say hi',
    cwd: process.cwd(),
    maxToolRounds: 1
  });

  expect(result.finalAnswer).toBe('Hello world');
  expect(result.stopReason).toBe('completed');
});
```

- [ ] **Step 2: Run the focused agent loop test to verify it fails**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: FAIL with `runAgentTurnStream is not defined` or missing `TurnEvent`/stream-path behavior.

- [ ] **Step 3: Write the minimal turn stream contract in `src/agent/loop.ts`**

Add these types and collector helpers near the top of `src/agent/loop.ts` after `RunAgentTurnResult`:

```ts
export type TurnEvent =
  | { type: 'turn_started' }
  | { type: 'provider_started'; provider: string; model: string }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'tool_call_started'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_completed'; id: string; name: string; resultPreview: string; isError: boolean }
  | { type: 'assistant_message_completed'; text: string; toolCalls?: ToolCallRequest[] }
  | { type: 'turn_completed'; finalAnswer: string; stopReason: AgentTurnStopReason }
  | { type: 'turn_failed'; error: unknown };

interface CollectedTurnState {
  stopReason: AgentTurnStopReason;
  finalAnswer: string;
}

async function collectCompletedTurn(stream: AsyncIterable<TurnEvent>): Promise<CollectedTurnState> {
  let terminal: CollectedTurnState | undefined;

  for await (const event of stream) {
    if (event.type === 'turn_completed') {
      terminal = {
        stopReason: event.stopReason,
        finalAnswer: event.finalAnswer
      };
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
```

Then add the streamed primitive and refactor `runAgentTurn()` to collect from it:

```ts
export async function* runAgentTurnStream(input: RunAgentTurnInput): AsyncIterable<TurnEvent> {
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
      const response = await withProviderTimeout(
        collectProviderResponse(input.provider, prompt.messages, input.availableTools),
        getProviderTimeoutMs(),
        input.provider.name
      );

      history.push(response.message);
      finalAnswer = response.message.content;

      yield { type: 'provider_started', provider: input.provider.name, model: input.provider.model };
      if (response.message.content.length > 0) {
        yield { type: 'assistant_text_delta', text: response.message.content };
      }
      yield {
        type: 'assistant_message_completed',
        text: response.message.content,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined
      };

      if (response.toolCalls.length === 0) {
        yield { type: 'turn_completed', finalAnswer, stopReason: 'completed' };
        return;
      }

      if (toolRoundsUsed >= input.maxToolRounds) {
        yield { type: 'turn_completed', finalAnswer, stopReason: 'max_tool_rounds_reached' };
        return;
      }

      toolRoundsUsed += 1;

      for (const toolCall of response.toolCalls) {
        yield {
          type: 'tool_call_started',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input
        };

        const toolResult = truncateToolResultMessage(
          await dispatchAllowedToolCall(toolCall, input.availableTools, input.cwd),
          MAX_TOOL_RESULT_CONTENT_CHARS
        );
        history.push(toolResult);

        yield {
          type: 'tool_call_completed',
          id: toolCall.id,
          name: toolCall.name,
          resultPreview: buildTelemetryPreview({ content: toolResult.content }, 120),
          isError: toolResult.isError
        };
      }
    }
  } catch (error) {
    yield { type: 'turn_failed', error };
    throw error;
  }
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const observer = input.observer ?? createNoopObserver();
  const history: Message[] = [...(input.history ?? []), { role: 'user', content: input.userInput }];
  const doneCriteria = buildDoneCriteria(input.userInput, input.agentSpec?.completion);
  const collected = await collectCompletedTurn(runAgentTurnStream(input));

  return buildResult(
    observer,
    {
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
    },
    collected.stopReason,
    collected.finalAnswer,
    history,
    0,
    doneCriteria,
    collected.stopReason === 'completed',
    input.maxToolRounds
  );
}
```

Also add this helper above `runAgentTurnStream()`:

```ts
async function collectProviderResponse(
  provider: ModelProvider,
  messages: Message[],
  availableTools: Tool[]
): Promise<ProviderResponse> {
  return provider.generate({ messages, availableTools });
}
```

- [ ] **Step 4: Run the focused agent loop test to verify it passes**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: PASS for the new test.

- [ ] **Step 5: Commit the loop streaming contract**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: add turn stream contract"
```

### Task 2: Stream provider deltas and tool lifecycle from the loop

**Files:**
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing test for provider delta mapping and tool lifecycle**

Add this test to `tests/agent/loop.test.ts`:

```ts
it('emits provider text deltas and tool lifecycle events in order', async () => {
  const provider = {
    name: 'openai',
    model: 'gpt-test',
    async *stream() {
      yield { type: 'start' as const, provider: 'openai', model: 'gpt-test' };
      yield {
        type: 'tool_call' as const,
        id: 'call_1',
        name: 'echo',
        input: { text: 'hello' }
      };
      yield {
        type: 'finish' as const,
        finish: { stopReason: 'tool_use' },
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }
      };
    },
    async generate() {
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'call_1', name: 'echo', input: { text: 'hello' } }]
        },
        toolCalls: [{ id: 'call_1', name: 'echo', input: { text: 'hello' } }],
        finish: { stopReason: 'tool_use' }
      };
    }
  };

  const tool = {
    name: 'echo',
    description: 'Echo text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    async execute(input: Record<string, unknown>) {
      return { content: [{ type: 'text', text: String(input.text) }] };
    }
  };

  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of runAgentTurnStream({
    provider,
    availableTools: [tool],
    baseSystemPrompt: 'system',
    userInput: 'use tool',
    cwd: process.cwd(),
    maxToolRounds: 1
  })) {
    events.push(event as { type: string; [key: string]: unknown });
  }

  expect(events).toContainEqual({
    type: 'tool_call_started',
    id: 'call_1',
    name: 'echo',
    input: { text: 'hello' }
  });

  expect(events).toContainEqual(expect.objectContaining({
    type: 'tool_call_completed',
    id: 'call_1',
    name: 'echo',
    isError: false
  }));
});
```

- [ ] **Step 2: Run the focused loop test to verify it fails**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: FAIL because `runAgentTurnStream()` still emits only assembled final text and does not map provider/tool lifecycle correctly.

- [ ] **Step 3: Refactor `runAgentTurnStream()` to consume provider stream as source of truth**

Replace the `collectProviderResponse(...)` helper with these two helpers in `src/agent/loop.ts`:

```ts
async function collectProviderStreamRound(
  provider: ModelProvider,
  messages: Message[],
  availableTools: Tool[]
): Promise<ProviderResponse> {
  const stream = provider.stream({ messages, availableTools });
  return collectProviderStream(stream);
}

async function* readProviderRoundEvents(
  provider: ModelProvider,
  messages: Message[],
  availableTools: Tool[]
): AsyncIterable<NormalizedEvent> {
  for await (const event of provider.stream({ messages, availableTools })) {
    yield event;
  }
}
```

Update imports at the top of `src/agent/loop.ts`:

```ts
import {
  collectProviderStream,
  toToolErrorMessage,
  toToolResultMessage,
  type ModelProvider,
  type NormalizedEvent,
  type ProviderResponse,
  type ProviderUsageSummary,
  type ToolCallRequest,
  type ToolResultMessage
} from '../provider/model.js';
```

Then replace the provider call section inside `runAgentTurnStream()` with this streaming round logic:

```ts
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
        createTelemetryEvent('provider_called', 'provider_decision', {
          ...buildTurnContext(telemetry),
          ...promptTelemetry
        })
      );

      const providerStartedAt = Date.now();
      const providerEvents: NormalizedEvent[] = [];
      let providerStart: { provider: string; model: string } | undefined;
      let messageText = '';
      let roundToolCalls: ToolCallRequest[] = [];

      for await (const event of readProviderRoundEvents(input.provider, prompt.messages, input.availableTools)) {
        providerEvents.push(event);

        if (event.type === 'start') {
          providerStart = { provider: event.provider, model: event.model };
          yield { type: 'provider_started', provider: event.provider, model: event.model };
          continue;
        }

        if (event.type === 'text_delta') {
          messageText += event.text;
          yield { type: 'assistant_text_delta', text: event.text };
          continue;
        }

        if (event.type === 'tool_call') {
          roundToolCalls = [...roundToolCalls, { id: event.id, name: event.name, input: event.input }];
          yield {
            type: 'tool_call_started',
            id: event.id,
            name: event.name,
            input: event.input
          };
        }
      }

      const response = await withProviderTimeout(
        collectProviderStream((async function* () {
          for (const event of providerEvents) {
            yield event;
          }
        })()),
        getProviderTimeoutMs(),
        input.provider.name
      );

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
        text: messageText,
        toolCalls: roundToolCalls.length > 0 ? roundToolCalls : undefined
      };
```

Keep the existing tool dispatch loop, but leave `tool_call_started` emission in the provider event loop and emit only `tool_call_completed` after execution.

- [ ] **Step 4: Run the focused loop test to verify it passes**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: PASS for the new lifecycle test.

- [ ] **Step 5: Commit the provider-to-turn event mapping**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: stream provider rounds through turn events"
```

### Task 3: Preserve non-stream result parity by collecting turn events

**Files:**
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: Write the failing test for `runAgentTurn()` collecting from `runAgentTurnStream()`**

Add this test to `tests/agent/loop.test.ts`:

```ts
it('keeps runAgentTurn in parity with collected turn stream output', async () => {
  const provider = {
    name: 'openai',
    model: 'gpt-test',
    async *stream() {
      yield { type: 'start' as const, provider: 'openai', model: 'gpt-test' };
      yield { type: 'text_delta' as const, text: 'Final answer' };
      yield {
        type: 'finish' as const,
        finish: { stopReason: 'stop' },
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
      };
    },
    async generate() {
      throw new Error('turn parity test should not use generate directly');
    }
  };

  let streamedFinalAnswer = '';
  let streamedStopReason: string | undefined;

  for await (const event of runAgentTurnStream({
    provider,
    availableTools: [],
    baseSystemPrompt: 'system',
    userInput: 'answer',
    cwd: process.cwd(),
    maxToolRounds: 1
  })) {
    if (event.type === 'turn_completed') {
      streamedFinalAnswer = event.finalAnswer;
      streamedStopReason = event.stopReason;
    }
  }

  const result = await runAgentTurn({
    provider,
    availableTools: [],
    baseSystemPrompt: 'system',
    userInput: 'answer',
    cwd: process.cwd(),
    maxToolRounds: 1
  });

  expect(result.finalAnswer).toBe(streamedFinalAnswer);
  expect(result.stopReason).toBe(streamedStopReason);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: FAIL because `runAgentTurn()` still rebuilds result from separate state instead of collecting the turn stream output end-to-end.

- [ ] **Step 3: Implement a real collector from `runAgentTurnStream()` to `RunAgentTurnResult`**

In `src/agent/loop.ts`, replace the temporary `collectCompletedTurn()` with this collector:

```ts
interface CollectedTurnResult {
  stopReason: AgentTurnStopReason;
  finalAnswer: string;
  history: Message[];
  toolRoundsUsed: number;
  doneCriteria: DoneCriteria;
  turnCompleted: boolean;
}

async function collectTurnResult(
  stream: AsyncIterable<TurnEvent>,
  state: {
    history: Message[];
    doneCriteria: DoneCriteria;
    toolRoundsUsed: number;
  }
): Promise<CollectedTurnResult> {
  let terminal: CollectedTurnResult | undefined;

  for await (const event of stream) {
    if (event.type === 'turn_completed') {
      terminal = {
        stopReason: event.stopReason,
        finalAnswer: event.finalAnswer,
        history: state.history,
        toolRoundsUsed: state.toolRoundsUsed,
        doneCriteria: state.doneCriteria,
        turnCompleted: event.stopReason === 'completed'
      };
      continue;
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
```

Change `runAgentTurn()` to:

```ts
export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const observer = input.observer ?? createNoopObserver();
  const history: Message[] = [...(input.history ?? []), { role: 'user', content: input.userInput }];
  const doneCriteria = buildDoneCriteria(input.userInput, input.agentSpec?.completion);
  const telemetry: TurnTelemetryState = {
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

  const collected = await collectTurnResult(runAgentTurnStream(input), {
    history,
    doneCriteria,
    toolRoundsUsed: 0
  });

  return buildResult(
    observer,
    telemetry,
    collected.stopReason,
    collected.finalAnswer,
    collected.history,
    collected.toolRoundsUsed,
    collected.doneCriteria,
    collected.turnCompleted,
    input.maxToolRounds
  );
}
```

Update `runAgentTurnStream()` so it mutates the shared `history` and `toolRoundsUsed` state that `collectTurnResult()` reads, rather than recreating disconnected local state objects.

- [ ] **Step 4: Run the focused parity test to verify it passes**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: PASS for the new parity test.

- [ ] **Step 5: Commit the parity-preserving collector**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "refactor: collect final turn result from stream"
```

### Task 4: Forward turn events through the REPL contract

**Files:**
- Modify: `src/cli/repl.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing REPL test for live turn events**

Add this test to `tests/cli/repl.test.ts`:

```ts
it('forwards turn events before returning the final repl result', async () => {
  const seen: string[] = [];
  const repl = createRepl({
    promptLabel: '> ',
    async runTurn() {
      return {
        finalAnswer: 'Hello world',
        stopReason: 'completed',
        toolRoundsUsed: 0,
        verification: {
          isVerified: true,
          toolMessagesCount: 0
        },
        turnStream: (async function* () {
          yield { type: 'turn_started' as const };
          yield { type: 'assistant_text_delta' as const, text: 'Hello' };
          yield { type: 'assistant_text_delta' as const, text: ' world' };
          yield { type: 'turn_completed' as const, finalAnswer: 'Hello world', stopReason: 'completed' as const };
        })()
      };
    },
    onTurnEvent(event) {
      seen.push(event.type);
    }
  });

  const result = await repl.runOnce('hi');

  expect(seen).toEqual(['turn_started', 'assistant_text_delta', 'assistant_text_delta', 'turn_completed']);
  expect(result.finalAnswer).toBe('Hello world');
});
```

- [ ] **Step 2: Run the focused REPL test to verify it fails**

Run:

```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: FAIL because `CreateReplOptions` has no `onTurnEvent` or streamed turn result support.

- [ ] **Step 3: Extend `src/cli/repl.ts` for turn event forwarding**

Update the import and option contract in `src/cli/repl.ts`:

```ts
import type { AgentTurnStopReason, RunAgentTurnResult, TurnEvent } from '../agent/loop.js';
```

Change `CreateReplOptions` to:

```ts
export interface CreateReplOptions {
  promptLabel: string;
  multilinePromptLabel?: string;
  startupLines?: string[];
  helpText?: string;
  multilineNoticeText?: string;
  multilineDiscardedText?: string;
  runTurn(input: string): Promise<Pick<RunAgentTurnResult, 'finalAnswer' | 'stopReason' | 'toolRoundsUsed' | 'verification'> & {
    turnStream?: AsyncIterable<TurnEvent>;
  }>;
  onTurnEvent?(event: TurnEvent): void | Promise<void>;
  readLine?(promptLabel: string): Promise<string | undefined>;
  writeLine?(text: string): void;
  renderFinalAnswer?(text: string): void;
  afterTurnRendered?(): void;
}
```

Add this helper before `return { ... }` inside `createRepl()`:

```ts
  async function forwardTurnEvents(turnStream?: AsyncIterable<TurnEvent>): Promise<void> {
    if (!turnStream || !options.onTurnEvent) {
      return;
    }

    for await (const event of turnStream) {
      await options.onTurnEvent(event);
    }
  }
```

Change `runOnce()` to:

```ts
    async runOnce(input: string): Promise<ReplTurnResult> {
      const result = await options.runTurn(input);
      await forwardTurnEvents(result.turnStream);

      return {
        finalAnswer: result.finalAnswer,
        stopReason: result.stopReason
      };
    },
```

- [ ] **Step 4: Run the focused REPL test to verify it passes**

Run:

```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: PASS for the new event-forwarding test.

- [ ] **Step 5: Commit the REPL forwarding change**

```bash
git add src/cli/repl.ts tests/cli/repl.test.ts
git commit -m "feat: forward turn events through repl"
```

### Task 5: Render live text and tool activity in the CLI

**Files:**
- Modify: `src/cli/main.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing CLI test for live streamed text rendering**

Add this test to `tests/cli/repl.test.ts`:

```ts
it('renders assistant text deltas live in prompt mode', async () => {
  const writes: string[] = [];
  const cli = buildCli({
    argv: ['--prompt', 'hello'],
    stdout: { write(text: string) { writes.push(text); return true; } },
    stderr: { write() { return true; } },
    createRuntime() {
      return {
        cwd: process.cwd(),
        provider: { name: 'openai', model: 'gpt-test', generate: async () => { throw new Error('unused'); }, stream: async function* () {} },
        availableTools: [],
        systemPrompt: 'system',
        maxToolRounds: 1,
        agentSpec: undefined,
        observer: undefined
      } as never;
    },
    async runTurn() {
      return {
        finalAnswer: 'Hello world',
        stopReason: 'completed',
        toolRoundsUsed: 0,
        verification: { isVerified: true, toolMessagesCount: 0 },
        turnStream: (async function* () {
          yield { type: 'turn_started' as const };
          yield { type: 'provider_started' as const, provider: 'openai', model: 'gpt-test' };
          yield { type: 'assistant_text_delta' as const, text: 'Hello' };
          yield { type: 'assistant_text_delta' as const, text: ' world' };
          yield { type: 'assistant_message_completed' as const, text: 'Hello world', toolCalls: undefined };
          yield { type: 'turn_completed' as const, finalAnswer: 'Hello world', stopReason: 'completed' as const };
        })()
      };
    }
  });

  await cli.run();

  expect(writes.join('')).toContain('Hello');
  expect(writes.join('')).toContain(' world');
});
```

- [ ] **Step 2: Run the focused CLI test to verify it fails**

Run:

```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: FAIL because CLI still renders only `renderFinalAnswer(result.finalAnswer)` after the turn completes.

- [ ] **Step 3: Add incremental text rendering and turn stream consumption in `src/cli/main.ts`**

First extend `AssistantBlockWriter` in `src/cli/main.ts`:

```ts
interface AssistantBlockWriter {
  startProviderThinking(): void;
  markResponding(): void;
  writeAssistantLine(text: string, toolCallId?: string): void;
  writeAssistantLineBelow(toolCallId: string, text: string): void;
  replaceAssistantLine(toolCallId: string, text: string): void;
  appendAssistantTextDelta(text: string): void;
  finishAssistantTextBlock(): void;
  writeAssistantTextBlock(text: string): void;
  writeFooterLine(text: string): void;
  resetTurn(): void;
}
```

Inside `createAssistantBlockWriter(...)`, add incremental text state near the existing local state:

```ts
  let streamedAssistantText = '';
  let hasOpenTextBlock = false;
```

Add these helpers before `return { ... }`:

```ts
  function renderTextLine(line: string): void {
    if (mode === 'interactive') {
      write(`${line}\n`);
      return;
    }

    write(`  ${line}\n`);
  }

  function openTextBlockIfNeeded(): void {
    ensureTurnPrelude();
    ensureRespondingStatus();

    if (hasOpenTextBlock) {
      return;
    }

    activeActivityLineCount = 0;
    if (mode === 'interactive') {
      write(`${pc.dim('─'.repeat(54))}\n`);
      write('\n');
    }
    hasOpenTextBlock = true;
  }
```

Add these methods to the returned writer object:

```ts
    appendAssistantTextDelta(text: string) {
      openTextBlockIfNeeded();
      streamedAssistantText += text;

      const lines = streamedAssistantText.split('\n');
      const latestLine = lines[lines.length - 1] ?? '';

      if (text.includes('\n')) {
        const stableLines = lines.slice(0, -1);
        for (const line of stableLines.slice(-text.split('\n').length + 1)) {
          renderTextLine(line);
        }
        return;
      }

      if (latestLine.length > 0) {
        renderTextLine(latestLine);
      }
    },
    finishAssistantTextBlock() {
      if (!hasOpenTextBlock) {
        return;
      }

      providerStatus = undefined;
      hasOpenTextBlock = false;
    },
```

Reset the new state in `resetTurn()`:

```ts
      streamedAssistantText = '';
      hasOpenTextBlock = false;
```

Then add a turn-event renderer helper above `return { async run() { ... } }` in `buildCli()`:

```ts
  async function renderTurnEvent(event: import('../agent/loop.js').TurnEvent): Promise<void> {
    if (!assistantBlockWriter) {
      return;
    }

    if (event.type === 'provider_started') {
      assistantBlockWriter.startProviderThinking();
      return;
    }

    if (event.type === 'assistant_text_delta') {
      assistantBlockWriter.markResponding();
      assistantBlockWriter.appendAssistantTextDelta(event.text);
      return;
    }

    if (event.type === 'assistant_message_completed') {
      assistantBlockWriter.finishAssistantTextBlock();
    }
  }
```

Update both `createRepl(...)` call sites to pass `onTurnEvent: renderTurnEvent`.

Update the `runTurn` adapters in both prompt and interactive modes so they return `turnStream` from `runAgentTurnStream(...)` when `options.runTurn` is not provided. In `buildCli()`, replace the existing `executeTurn` assignment with:

```ts
  const executeTurn: (input: CliRunTurnInput) => Promise<CliRunTurnResult & { turnStream?: AsyncIterable<import('../agent/loop.js').TurnEvent> }> = options.runTurn
    ? options.runTurn
    : async ({ sessionId: _sessionId, ...input }) => {
        const turnStream = runAgentTurnStream(input);
        const result = await runAgentTurn(input);
        return {
          ...result,
          turnStream
        };
      };
```

Finally, remove the duplicate final-answer-only render in prompt mode and interactive mode when a `turnStream` already rendered the assistant text:

```ts
          const result = await repl.runOnce(parsed.prompt);
          if (!result.finalAnswer.length) {
            assistantBlockWriter?.writeAssistantTextBlock(result.finalAnswer);
          }
```

and similarly avoid unconditional `renderFinalAnswer(result.finalAnswer)` in `createRepl().runInteractive()` by checking whether a stream was already forwarded.

- [ ] **Step 4: Run the focused CLI test to verify it passes**

Run:

```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: PASS for the live text rendering test.

- [ ] **Step 5: Commit the CLI live rendering path**

```bash
git add src/cli/main.ts src/cli/repl.ts tests/cli/repl.test.ts
git commit -m "feat: render turn stream live in cli"
```

### Task 6: Render live tool activity from turn events

**Files:**
- Modify: `src/cli/main.ts`
- Test: `tests/cli/repl.test.ts`

- [ ] **Step 1: Write the failing CLI test for live tool activity**

Add this test to `tests/cli/repl.test.ts`:

```ts
it('renders tool activity from turn events in interactive mode', async () => {
  const writes: string[] = [];
  const cli = buildCli({
    argv: [],
    stdout: { write(text: string) { writes.push(text); return true; }, isTTY: false },
    stderr: { write() { return true; } },
    readLine: vi.fn().mockResolvedValueOnce('run tool').mockResolvedValueOnce('/exit'),
    createRuntime() {
      return {
        cwd: process.cwd(),
        provider: { name: 'openai', model: 'gpt-test', generate: async () => { throw new Error('unused'); }, stream: async function* () {} },
        availableTools: [],
        systemPrompt: 'system',
        maxToolRounds: 1,
        agentSpec: undefined,
        observer: undefined
      } as never;
    },
    async runTurn() {
      return {
        finalAnswer: 'done',
        stopReason: 'completed',
        toolRoundsUsed: 1,
        verification: { isVerified: true, toolMessagesCount: 1 },
        turnStream: (async function* () {
          yield { type: 'turn_started' as const };
          yield { type: 'provider_started' as const, provider: 'openai', model: 'gpt-test' };
          yield { type: 'tool_call_started' as const, id: 'call_1', name: 'search', input: { query: 'x' } };
          yield { type: 'tool_call_completed' as const, id: 'call_1', name: 'search', resultPreview: 'found 1 result', isError: false };
          yield { type: 'assistant_message_completed' as const, text: 'done', toolCalls: undefined };
          yield { type: 'turn_completed' as const, finalAnswer: 'done', stopReason: 'completed' as const };
        })()
      };
    }
  });

  await cli.run();

  const output = writes.join('');
  expect(output).toContain('search');
  expect(output).toContain('found 1 result');
});
```

- [ ] **Step 2: Run the focused CLI test to verify it fails**

Run:

```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: FAIL because CLI observer currently only reacts to telemetry events, not direct turn stream tool events.

- [ ] **Step 3: Render tool lifecycle directly from `TurnEvent` in `src/cli/main.ts`**

Extend the `renderTurnEvent(...)` helper from Task 5 with these branches:

```ts
    if (event.type === 'tool_call_started') {
      assistantBlockWriter.markResponding();
      assistantBlockWriter.writeAssistantLine(`→ ${event.name}`, event.id);
      return;
    }

    if (event.type === 'tool_call_completed') {
      const suffix = event.isError ? `error: ${event.resultPreview}` : event.resultPreview;
      assistantBlockWriter.replaceAssistantLine(event.id, `✓ ${event.name}`);
      assistantBlockWriter.writeAssistantLineBelow(event.id, `  ${suffix}`);
      return;
    }

    if (event.type === 'turn_failed') {
      assistantBlockWriter.writeFooterLine(`Turn failed: ${formatCliError(event.error)}`);
    }
```

Keep the telemetry observer for metrics/debug logging, but make turn-event rendering the primary live UI path for text and tool activity.

- [ ] **Step 4: Run the focused CLI test to verify it passes**

Run:

```bash
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: PASS for the tool activity rendering test.

- [ ] **Step 5: Commit the tool activity rendering**

```bash
git add src/cli/main.ts tests/cli/repl.test.ts
git commit -m "feat: show live tool activity from turn events"
```

### Task 7: Verify invariants, parity, and full test/build health

**Files:**
- Modify: `tests/agent/loop.test.ts`
- Modify: `tests/cli/repl.test.ts`
- Modify: `src/agent/loop.ts` (only if test-driven fixes are needed)
- Modify: `src/cli/main.ts` (only if test-driven fixes are needed)
- Modify: `src/cli/repl.ts` (only if test-driven fixes are needed)

- [ ] **Step 1: Write the failing regression test for terminal event invariants**

Add this test to `tests/agent/loop.test.ts`:

```ts
it('fails when turn stream emits events after terminal completion', async () => {
  async function* invalidStream() {
    yield { type: 'turn_started' as const };
    yield { type: 'turn_completed' as const, finalAnswer: 'done', stopReason: 'completed' as const };
    yield { type: 'assistant_text_delta' as const, text: 'late' };
  }

  await expect(async () => {
    for await (const _event of invalidStream()) {
      // no-op
    }
  }).rejects.toThrow();
});
```

- [ ] **Step 2: Run the focused regression test to verify it fails**

Run:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
```

Expected: FAIL because there is no invariant guard yet for post-terminal turn events.

- [ ] **Step 3: Add invariant enforcement in the turn collector and run targeted suites**

In `src/agent/loop.ts`, harden `collectTurnResult(...)` with terminal checks:

```ts
async function collectTurnResult(
  stream: AsyncIterable<TurnEvent>,
  state: {
    history: Message[];
    doneCriteria: DoneCriteria;
    toolRoundsUsed: number;
  }
): Promise<CollectedTurnResult> {
  let terminal: CollectedTurnResult | undefined;
  let sawTerminal = false;

  for await (const event of stream) {
    if (sawTerminal) {
      throw new Error('Turn stream emitted events after terminal event.');
    }

    if (event.type === 'turn_completed') {
      terminal = {
        stopReason: event.stopReason,
        finalAnswer: event.finalAnswer,
        history: state.history,
        toolRoundsUsed: state.toolRoundsUsed,
        doneCriteria: state.doneCriteria,
        turnCompleted: event.stopReason === 'completed'
      };
      sawTerminal = true;
      continue;
    }

    if (event.type === 'turn_failed') {
      sawTerminal = true;
      throw event.error instanceof Error ? event.error : new Error(String(event.error));
    }
  }

  if (!terminal) {
    throw new Error('Turn stream ended without terminal event.');
  }

  return terminal;
}
```

Run targeted suites:

```bash
npm test -- tests/agent/loop.test.ts --runInBand
npm test -- tests/cli/repl.test.ts --runInBand
```

Expected: PASS for both suites.

- [ ] **Step 4: Run the full project test suite and build**

Run:

```bash
npm test
npm run build
```

Expected: all tests PASS, build PASS.

- [ ] **Step 5: Commit the final verification fixes**

```bash
git add src/agent/loop.ts src/cli/main.ts src/cli/repl.ts tests/agent/loop.test.ts tests/cli/repl.test.ts
git commit -m "test: verify cli turn streaming invariants"
```

## Self-review checklist

### Spec coverage
- Requirement stream assistant text live: covered by Tasks 2, 4, 5.
- Requirement live tool activity: covered by Tasks 2 and 6.
- Requirement final answer parity: covered by Tasks 1, 3, and 7.
- Requirement CLI only sees `TurnEvent`: covered by Tasks 4, 5, 6.
- Requirement provider contract unchanged: preserved by Tasks 2 and 3 using existing `provider.stream()`.
- Requirement fail-fast invariants: covered by Task 7.

### Placeholder scan
- Không dùng `TODO`, `TBD`, hay “write tests for above”.
- Mỗi task đều có code block, command cụ thể, và expected outcome.

### Type consistency
- `TurnEvent` dùng nhất quán giữa `src/agent/loop.ts`, `src/cli/repl.ts`, và `src/cli/main.ts`.
- `runAgentTurnStream()` là primitive chính; `runAgentTurn()` là collector wrapper trong toàn plan.
- `tool_call_started`/`tool_call_completed` naming giữ nhất quán với spec.
