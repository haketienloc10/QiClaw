# Provider Context Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider telemetry that measures prompt payload size and normalized provider response metadata for context, token, and tool-behavior analysis.

**Architecture:** Keep [src/agent/loop.ts](src/agent/loop.ts) as the single event emitter, but move provider-specific metadata extraction into the provider adapters and move prompt-size measurement into a focused telemetry helper. Emit small shared summary fields on `provider_called` and `provider_responded`, while letting the JSONL debug logger receive richer redacted detail through the same event payloads.

**Tech Stack:** TypeScript, existing provider adapters for Anthropic/OpenAI, observer-based telemetry pipeline, Vitest.

---

## File map

### Existing files to modify

- `src/provider/model.ts`
  - Extend `ProviderResponse` and `normalizeProviderResponse(...)` so the runtime receives normalized finish, usage, response metrics, and debug metadata.
- `src/provider/anthropic.ts`
  - Extract usage, stop reason, content block counts, and tool summaries from the Anthropic SDK response.
- `src/provider/openai.ts`
  - Extract usage, finish reason, output block counts, and tool summaries from the OpenAI Responses API response.
- `src/telemetry/observer.ts`
  - Replace the generic `Record<string, unknown>` payloads for `provider_called` and `provider_responded` with typed interfaces.
- `src/agent/loop.ts`
  - Measure prompt payload size before provider calls and emit enriched provider telemetry from the normalized response.
- `tests/agent/loop.test.ts`
  - Lock the shared provider event summaries and debug details.
- `tests/cli/repl.test.ts`
  - Lock the JSONL output contract and ensure compact CLI output remains unchanged.

### New files to create

- `src/telemetry/providerMetrics.ts`
  - Deterministic prompt serialization, total raw char counting, message-level summaries, content block counting, and redacted prompt preview generation.
- `tests/telemetry/providerMetrics.test.ts`
  - Unit tests for prompt payload measurement.
- `tests/provider/anthropic.test.ts`
  - Unit tests for Anthropic response metadata normalization.
- `tests/provider/openai.test.ts`
  - Unit tests for OpenAI response metadata normalization.

## Task 1: Add failing tests for prompt metrics and provider normalization

**Files:**
- Create: `tests/telemetry/providerMetrics.test.ts`
- Create: `tests/provider/anthropic.test.ts`
- Create: `tests/provider/openai.test.ts`
- Read for reference: `src/core/types.ts`
- Read for reference: `src/telemetry/preview.ts`
- Read for reference: `src/provider/anthropic.ts`
- Read for reference: `src/provider/openai.ts`
- Read for reference: `src/provider/model.ts`

- [ ] **Step 1: Write the failing prompt metrics helper test**

```ts
import { describe, expect, it } from 'vitest';

import { measurePromptTelemetry } from '../../src/telemetry/providerMetrics.js';
import type { Message } from '../../src/core/types.js';

describe('measurePromptTelemetry', () => {
  it('counts prompt raw chars and summarizes each message deterministically', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Inspect note.txt' },
      {
        role: 'assistant',
        content: 'I will inspect it.',
        toolCalls: [
          {
            id: 'call-1',
            name: 'read_file',
            input: { path: 'note.txt', apiKey: 'secret-key' }
          }
        ]
      }
    ];

    expect(measurePromptTelemetry(messages)).toEqual({
      promptRawChars: JSON.stringify([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Inspect note.txt' },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [
            {
              id: 'call-1',
              input: { apiKey: 'secret-key', path: 'note.txt' },
              name: 'read_file'
            }
          ]
        }
      ]).length,
      messageSummaries: [
        { role: 'system', rawChars: 45, contentBlockCount: 1 },
        { role: 'user', rawChars: 42, contentBlockCount: 1 },
        { role: 'assistant', rawChars: 128, contentBlockCount: 2 }
      ],
      totalContentBlockCount: 4,
      hasSystemPrompt: true,
      promptRawPreviewRedacted:
        '[{"content":"You are helpful.","role":"system"},{"content":"Inspect note.txt","role":"user"},{"content":"I will inspect it.","role":"assistant","toolCalls":[{"id":"call-1","input":{"apiKey":"[REDACTED]","path":"note.txt"},"name":"read_file"}]}]'
    });
  });
});
```

