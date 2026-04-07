# OpenAI Provider Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm streaming support ở mức provider nội bộ cho OpenAI bằng `AsyncIterable<NormalizedEvent>`, đồng thời bảo đảm `generate()` assemble final result từ cùng semantic model với `stream()`.

**Architecture:** Mở rộng provider contract trong `src/provider/model.ts` với event stream chuẩn hóa và helper `collectProviderStream()`. OpenAI provider ở `src/provider/openai.ts` sẽ là provider đầu tiên triển khai `stream()` thật bằng OpenAI Responses streaming API, còn `generate()` sẽ collect từ chính stream này để tránh drift giữa stream và non-stream. Anthropic tạm thời chỉ implement `stream()` bằng lỗi rõ ràng để contract toàn hệ thống nhất quán.

**Tech Stack:** TypeScript, OpenAI Node SDK (`responses.create(... stream: true)`), AsyncIterable, Vitest.

---

## File map

- **Modify:** `src/provider/model.ts`
  - Thêm `NormalizedEvent`, method `stream()` vào `ModelProvider`, helper `collectProviderStream()`, và invariant checks cho event stream.
- **Modify:** `src/provider/openai.ts`
  - Tách request builder dùng chung cho stream/non-stream, thêm `stream()` normalize OpenAI stream events, đổi `generate()` sang collect từ `stream()`.
- **Modify:** `src/provider/anthropic.ts`
  - Thêm `stream()` throw lỗi rõ ràng `not supported yet`.
- **Modify:** `src/provider/factory.ts`
  - Cập nhật type nếu compiler yêu cầu.
- **Modify if needed for types only:** `src/agent/loop.ts`
  - Không đổi behavior; chỉ sửa nếu contract provider mới làm TypeScript báo lỗi.
- **Modify:** `tests/provider/openai.test.ts`
  - Thêm parity test xương sống cho `collectProviderStream(provider.stream(req))` và `provider.generate(req)`.

## Implementation notes

- `NormalizedEvent` invariants phải được code enforce:
  - `start` tối đa 1 lần.
  - `finish` và `error` loại trừ nhau; mỗi loại tối đa 1 lần.
  - Sau `finish` hoặc `error` không có event nào nữa.
  - `tool_call` chỉ emit khi parse được object hợp lệ.
- `tool_call.input` giữ là `Record<string, unknown>` vì `parseOpenAIToolArguments()` hiện đã yêu cầu object JSON.
- `error` dùng `unknown`, không ép `Error`.
- `collectProviderStream()` phải build đúng `ProviderResponse.message`, `toolCalls`, `finish`, `usage`, `responseMetrics`, `debug` từ một stream duy nhất.
- `generate()` ở OpenAI không được giữ một nhánh normalize riêng với `client.responses.create(... stream: false)`.
- Không mở rộng runtime để tiêu thụ streaming end-to-end trong plan này.

### Task 1: Mở rộng provider contract với normalized event stream

**Files:**
- Modify: `src/provider/model.ts`
- Reference: `src/provider/openai.ts`
- Reference: `src/provider/anthropic.ts`

- [ ] **Step 1: Viết failing test cho `collectProviderStream()` assemble text, tool calls, và finish metadata**

Thêm test mới ở cuối `tests/provider/openai.test.ts` để khóa semantic model trung tâm trước khi sửa production code.

```ts
describe('collectProviderStream', () => {
  it('assembles provider response from normalized events', async () => {
    const { collectProviderStream } = await import('../../src/provider/model.js');

    const stream = (async function* () {
      yield { type: 'start', provider: 'openai', model: 'gpt-4.1' } as const;
      yield { type: 'text_delta', text: 'Hello' } as const;
      yield { type: 'text_delta', text: ' world' } as const;
      yield {
        type: 'tool_call',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt' }
      } as const;
      yield {
        type: 'finish',
        finish: { stopReason: 'stop' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        responseMetrics: {
          contentBlockCount: 3,
          toolCallCount: 1,
          hasTextOutput: true,
          contentBlocksByType: { message: 1, function_call: 1, output_text: 2 }
        },
        debug: {
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responseContentBlocksByType: { message: 1, function_call: 1, output_text: 2 },
          responsePreviewRedacted: '[redacted]'
        }
      } as const;
    })();

    await expect(collectProviderStream(stream)).resolves.toEqual({
      message: {
        role: 'assistant',
        content: 'Hello world',
        toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'note.txt' } }]
      },
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'note.txt' } }],
      finish: { stopReason: 'stop' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      responseMetrics: {
        contentBlockCount: 3,
        toolCallCount: 1,
        hasTextOutput: true,
        contentBlocksByType: { message: 1, function_call: 1, output_text: 2 }
      },
      debug: {
        toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
        responseContentBlocksByType: { message: 1, function_call: 1, output_text: 2 },
        responsePreviewRedacted: '[redacted]'
      }
    });
  });
});
```

