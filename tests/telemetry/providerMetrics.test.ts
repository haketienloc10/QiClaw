import { describe, expect, it } from 'vitest';

import type { Message } from '../../src/core/types.js';
import { measurePromptTelemetry } from '../../src/telemetry/providerMetrics.js';

describe('measurePromptTelemetry', () => {
  it('reports provider_called metrics using deterministic full-payload chars and classifies message sources', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Authorization: Bearer top-secret' },
      {
        role: 'assistant',
        content: 'I can help with that.',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'lookupWeather',
            input: { location: 'Hanoi' }
          }
        ]
      },
      {
        role: 'tool',
        name: 'lookupWeather',
        toolCallId: 'tool-1',
        content: 'Sunny in Hanoi',
        isError: false
      }
    ];

    const telemetry = measurePromptTelemetry(messages);

    expect(telemetry).toMatchObject({
      promptRawChars: JSON.stringify(messages).length,
      messageSummaries: [
        {
          role: 'system',
          rawChars: JSON.stringify(messages[0]).length,
          contentBlockCount: 1,
          messageSource: 'system'
        },
        {
          role: 'user',
          rawChars: JSON.stringify(messages[1]).length,
          contentBlockCount: 1,
          messageSource: 'user'
        },
        {
          role: 'assistant',
          rawChars: JSON.stringify(messages[2]).length,
          contentBlockCount: 2,
          messageSource: 'assistant_tool_call',
          toolCallCount: 1
        },
        {
          role: 'tool',
          rawChars: JSON.stringify(messages[3]).length,
          contentBlockCount: 1,
          messageSource: 'tool_result',
          toolName: 'lookupWeather',
          toolCallId: 'tool-1',
          isError: false
        }
      ],
      totalContentBlockCount: 5,
      hasSystemPrompt: true,
      toolMessagesCount: 1,
      assistantToolCallsCount: 1,
      systemMessageChars: JSON.stringify(messages[0]).length,
      userMessageChars: JSON.stringify(messages[1]).length,
      assistantTextChars: 0,
      assistantToolCallChars: JSON.stringify(messages[2]).length,
      toolResultChars: JSON.stringify(messages[3]).length
    });
  });

  it('separates assistant text chars from assistant tool call chars', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'Plain assistant text.' },
      {
        role: 'assistant',
        content: 'Calling tool now.',
        toolCalls: [{ id: 'tool-2', name: 'search', input: { pattern: 'needle' } }]
      }
    ];

    const telemetry = measurePromptTelemetry(messages);

    expect(telemetry.messageSummaries).toMatchObject([
      {
        role: 'assistant',
        messageSource: 'assistant_text'
      },
      {
        role: 'assistant',
        messageSource: 'assistant_tool_call',
        toolCallCount: 1
      }
    ]);
    expect(telemetry.assistantTextChars).toBe(JSON.stringify(messages[0]).length);
    expect(telemetry.assistantToolCallChars).toBe(JSON.stringify(messages[1]).length);
    expect(telemetry.toolResultChars).toBe(0);
  });

  it('redacts free-text secrets in prompt previews without dropping the message structure', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Authorization: Bearer top-secret' }
    ];

    const telemetry = measurePromptTelemetry(messages);
    const parsedPreview = JSON.parse((telemetry as { promptRawPreviewRedacted: string }).promptRawPreviewRedacted) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(parsedPreview.messages).toEqual([
      {
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        role: 'user',
        content: 'Authorization: [REDACTED]'
      }
    ]);
    expect((telemetry as { promptRawPreviewRedacted: string }).promptRawPreviewRedacted).not.toContain('top-secret');
  });

  it('truncates prompt preview output instead of serializing the full payload', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'a'.repeat(1200)
      }
    ];

    const telemetry = measurePromptTelemetry(messages) as { promptRawPreviewRedacted: string };

    expect(telemetry.promptRawPreviewRedacted.endsWith('...')).toBe(true);
    expect(telemetry.promptRawPreviewRedacted.length).toBeLessThan(1200);
  });
});