- [ ] **Step 2: Write the failing Anthropic provider normalization test**

```ts
import { describe, expect, it } from 'vitest';

import {
  extractAnthropicToolCalls,
  normalizeAnthropicResponseMetadata,
  readAnthropicTextContent
} from '../../src/provider/anthropic.js';

describe('normalizeAnthropicResponseMetadata', () => {
  it('normalizes stop reason, usage, content metrics, and debug summaries', () => {
    const content = [
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'note.txt', apiKey: 'secret-key' } }
    ];

    expect(normalizeAnthropicResponseMetadata({
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 123,
        output_tokens: 45
      },
      content
    })).toEqual({
      finish: {
        stopReason: 'tool_use'
      },
      usage: {
        inputTokens: 123,
        outputTokens: 45,
        totalTokens: 168
      },
      responseMetrics: {
        contentBlockCount: 2,
        toolCallCount: 1,
        hasTextOutput: true,
        contentBlocksByType: {
          text: 1,
          tool_use: 1
        }
      },
      debug: {
        providerUsageRawRedacted: {
          input_tokens: 123,
          output_tokens: 45
        },
        providerStopDetails: {
          stop_reason: 'tool_use'
        },
        toolCallSummaries: [
          {
            id: 'toolu_1',
            name: 'read_file'
          }
        ],
        responseContentBlocksByType: {
          text: 1,
          tool_use: 1
        },
        responsePreviewRedacted:
          '[{"text":"I will inspect it.","type":"text"},{"id":"toolu_1","input":{"apiKey":"[REDACTED]","path":"note.txt"},"name":"read_file","type":"tool_use"}]'
      }
    });

    expect(readAnthropicTextContent(content)).toBe('I will inspect it.');
    expect(extractAnthropicToolCalls(content)).toEqual([
      {
        id: 'toolu_1',
        name: 'read_file',
        input: { path: 'note.txt', apiKey: 'secret-key' }
      }
    ]);
  });
});
```

- [ ] **Step 3: Write the failing OpenAI provider normalization test**

```ts
import { describe, expect, it } from 'vitest';

import {
  extractOpenAIToolCalls,
  normalizeOpenAIResponseMetadata,
  readOpenAITextContent
} from '../../src/provider/openai.js';

describe('normalizeOpenAIResponseMetadata', () => {
  it('normalizes usage, output structure, finish details, and tool summaries', () => {
    const output = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'I will inspect it.' }
        ]
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"note.txt","authorization":"Bearer secret"}'
      }
    ];

    expect(normalizeOpenAIResponseMetadata({
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        total_tokens: 250
      },
      output,
      incomplete_details: {
        reason: 'max_output_tokens'
      }
    })).toEqual({
      finish: {
        stopReason: 'max_output_tokens'
      },
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250
      },
      responseMetrics: {
        contentBlockCount: 2,
        toolCallCount: 1,
        hasTextOutput: true,
        contentBlocksByType: {
          message: 1,
          function_call: 1,
          output_text: 1
        }
      },
      debug: {
        providerUsageRawRedacted: {
          input_tokens: 200,
          output_tokens: 50,
          total_tokens: 250
        },
        providerStopDetails: {
          incomplete_details: {
            reason: 'max_output_tokens'
          }
        },
        toolCallSummaries: [
          {
            id: 'call_1',
            name: 'read_file'
          }
        ],
        responseContentBlocksByType: {
          message: 1,
          function_call: 1,
          output_text: 1
        },
        responsePreviewRedacted:
          '[{"content":[{"text":"I will inspect it.","type":"output_text"}],"role":"assistant","type":"message"},{"arguments":"{\"path\":\"note.txt\",\"authorization\":\"Bearer secret\"}","call_id":"call_1","name":"read_file","type":"function_call"}]'
      }
    });

    expect(readOpenAITextContent(output)).toBe('I will inspect it.');
    expect(extractOpenAIToolCalls(output)).toEqual([
      {
        id: 'call_1',
        name: 'read_file',
        input: { path: 'note.txt', authorization: 'Bearer secret' }
      }
    ]);
  });
});
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/telemetry/providerMetrics.test.ts tests/provider/anthropic.test.ts tests/provider/openai.test.ts`
Expected: FAIL with missing-export or module-not-found errors for `measurePromptTelemetry`, `normalizeAnthropicResponseMetadata`, and `normalizeOpenAIResponseMetadata`.