- [ ] **Step 2: Chạy test mới để xác nhận nó fail đúng lý do**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "assembles provider response from normalized events"
```

Expected: FAIL vì `collectProviderStream` chưa tồn tại trong `src/provider/model.ts`.

- [ ] **Step 3: Thêm các type mới vào `src/provider/model.ts`**

Chèn các type và contract sau ngay sau `ProviderResponseNormalizationInput` trong `src/provider/model.ts`.

```ts
export type NormalizedEvent =
  | { type: 'start'; provider: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'finish';
      finish?: ProviderFinishSummary;
      usage?: ProviderUsageSummary;
      responseMetrics?: ProviderResponseMetrics;
      debug?: ProviderDebugMetadata;
    }
  | { type: 'error'; error: unknown };

export interface ModelProvider {
  name: string;
  model: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest): AsyncIterable<NormalizedEvent>;
}
```

- [ ] **Step 4: Thêm helper `collectProviderStream()` với invariant checks tối thiểu**

Thêm helper mới dưới `normalizeProviderResponse()` trong `src/provider/model.ts`.

```ts
export async function collectProviderStream(
  stream: AsyncIterable<NormalizedEvent>
): Promise<ProviderResponse> {
  let sawStart = false;
  let sawTerminal = false;
  let finish: ProviderFinishSummary | undefined;
  let usage: ProviderUsageSummary | undefined;
  let responseMetrics: ProviderResponseMetrics | undefined;
  let debug: ProviderDebugMetadata | undefined;
  const textParts: string[] = [];
  const toolCalls: ToolCallRequest[] = [];

  for await (const event of stream) {
    if (sawTerminal) {
      throw new Error('Provider stream emitted events after terminal event.');
    }

    switch (event.type) {
      case 'start':
        if (sawStart) {
          throw new Error('Provider stream emitted more than one start event.');
        }
        sawStart = true;
        break;
      case 'text_delta':
        textParts.push(event.text);
        break;
      case 'tool_call':
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        break;
      case 'finish':
        sawTerminal = true;
        finish = event.finish;
        usage = event.usage;
        responseMetrics = event.responseMetrics;
        debug = event.debug;
        break;
      case 'error':
        sawTerminal = true;
        throw event.error instanceof Error
          ? event.error
          : new Error(`Provider stream failed: ${String(event.error)}`);
      default:
        throw new Error(`Unknown provider event type: ${String((event as { type?: unknown }).type)}`);
    }
  }

  if (!sawTerminal) {
    throw new Error('Provider stream ended without finish or error event.');
  }

  const content = textParts.join('');

  if (content.length === 0 && toolCalls.length === 0) {
    throw new Error('Provider stream contained no usable output.');
  }

  return normalizeProviderResponse({
    content,
    toolCalls,
    finish,
    usage,
    responseMetrics,
    debug
  });
}
```

- [ ] **Step 5: Chạy test helper để verify nó pass**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "assembles provider response from normalized events"
```

Expected: PASS.

- [ ] **Step 6: Chạy toàn bộ test file provider hiện có để bắt regression sớm**

Run:
```bash
npm test -- tests/provider/openai.test.ts
```

Expected: PASS toàn bộ test trong file.

### Task 2: Chuẩn bị OpenAI request builder dùng chung cho stream và non-stream

**Files:**
- Modify: `src/provider/openai.ts`
- Reference: `src/provider/model.ts`
- Test: `tests/provider/openai.test.ts`

- [ ] **Step 1: Viết failing test cho request builder stream giữ nguyên semantics với non-stream**

Thêm test mới cạnh `buildOpenAIResponsesRequest` tests trong `tests/provider/openai.test.ts`.

```ts
it('builds the same OpenAI request payload for stream and non-stream modes except the stream flag', () => {
  const base = {
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Inspect note.txt' }
    ],
    availableTools: [searchTool]
  };

  const nonStream = buildOpenAIResponsesRequest(base);
  const stream = buildOpenAIResponsesRequest({ ...base, stream: true });

  expect(stream).toEqual({
    ...nonStream,
    stream: true
  });
});
```

