import { describe, expect, it } from 'vitest';

import type { Message } from '../../src/core/types.js';
import { measurePromptTelemetry } from '../../src/telemetry/providerMetrics.js';

describe('measurePromptTelemetry', () => {
  it('reports provider_called metrics using deterministic full-payload chars and spec message summaries', () => {
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
      }
    ];

    const telemetry = measurePromptTelemetry(messages);

    expect(telemetry).toMatchObject({
      promptRawChars: JSON.stringify(messages).length,
      messageSummaries: [
        {
          role: 'system',
          rawChars: JSON.stringify(messages[0]).length,
          contentBlockCount: 1
        },
        {
          role: 'user',
          rawChars: JSON.stringify(messages[1]).length,
          contentBlockCount: 1
        },
        {
          role: 'assistant',
          rawChars: JSON.stringify(messages[2]).length,
          contentBlockCount: 2
        }
      ],
      totalContentBlockCount: 4,
      hasSystemPrompt: true
    });
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