- [ ] **Step 5: Commit the failing test scaffold**

```bash
git add tests/telemetry/providerMetrics.test.ts tests/provider/anthropic.test.ts tests/provider/openai.test.ts
git commit -m "test: add provider context metrics coverage"
```

## Task 2: Implement prompt metrics helper

**Files:**
- Create: `src/telemetry/providerMetrics.ts`
- Test: `tests/telemetry/providerMetrics.test.ts`
- Read for reference: `src/telemetry/preview.ts`
- Read for reference: `src/telemetry/redaction.ts`

- [ ] **Step 1: Implement deterministic sorting and message content block counting**

```ts
import type { Message } from '../core/types.js';

import { buildTelemetryPreview } from './preview.js';
import { redactSensitiveTelemetryValue } from './redaction.js';

export interface PromptMessageTelemetrySummary {
  role: Message['role'];
  rawChars: number;
  contentBlockCount: number;
}

export interface PromptTelemetryMetrics {
  promptRawChars: number;
  messageSummaries: PromptMessageTelemetrySummary[];
  totalContentBlockCount: number;
  hasSystemPrompt: boolean;
  promptRawPreviewRedacted: string;
}

function sortTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortTelemetryValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, sortTelemetryValue(entryValue)])
  );
}

function serializeTelemetryValue(value: unknown): string {
  return JSON.stringify(sortTelemetryValue(value)) ?? 'undefined';
}

function countMessageContentBlocks(message: Message): number {
  return 1 + (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0);
}
```

- [ ] **Step 2: Implement `measurePromptTelemetry(...)`**

```ts
export function measurePromptTelemetry(messages: Message[]): PromptTelemetryMetrics {
  const serializedPrompt = serializeTelemetryValue(messages);
  const messageSummaries = messages.map((message) => ({
    role: message.role,
    rawChars: serializeTelemetryValue(message).length,
    contentBlockCount: countMessageContentBlocks(message)
  }));
  const redactedPrompt = redactSensitiveTelemetryValue(sortTelemetryValue(messages));

  return {
    promptRawChars: serializedPrompt.length,
    messageSummaries,
    totalContentBlockCount: messageSummaries.reduce((total, message) => total + message.contentBlockCount, 0),
    hasSystemPrompt: messages.some((message) => message.role === 'system'),
    promptRawPreviewRedacted: buildTelemetryPreview(redactedPrompt, 400)
  };
}
```

- [ ] **Step 3: Run the prompt metrics tests to verify they pass**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/telemetry/providerMetrics.test.ts`
Expected: PASS with 1 test passed.

- [ ] **Step 4: Commit the helper implementation**

```bash
git add src/telemetry/providerMetrics.ts tests/telemetry/providerMetrics.test.ts
git commit -m "feat: measure provider prompt payload telemetry"
```

## Task 3: Extend provider response normalization

**Files:**
- Modify: `src/provider/model.ts`
- Modify: `src/provider/anthropic.ts`
- Modify: `src/provider/openai.ts`
- Test: `tests/provider/anthropic.test.ts`
- Test: `tests/provider/openai.test.ts`
- Read for reference: `src/telemetry/redaction.ts`
- Read for reference: `src/telemetry/preview.ts`

- [ ] **Step 1: Extend `src/provider/model.ts` with typed metadata contracts**

```ts
export interface ProviderUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderFinishSummary {
  stopReason?: string;
}