- [ ] **Step 2: Chạy test request builder mới và xác nhận nó fail**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "builds the same OpenAI request payload for stream and non-stream modes except the stream flag"
```

Expected: FAIL vì `buildOpenAIResponsesRequest()` chưa nhận tham số `stream`.

- [ ] **Step 3: Refactor `buildOpenAIResponsesRequest()` nhận cờ `stream` dùng chung**

Sửa signature và return type trong `src/provider/openai.ts`.

```ts
export interface BuildOpenAIResponsesRequestInput {
  model: string;
  messages: Message[];
  availableTools: Tool[];
  stream?: boolean;
}

export function buildOpenAIResponsesRequest(
  input: BuildOpenAIResponsesRequestInput
): ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming {
  const { instructions, conversation } = splitSystemPrompt(input.messages);

  return {
    model: input.model,
    stream: input.stream ?? false,
    instructions,
    input: conversation,
    tools: input.availableTools.map(toOpenAIFunctionTool)
  };
}
```

- [ ] **Step 4: Cập nhật import types cho OpenAI streaming request**

Ở đầu `src/provider/openai.ts`, mở rộng import type từ OpenAI responses module.

```ts
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
```

- [ ] **Step 5: Chạy hai test request builder để verify pass**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "buildOpenAIResponsesRequest"
```

Expected: PASS, gồm cả test cũ và test stream flag mới.

### Task 3: Thêm OpenAI event normalization helpers cho stream path

**Files:**
- Modify: `src/provider/openai.ts`
- Test: `tests/provider/openai.test.ts`

- [ ] **Step 1: Viết failing test cho helper chuyển OpenAI output array thành normalized events**

Thêm test mới để khóa mapping semantic từ OpenAI response cuối sang event stream trước khi xử lý raw stream event phức tạp.

```ts
describe('toOpenAINormalizedEventsFromResponse', () => {
  it('converts final OpenAI response payload into normalized events', () => {
    const response = {
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'completed',
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 48 }
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"note.txt"}'
        }
      ]
    };

    expect(toOpenAINormalizedEventsFromResponse(response)).toEqual([
      { type: 'start', provider: 'openai', model: 'gpt-4.1-mini' },
      { type: 'text_delta', text: 'Hello world' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'note.txt' } },
      {
        type: 'finish',
        finish: { stopReason: undefined },
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, cacheReadInputTokens: 48 },
        responseMetrics: {
          contentBlockCount: 2,
          toolCallCount: 1,
          hasTextOutput: true,
          contentBlocksByType: { message: 1, function_call: 1, output_text: 1 }
        },
        debug: {
          providerUsageRawRedacted: {
            input_tokens: 80,
            output_tokens: 20,
            total_tokens: 100,
            prompt_tokens_details: { cached_tokens: 48 }
          },
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responseContentBlocksByType: { message: 1, function_call: 1, output_text: 1 },
          responsePreviewRedacted: expect.any(String)
        }
      }
    ]);
  });
});
```

- [ ] **Step 2: Chạy test helper event mapping và xác nhận nó fail**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "converts final OpenAI response payload into normalized events"
```

Expected: FAIL vì `toOpenAINormalizedEventsFromResponse` chưa tồn tại.

- [ ] **Step 3: Thêm helper normalize từ final OpenAI response sang event list**

Trong `src/provider/openai.ts`, thêm helper mới dưới `normalizeOpenAIResponseMetadata()`.

```ts
export function toOpenAINormalizedEventsFromResponse(response: {
  id: string;
  model: string;
  status?: string | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    total_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
  output: unknown[];
  incomplete_details?: { reason?: string | null } | null;
}): NormalizedEvent[] {
  const metadata = normalizeOpenAIResponseMetadata(response);
  const events: NormalizedEvent[] = [
    { type: 'start', provider: 'openai', model: response.model }
  ];

  const text = readOpenAITextContent(response.output);
  if (text.length > 0) {
    events.push({ type: 'text_delta', text });
  }

  for (const toolCall of extractOpenAIToolCalls(response.output)) {
    events.push({
      type: 'tool_call',
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input as Record<string, unknown>
    });
  }

  events.push({
    type: 'finish',
    finish: metadata.finish,
    usage: metadata.usage,
    responseMetrics: metadata.responseMetrics,
    debug: metadata.debug
  });

  return events;
}
```

- [ ] **Step 4: Chạy test helper để verify pass**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "converts final OpenAI response payload into normalized events"
```

Expected: PASS.

- [ ] **Step 5: Chạy full test file để verify helper mới không làm vỡ logic hiện có**

Run:
```bash
npm test -- tests/provider/openai.test.ts
```

Expected: PASS.

### Task 4: Implement `stream()` cho OpenAI provider và đổi `generate()` sang collect từ stream

