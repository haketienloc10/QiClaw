import { describe, expect, it } from 'vitest';

import { measurePromptTelemetry } from '../../src/telemetry/providerMetrics.js';
import type { Message } from '../../src/core/types.js';

describe('measurePromptTelemetry', () => {
  it('reports prompt message count and a redacted string preview for provider telemetry', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Authorization: Bearer top-secret' },
      { role: 'assistant', content: 'I can help with that.' }
    ];

    const telemetry = measurePromptTelemetry(messages);

    expect(telemetry.messageCount).toBe(3);
    expect(typeof telemetry.preview).toBe('string');
    expect(telemetry.preview.length).toBeGreaterThan(0);
    expect(() => JSON.parse(telemetry.preview)).not.toThrow();

    const parsedPreview = JSON.parse(telemetry.preview) as {
      messages: Array<{ role: string; content: string }>;
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
      content: 'I can help with that.'
    });
    expect(telemetry.preview).not.toContain('top-secret');
  });
});