export interface ProviderResponseMetrics {
  contentBlockCount: number;
  toolCallCount: number;
  hasTextOutput: boolean;
  contentBlocksByType?: Record<string, number>;
}

export interface ProviderToolCallSummary {
  id: string;
  name: string;
}

export interface ProviderDebugMetadata {
  providerUsageRawRedacted?: unknown;
  providerStopDetails?: unknown;
  toolCallSummaries?: ProviderToolCallSummary[];
  responseContentBlocksByType?: Record<string, number>;
  responsePreviewRedacted?: string;
}

export interface ProviderResponse {
  message: Message;
  toolCalls: ToolCallRequest[];
  finish?: ProviderFinishSummary;
  usage?: ProviderUsageSummary;
  responseMetrics?: ProviderResponseMetrics;
  debug?: ProviderDebugMetadata;
}

export interface ProviderResponseNormalizationInput {
  content?: string | null;
  toolCalls?: ToolCallRequest[];
  finish?: ProviderFinishSummary;
  usage?: ProviderUsageSummary;
  responseMetrics?: ProviderResponseMetrics;
  debug?: ProviderDebugMetadata;
}
```

- [ ] **Step 2: Update `normalizeProviderResponse(...)` to preserve the new metadata**

```ts
export function normalizeProviderResponse(input: ProviderResponseNormalizationInput): ProviderResponse {
  const toolCalls = input.toolCalls ?? [];

  return {
    message: {
      role: 'assistant',
      content: input.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    },
    toolCalls,
    finish: input.finish,
    usage: input.usage,
    responseMetrics: input.responseMetrics,
    debug: input.debug
  };
}
```

- [ ] **Step 3: Add Anthropic normalization helpers**

```ts
import { buildTelemetryPreview } from '../telemetry/preview.js';
import { redactSensitiveTelemetryValue } from '../telemetry/redaction.js';
import type { ProviderDebugMetadata, ProviderFinishSummary, ProviderResponseMetrics, ProviderUsageSummary } from './model.js';

function countAnthropicContentBlocksByType(content: unknown[]): Record<string, number> {
  return content.reduce<Record<string, number>>((counts, block) => {
    const type = typeof block === 'object' && block !== null && 'type' in block
      ? String((block as { type?: unknown }).type)
      : 'unknown';

    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
}

export function normalizeAnthropicResponseMetadata(response: {
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  content: unknown[];
}): {
  finish: ProviderFinishSummary;
  usage: ProviderUsageSummary;
  responseMetrics: ProviderResponseMetrics;
  debug: ProviderDebugMetadata;
} {
  const toolCalls = extractAnthropicToolCalls(response.content);
  const contentBlocksByType = countAnthropicContentBlocksByType(response.content);
  const usage = response.usage
    ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0)
      }
    : {};

  return {
    finish: {
      stopReason: response.stop_reason ?? undefined
    },
    usage,
    responseMetrics: {
      contentBlockCount: response.content.length,
      toolCallCount: toolCalls.length,
      hasTextOutput: readAnthropicTextContent(response.content).length > 0,
      contentBlocksByType
    },
    debug: {
      providerUsageRawRedacted: response.usage ? redactSensitiveTelemetryValue(response.usage) : undefined,
      providerStopDetails: response.stop_reason ? { stop_reason: response.stop_reason } : undefined,
      toolCallSummaries: toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name })),
      responseContentBlocksByType: contentBlocksByType,
      responsePreviewRedacted: buildTelemetryPreview(redactSensitiveTelemetryValue(response.content), 400)
    }
  };
}
```

- [ ] **Step 4: Wire Anthropic provider creation through the new metadata helper**

```ts
const metadata = normalizeAnthropicResponseMetadata(response);