**Files:**
- Modify: `src/provider/openai.ts`
- Modify if needed: `src/provider/model.ts`
- Test: `tests/provider/openai.test.ts`

- [ ] **Step 1: Viết failing parity test cho `stream()` và `generate()`**

Thêm test mới ở `tests/provider/openai.test.ts` dùng fake client để tránh gọi mạng thật. Test này là xương sống của thiết kế.

```ts
describe('createOpenAIProvider', () => {
  it('keeps generate and stream in semantic parity for the same request', async () => {
    const finalResponse = {
      id: 'resp_123',
      model: 'gpt-4.1-mini',
      status: 'completed',
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 48 }
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"note.txt"}'
        }
      ]
    };

    const provider = createOpenAIProvider({
      model: 'gpt-4.1-mini',
      apiKey: 'test-key',
      createClient: () => ({
        responses: {
          create: vi.fn().mockResolvedValue((async function* () {
            yield { type: 'response.created', response: { id: 'resp_123', model: 'gpt-4.1-mini' } };
            yield { type: 'response.output_text.delta', delta: 'Hello world' };
            yield {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_1',
              output_index: 1,
              call_id: 'call_1',
              name: 'read_file',
              arguments: '{"path":"note.txt"}'
            };
            yield { type: 'response.completed', response: finalResponse };
          })())
        }
      }) as unknown as OpenAI
    });

    const request = { messages: [{ role: 'user', content: 'Inspect note.txt' }], availableTools: [] };
    const collected = await collectProviderStream(provider.stream(request));
    const generated = await provider.generate(request);

    expect(collected).toEqual(generated);
  });
});
```

- [ ] **Step 2: Chạy parity test và xác nhận nó fail**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "keeps generate and stream in semantic parity for the same request"
```

Expected: FAIL vì `createOpenAIProvider` chưa có `stream()` và chưa hỗ trợ inject fake client.

- [ ] **Step 3: Cho phép inject OpenAI client factory để test được stream path**

Mở rộng options trong `src/provider/openai.ts`.

```ts
export interface OpenAIProviderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  createClient?: () => OpenAI;
}

function createOpenAIClient(options: OpenAIProviderOptions): OpenAI {
  return options.createClient?.() ?? new OpenAI({
    apiKey: getOpenAIApiKey(options.apiKey),
    baseURL: options.baseUrl
  });
}
```

- [ ] **Step 4: Thêm `stream()` cho OpenAI provider bằng OpenAI Responses stream API**

Trong `src/provider/openai.ts`, đổi `createOpenAIProvider()` thành object có `stream()` và `generate()`.

```ts
export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  return {
    name: 'openai',
    model: options.model,
    async *stream(request: ProviderRequest): AsyncIterable<NormalizedEvent> {
      const client = createOpenAIClient(options);
      const stream = await client.responses.create(buildOpenAIResponsesRequest({
        model: options.model,
        messages: request.messages,
        availableTools: request.availableTools,
        stream: true
      }));

      let sawStart = false;
      let completedResponse: Response | undefined;

      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        switch (event.type) {
          case 'response.created':
            if (!sawStart) {
              sawStart = true;
              yield {
                type: 'start',
                provider: 'openai',
                model: event.response.model
              };
            }
            break;
          case 'response.output_text.delta':
            if (event.delta) {
              yield { type: 'text_delta', text: event.delta };
            }
            break;
          case 'response.function_call_arguments.done': {
            const input = parseOpenAIToolArguments(event.name, event.arguments);
            yield {
              type: 'tool_call',
              id: event.call_id,
              name: event.name,
              input
            };
            break;
          }
          case 'response.completed':
            completedResponse = event.response;
            break;
        }
      }

      if (!completedResponse) {
        throw new Error('OpenAI stream ended without response.completed event.');
      }

      for (const event of toOpenAINormalizedEventsFromResponse(completedResponse)) {
        if (event.type === 'start') {
          if (!sawStart) {
            yield event;
          }
          continue;
        }

        if (event.type === 'text_delta' || event.type === 'tool_call') {
          continue;
        }

        yield event;
      }
    },
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      return collectProviderStream(this.stream(request));
    }
  };
}
```

- [ ] **Step 5: Chạy parity test để verify pass**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "keeps generate and stream in semantic parity for the same request"
```

Expected: PASS.

- [ ] **Step 6: Chạy toàn bộ OpenAI provider tests**

Run:
```bash
npm test -- tests/provider/openai.test.ts
```

Expected: PASS.

### Task 5: Implement stream contract cho Anthropic bằng lỗi rõ ràng

