import { describe, expect, it } from 'vitest';

import type { Message } from '../../src/core/types.js';
import { measurePromptTelemetry } from '../../src/telemetry/providerMetrics.js';

describe('measurePromptTelemetry', () => {
  it('reports prompt message count, content block count, and a redacted string preview for provider telemetry', () => {
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

    expect(telemetry.messageCount).toBe(3);
    expect(telemetry.contentBlockCount).toBe(3);
    expect(typeof telemetry.preview).toBe('string');
    expect(telemetry.preview.length).toBeGreaterThan(0);
    expect(() => JSON.parse(telemetry.preview)).not.toThrow();

    const parsedPreview = JSON.parse(telemetry.preview) as {
      messages: Array<{ role: string; content: string; toolCalls?: Array<{ id: string; input: unknown; name: string }> }>;
    };

    expect(parsedPreview.messages).toHaveLength(3);
    expect(parsedPreview.messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.'
    });
    expect(parsedPreview.messages[1]).toEqual({
      role: 'user',
      content: '[REDACTED]'
    });
    expect(parsedPreview.messages[2]).toEqual({
      role: 'assistant',
      content: 'I can help with that.',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'lookupWeather',
          input: { location: 'Hanoi' }
        }
      ]
    });
    expect(telemetry.preview).not.toContain('top-secret');
  });

  it('truncates preview output instead of serializing the full payload', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: 'a'.repeat(1200)
      }
    ];

    const telemetry = measurePromptTelemetry(messages);

    expect(telemetry.preview.endsWith('...')).toBe(true);
    expect(telemetry.preview.length).toBeLessThan(1200);
  });

  it('redacts nested structured string values that contain secrets', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: JSON.stringify({ note: 'safe' })
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            output: {
              message: 'Bearer nested-secret',
              metadata: {
                details: 'password: open-sesame'
              }
            }
          }
        ] as unknown as string
      }
    ];

    const telemetry = measurePromptTelemetry(messages);
    const parsedPreview = JSON.parse(telemetry.preview) as {
      messages: Array<{ content: unknown }>;
    };

    expect(parsedPreview.messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          output: {
            message: '[REDACTED]',
            metadata: {
              details: '[REDACTED]'
            }
          },
          type: 'tool_result'
        }
      ]
    });
    expect(telemetry.preview).not.toContain('nested-secret');
    expect(telemetry.preview).not.toContain('open-sesame');
  });
});