return normalizeProviderResponse({
  content: readAnthropicTextContent(response.content),
  toolCalls: extractAnthropicToolCalls(response.content),
  finish: metadata.finish,
  usage: metadata.usage,
  responseMetrics: metadata.responseMetrics,
  debug: metadata.debug
});
```

- [ ] **Step 5: Add OpenAI normalization helpers**

```ts
import { buildTelemetryPreview } from '../telemetry/preview.js';
import { redactSensitiveTelemetryValue } from '../telemetry/redaction.js';
import type { ProviderDebugMetadata, ProviderFinishSummary, ProviderResponseMetrics, ProviderUsageSummary } from './model.js';

function countOpenAIOutputBlocksByType(output: unknown[]): Record<string, number> {
  return output.reduce<Record<string, number>>((counts, item) => {
    const type = typeof item === 'object' && item !== null && 'type' in item
      ? String((item as { type?: unknown }).type)
      : 'unknown';

    counts[type] = (counts[type] ?? 0) + 1;

    if (type === 'message' && Array.isArray((item as { content?: unknown }).content)) {
      for (const part of (item as { content: unknown[] }).content) {
        const partType = typeof part === 'object' && part !== null && 'type' in part
          ? String((part as { type?: unknown }).type)
          : 'unknown';
        counts[partType] = (counts[partType] ?? 0) + 1;
      }
    }

    return counts;
  }, {});
}

export function normalizeOpenAIResponseMetadata(response: {
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
  output: unknown[];
  incomplete_details?: { reason?: string | null } | null;
}): {
  finish: ProviderFinishSummary;
  usage: ProviderUsageSummary;
  responseMetrics: ProviderResponseMetrics;
  debug: ProviderDebugMetadata;
} {
  const toolCalls = extractOpenAIToolCalls(response.output);
  const contentBlocksByType = countOpenAIOutputBlocksByType(response.output);

  return {
    finish: {
      stopReason: response.incomplete_details?.reason ?? undefined
    },
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens
        }
      : {},
    responseMetrics: {
      contentBlockCount: response.output.length,
      toolCallCount: toolCalls.length,
      hasTextOutput: readOpenAITextContent(response.output).length > 0,
      contentBlocksByType
    },
    debug: {
      providerUsageRawRedacted: response.usage ? redactSensitiveTelemetryValue(response.usage) : undefined,
      providerStopDetails: response.incomplete_details ? { incomplete_details: response.incomplete_details } : undefined,
      toolCallSummaries: toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name })),
      responseContentBlocksByType: contentBlocksByType,
      responsePreviewRedacted: buildTelemetryPreview(redactSensitiveTelemetryValue(response.output), 400)
    }
  };
}
```

- [ ] **Step 6: Wire OpenAI provider creation through the new metadata helper**

```ts
const metadata = normalizeOpenAIResponseMetadata(response);

return normalizeProviderResponse({
  content: readOpenAITextContent(response.output),
  toolCalls: extractOpenAIToolCalls(response.output),
  finish: metadata.finish,
  usage: metadata.usage,
  responseMetrics: metadata.responseMetrics,
  debug: metadata.debug
});
```

- [ ] **Step 7: Run the provider normalization tests to verify they pass**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/provider/anthropic.test.ts tests/provider/openai.test.ts`
Expected: PASS with both provider metadata tests green.

- [ ] **Step 8: Commit the provider normalization changes**

```bash
git add src/provider/model.ts src/provider/anthropic.ts src/provider/openai.ts tests/provider/anthropic.test.ts tests/provider/openai.test.ts
git commit -m "feat: normalize provider context telemetry"
```

## Task 4: Type provider telemetry events and emit them from the loop