**Files:**
- Modify: `src/provider/anthropic.ts`
- Reference: `src/provider/model.ts`

- [ ] **Step 1: Thêm `stream()` stub ném lỗi rõ ràng trong `createAnthropicProvider()`**

Chèn method mới cạnh `generate()` trong object return ở `src/provider/anthropic.ts`.

```ts
async *stream(_request: ProviderRequest): AsyncIterable<NormalizedEvent> {
  throw new Error('Anthropic provider does not support streaming yet.');
}
```

Đồng thời cập nhật import từ `./model.js` để có `NormalizedEvent`.

```ts
import {
  normalizeProviderResponse,
  type ModelProvider,
  type NormalizedEvent,
  type ProviderDebugMetadata,
  type ProviderFinishSummary,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResponseMetrics,
  type ProviderUsageSummary,
  type ToolCallRequest
} from './model.js';
```

- [ ] **Step 2: Chạy typecheck hoặc test liên quan để xác nhận contract mới compile được**

Run:
```bash
npm run build
```

Expected: PASS, không còn lỗi TypeScript về `ModelProvider` thiếu `stream()` ở Anthropic provider.

### Task 6: Dọn type fallout và verify toàn bộ scope

**Files:**
- Modify if needed: `src/provider/factory.ts`
- Modify if needed: `src/agent/loop.ts`
- Test: `tests/provider/openai.test.ts`

- [ ] **Step 1: Sửa các lỗi type fallout tối thiểu nếu compiler yêu cầu**

Nếu `src/provider/factory.ts` hoặc `src/agent/loop.ts` bị lỗi type sau khi `ModelProvider` đổi contract, giữ patch nhỏ nhất có thể. Mục tiêu là không đổi behavior hiện tại của runtime loop.

Ví dụ nếu cần giữ import type gọn trong `src/provider/factory.ts`, file có thể vẫn là:

```ts
import { createAnthropicProvider } from './anthropic.js';
import type { ModelProvider, ResolvedProviderConfig } from './model.js';
import { createOpenAIProvider } from './openai.js';

export interface CreateProviderOptions extends ResolvedProviderConfig {}

export function createProvider(options: CreateProviderOptions): ModelProvider {
  switch (options.provider) {
    case 'anthropic':
      return createAnthropicProvider({ model: options.model, apiKey: options.apiKey, baseUrl: options.baseUrl });
    case 'openai':
      return createOpenAIProvider({ model: options.model, apiKey: options.apiKey, baseUrl: options.baseUrl });
    default:
      throw new Error(`Unknown provider: ${String(options.provider)}`);
  }
}
```

- [ ] **Step 2: Chạy build đầy đủ**

Run:
```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Chạy test provider sau cùng**

Run:
```bash
npm test -- tests/provider/openai.test.ts
```

Expected: PASS.

- [ ] **Step 4: Kiểm tra nhanh non-stream runtime path không bị đổi behavior ngoài ý muốn**

Run:
```bash
npm test -- tests/provider/openai.test.ts -t "normalizeOpenAIResponseMetadata"
```

Expected: PASS, xác nhận metadata normalization cũ vẫn còn đúng semantic.

- [ ] **Step 5: Commit thay đổi sau khi build và test pass**

Run:
```bash
git add src/provider/model.ts src/provider/openai.ts src/provider/anthropic.ts src/provider/factory.ts src/agent/loop.ts tests/provider/openai.test.ts
git commit -m "feat: add normalized OpenAI provider streaming"
```

Expected: commit được tạo sau khi build và test pass.

## Spec coverage check

- Requirement thêm `stream()` vào provider contract: Task 1.
- `AsyncIterable` là primitive chuẩn: Task 1 + Task 4.
- `generate()` và `stream()` cùng semantic model: Task 1, Task 3, Task 4.
- OpenAI support stream thật bằng Responses API: Task 4.
- Provider chưa hỗ trợ stream fail rõ ràng: Task 5.
- Verification có parity test tối thiểu: Task 4.
- Scope không mở rộng runtime end-to-end: Task 6 giữ patch nhỏ và chỉ dọn fallout type.

## Self-review notes

- Không còn placeholder kiểu TBD/TODO.
- Các tên type và function được dùng nhất quán: `NormalizedEvent`, `collectProviderStream`, `buildOpenAIResponsesRequest`, `toOpenAINormalizedEventsFromResponse`.
- Plan giữ TDD theo từng lát nhỏ: test fail -> implement tối thiểu -> test pass.
- Parity test được giữ như test xương sống thay vì mở rộng suite lớn.
