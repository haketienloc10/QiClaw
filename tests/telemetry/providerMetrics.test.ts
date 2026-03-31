import { describe, expect, it } from 'vitest';

import { measurePromptTelemetry } from '../../src/telemetry/providerMetrics.js';
import type { Message } from '../../src/core/types.js';

describe('measurePromptTelemetry', () => {
  it('reports prompt message count and deterministic preview for provider telemetry', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Summarize the latest notes.' },
      { role: 'assistant', content: 'I can help with that.' }
    ];

    expect(measurePromptTelemetry(messages)).toEqual({
      messageCount: 3,
      preview: '{"messages":[{"content":"You are a helpful assistant.","role":"system"},{"content":"Summarize the latest notes.","role":"user"},{"content":"I can help with that.","role":"assistant"}]}'
    });
  });
});