**Files:**
- Modify: `src/telemetry/observer.ts`
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`
- Read for reference: `src/telemetry/providerMetrics.ts`
- Read for reference: `src/provider/model.ts`

- [ ] **Step 1: Add typed payload contracts to `src/telemetry/observer.ts`**

```ts
export interface ProviderCalledTelemetryData {
  messageCount: number;
  promptRawChars: number;
  toolNames: string[];
  messageSummaries: Array<{
    role: string;
    rawChars: number;
    contentBlockCount: number;
  }>;
  totalContentBlockCount: number;
  hasSystemPrompt: boolean;
  promptRawPreviewRedacted: string;
}

export interface ProviderRespondedTelemetryData {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  responseContentBlockCount: number;
  toolCallCount: number;
  hasTextOutput: boolean;
  responseContentBlocksByType?: Record<string, number>;
  toolCallSummaries?: Array<{
    id: string;
    name: string;
  }>;
  providerUsageRawRedacted?: unknown;
  providerStopDetails?: unknown;
  responsePreviewRedacted?: string;
}

export interface TelemetryEventDataMap {
  turn_started: Record<string, unknown>;
  provider_called: ProviderCalledTelemetryData;
  provider_responded: ProviderRespondedTelemetryData;
  tool_call_started: Record<string, unknown>;
  tool_call_completed: Record<string, unknown>;
  verification_completed: Record<string, unknown>;
  turn_completed: Record<string, unknown>;
  turn_stopped: Record<string, unknown>;
  turn_failed: Record<string, unknown>;
}
```

- [ ] **Step 2: Add failing loop assertions for the new provider telemetry fields**

```ts
expect(observedEvents[1]).toMatchObject({
  type: 'provider_called',
  data: {
    messageCount: 2,
    promptRawChars: expect.any(Number),
    toolNames: ['read_file', 'edit_file', 'search', 'shell'],
    messageSummaries: [
      { role: 'system', rawChars: expect.any(Number), contentBlockCount: 1 },
      { role: 'user', rawChars: expect.any(Number), contentBlockCount: 1 }
    ],
    totalContentBlockCount: 2,
    hasSystemPrompt: true,
    promptRawPreviewRedacted: expect.any(String)
  }
});

expect(observedEvents[2]).toMatchObject({
  type: 'provider_responded',
  data: {
    stopReason: 'tool_use',
    usage: {
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160
    },
    responseContentBlockCount: 2,
    toolCallCount: 1,
    hasTextOutput: true,
    responseContentBlocksByType: {
      text: 1,
      tool_use: 1
    },
    toolCallSummaries: [
      {
        id: 'call-read-telemetry',
        name: 'read_file'
      }
    ]
  }
});
```

- [ ] **Step 3: Update the scripted provider fixture in `tests/agent/loop.test.ts` to return normalized metadata**

```ts
{
  message: { role: 'assistant', content: 'I will read the file first.' },
  toolCalls: [
    {
      id: 'call-read-telemetry',
      name: 'read_file',
      input: { path: 'note.txt' }
    }
  ],
  finish: {
    stopReason: 'tool_use'
  },
  usage: {
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 160
  },
  responseMetrics: {
    contentBlockCount: 2,
    toolCallCount: 1,
    hasTextOutput: true,
    contentBlocksByType: {
      text: 1,
      tool_use: 1
    }
  },
  debug: {
    toolCallSummaries: [
      {
        id: 'call-read-telemetry',
        name: 'read_file'
      }
    ],
    responseContentBlocksByType: {
      text: 1,
      tool_use: 1
    },
    responsePreviewRedacted: '[{"text":"I will read the file first.","type":"text"}]'
  }
}
```

- [ ] **Step 4: Implement provider telemetry emission in `src/agent/loop.ts`**

```ts
import { measurePromptTelemetry } from '../telemetry/providerMetrics.js';

const promptMetrics = measurePromptTelemetry(prompt.messages);

