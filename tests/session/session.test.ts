import { describe, expect, it } from 'vitest';

import {
  createInteractiveCheckpointJson,
  parseInteractiveCheckpointJson
} from '../../src/session/session.js';

describe('parseInteractiveCheckpointJson', () => {
  it('accepts tool messages with the runtime fields required for restore', () => {
    const checkpointJson = createInteractiveCheckpointJson({
      version: 1,
      history: [
        { role: 'user', content: 'inspect package.json' },
        { role: 'assistant', content: 'Calling Read tool.' },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'toolu_123',
          content: '{"path":"/tmp/package.json"}',
          isError: false
        }
      ],
      historySummary: 'Read package.json successfully.'
    });

    expect(parseInteractiveCheckpointJson(checkpointJson)).toEqual({
      version: 1,
      history: [
        { role: 'user', content: 'inspect package.json' },
        { role: 'assistant', content: 'Calling Read tool.' },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'toolu_123',
          content: '{"path":"/tmp/package.json"}',
          isError: false
        }
      ],
      historySummary: 'Read package.json successfully.'
    });
  });

  it.each([
    {
      label: 'name is missing',
      message: {
        role: 'tool',
        toolCallId: 'toolu_123',
        content: 'ok',
        isError: false
      }
    },
    {
      label: 'toolCallId is missing',
      message: {
        role: 'tool',
        name: 'Read',
        content: 'ok',
        isError: false
      }
    },
    {
      label: 'isError is missing',
      message: {
        role: 'tool',
        name: 'Read',
        toolCallId: 'toolu_123',
        content: 'ok'
      }
    },
    {
      label: 'isError is not a boolean',
      message: {
        role: 'tool',
        name: 'Read',
        toolCallId: 'toolu_123',
        content: 'ok',
        isError: 'false'
      }
    }
  ])('rejects malformed tool messages when $label', ({ message }) => {
    const checkpointJson = JSON.stringify({
      version: 1,
      history: [message]
    });

    expect(parseInteractiveCheckpointJson(checkpointJson)).toBeUndefined();
  });
});