observer.record(
  createTelemetryEvent('provider_called', {
    messageCount: prompt.messages.length,
    promptRawChars: promptMetrics.promptRawChars,
    toolNames: input.availableTools.map((tool) => tool.name),
    messageSummaries: promptMetrics.messageSummaries,
    totalContentBlockCount: promptMetrics.totalContentBlockCount,
    hasSystemPrompt: promptMetrics.hasSystemPrompt,
    promptRawPreviewRedacted: promptMetrics.promptRawPreviewRedacted
  })
);
```

- [ ] **Step 5: Emit normalized response telemetry from `src/agent/loop.ts`**

```ts
observer.record(
  createTelemetryEvent('provider_responded', {
    stopReason: response.finish?.stopReason,
    usage: response.usage,
    responseContentBlockCount: response.responseMetrics?.contentBlockCount ?? 0,
    toolCallCount: response.toolCalls.length,
    hasTextOutput: response.responseMetrics?.hasTextOutput ?? response.message.content.length > 0,
    responseContentBlocksByType: response.debug?.responseContentBlocksByType,
    toolCallSummaries: response.debug?.toolCallSummaries,
    providerUsageRawRedacted: response.debug?.providerUsageRawRedacted,
    providerStopDetails: response.debug?.providerStopDetails,
    responsePreviewRedacted: response.debug?.responsePreviewRedacted
  })
);
```

- [ ] **Step 6: Run the loop telemetry tests to verify they pass**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/agent/loop.test.ts`
Expected: PASS with the telemetry event assertions updated for provider metrics.

- [ ] **Step 7: Commit the loop event changes**

```bash
git add src/telemetry/observer.ts src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: emit provider context telemetry"
```

## Task 5: Lock the JSONL logging contract without changing CLI display

**Files:**
- Modify: `tests/cli/repl.test.ts`
- Test: `tests/cli/repl.test.ts`
- Read for reference: `src/cli/main.ts`

- [ ] **Step 1: Add a debug-log test that records provider telemetry events through the CLI observer**

```ts
it('writes provider context metrics to the selected debug JSONL file without changing prompt-mode stdout', async () => {
  await withProviderEnvSnapshot(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'repl-cli-provider-metrics-'));
    tempDirs.push(tempDir);

    const logPath = join(tempDir, 'telemetry.jsonl');
    const writes: string[] = [];
    const cli = buildCli({
      argv: ['--debug-log', logPath, '--prompt', 'inspect package.json'],
      cwd: tempDir,
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
          return true;
        }
      },
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: tempDir,
        observer: runtimeOptions.observer ?? { record() {} }
      }),
      runTurn: async (input) => {
        input.observer?.record(createTelemetryEvent('provider_called', {
          messageCount: 3,
          promptRawChars: 123,
          toolNames: ['read_file'],
          messageSummaries: [{ role: 'user', rawChars: 50, contentBlockCount: 1 }],
          totalContentBlockCount: 1,
          hasSystemPrompt: false,
          promptRawPreviewRedacted: '[{"content":"inspect package.json","role":"user"}]'
        }));
        input.observer?.record(createTelemetryEvent('provider_responded', {
          stopReason: 'tool_use',
          usage: {
            inputTokens: 100,
            outputTokens: 25,
            totalTokens: 125
          },
          responseContentBlockCount: 2,
          toolCallCount: 1,
          hasTextOutput: true,
          responseContentBlocksByType: {
            text: 1,
            tool_use: 1
          },
          toolCallSummaries: [{ id: 'call_1', name: 'read_file' }],
          responsePreviewRedacted: '[{"text":"I will inspect it.","type":"text"}]'
        }));

        return {
          stopReason: 'completed',
          finalAnswer: `handled: ${input.userInput}`,
          history: [],
          toolRoundsUsed: 0,
          doneCriteria: {
            goal: input.userInput,
            checklist: [input.userInput],
            requiresNonEmptyFinalAnswer: true,
            requiresToolEvidence: false
          },
          verification: {
            isVerified: true,
            finalAnswerIsNonEmpty: true,
            toolEvidenceSatisfied: true,
            toolMessagesCount: 0,
            checks: []
          }
        };
      }
    });

    await expect(cli.run()).resolves.toBe(0);

    const jsonl = await readFile(logPath, 'utf8');
    expect(writes).toEqual(['handled: inspect package.json\n']);
    expect(jsonl).toContain('"type":"provider_called"');
    expect(jsonl).toContain('"promptRawChars":123');
    expect(jsonl).toContain('"type":"provider_responded"');
    expect(jsonl).toContain('"totalTokens":125');
    expect(jsonl).toContain('"responseContentBlockCount":2');
  });
});
```

- [ ] **Step 2: Run the CLI test file to verify it passes**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/cli/repl.test.ts`
Expected: PASS with the new debug-log assertion and no change to prompt-mode stdout behavior.

- [ ] **Step 3: Commit the CLI contract coverage**

```bash
git add tests/cli/repl.test.ts
git commit -m "test: lock provider telemetry debug log output"
```

## Task 6: Run the targeted suite and final verification

**Files:**
- Modify if needed after failures: `src/telemetry/providerMetrics.ts`
- Modify if needed after failures: `src/provider/model.ts`
- Modify if needed after failures: `src/provider/anthropic.ts`
- Modify if needed after failures: `src/provider/openai.ts`
- Modify if needed after failures: `src/telemetry/observer.ts`
- Modify if needed after failures: `src/agent/loop.ts`
- Modify if needed after failures: `tests/telemetry/providerMetrics.test.ts`
- Modify if needed after failures: `tests/provider/anthropic.test.ts`
- Modify if needed after failures: `tests/provider/openai.test.ts`
- Modify if needed after failures: `tests/agent/loop.test.ts`
- Modify if needed after failures: `tests/cli/repl.test.ts`

- [ ] **Step 1: Run the full targeted suite for this feature**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" test -- tests/telemetry/providerMetrics.test.ts tests/provider/anthropic.test.ts tests/provider/openai.test.ts tests/agent/loop.test.ts tests/cli/repl.test.ts`
Expected: PASS with all provider context telemetry coverage green.

- [ ] **Step 2: Run the TypeScript build**

Run: `npm --prefix "/home/locdt/Notes/VSCode/QiClaw" run build`
Expected: PASS with `tsc -p tsconfig.json` completing without type errors.

- [ ] **Step 3: Commit the final verification adjustments**

```bash
git add src/telemetry/providerMetrics.ts src/provider/model.ts src/provider/anthropic.ts src/provider/openai.ts src/telemetry/observer.ts src/agent/loop.ts tests/telemetry/providerMetrics.test.ts tests/provider/anthropic.test.ts tests/provider/openai.test.ts tests/agent/loop.test.ts tests/cli/repl.test.ts
git commit -m "feat: add provider context telemetry metrics"
```

## Self-review checklist

- Spec coverage:
  - `promptRawChars`, `messageSummaries`, `totalContentBlockCount`, `hasSystemPrompt`, and redacted preview are implemented in Task 2 and emitted in Task 4.
  - normalized provider finish, usage, response metrics, and debug metadata are implemented in Task 3.
  - JSONL behavior and unchanged CLI display contract are locked in Task 5.
- Placeholder scan:
  - no `TBD`, `TODO`, or “similar to above” shortcuts remain.
  - every code-changing step contains concrete code.
  - every verification step contains exact commands and expected outcomes.
- Type consistency:
  - `ProviderResponse.finish`, `ProviderResponse.usage`, `ProviderResponse.responseMetrics`, and `ProviderResponse.debug` are introduced in Task 3 and reused consistently in Task 4.
  - `measurePromptTelemetry(...)` returns the exact fields consumed later by `provider_called` telemetry.
