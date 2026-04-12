import { describe, expect, it } from 'vitest';

import {
  createInteractiveCheckpointJson,
  createSessionId,
  parseInteractiveCheckpointJson
} from '../../src/session/session.js';

describe('createSessionId', () => {
  it('creates ids with the session_ prefix for session-scoped stores', () => {
    expect(createSessionId()).toMatch(/^session_\d+$/);
  });
});

describe('parseInteractiveCheckpointJson', () => {
  it('accepts tool messages with lightweight session memory metadata required for restore', () => {
    const checkpointJson = createInteractiveCheckpointJson({
      version: 1,
      history: [
        { role: 'user', content: 'inspect package.json' },
        {
          role: 'assistant',
          content: 'Calling Read tool.',
          toolCalls: [
            {
              id: 'toolu_123',
              name: 'Read',
              input: { path: '/tmp/package.json' }
            }
          ]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'toolu_123',
          content: '{"path":"/tmp/package.json"}',
          isError: false
        }
      ],
      historySummary: 'Read package.json successfully.',
      sessionMemory: {
        storeSessionId: 'session-memory-1',
        engine: 'file-session-memory-store',
        version: 1,
        memoryPath: '/tmp/.qiclaw/sessions/session_123/memory/index.json',
        metaPath: '/tmp/.qiclaw/sessions/session_123/memory/meta.json',
        totalEntries: 4,
        lastCompactedAt: '2026-04-06T00:00:00.000Z',
        latestSummaryText: 'package summary'
      }
    });

    const parsed = parseInteractiveCheckpointJson(checkpointJson);

    expect(parsed).toEqual({
      version: 1,
      history: [
        { role: 'user', content: 'inspect package.json' },
        {
          role: 'assistant',
          content: 'Calling Read tool.',
          toolCalls: [
            {
              id: 'toolu_123',
              name: 'Read',
              input: { path: '/tmp/package.json' }
            }
          ]
        },
        {
          role: 'tool',
          name: 'Read',
          toolCallId: 'toolu_123',
          content: '{"path":"/tmp/package.json"}',
          isError: false
        }
      ],
      historySummary: 'Read package.json successfully.',
      sessionMemory: {
        storeSessionId: 'session-memory-1',
        engine: 'file-session-memory-store',
        version: 1,
        memoryPath: '/tmp/.qiclaw/sessions/session_123/memory/index.json',
        metaPath: '/tmp/.qiclaw/sessions/session_123/memory/meta.json',
        totalEntries: 4,
        lastCompactedAt: '2026-04-06T00:00:00.000Z',
        latestSummaryText: 'package summary'
      }
    });
    expect(parsed?.sessionMemory?.storeSessionId).toBe('session-memory-1');
    expect(parsed?.sessionMemory?.memoryPath).toContain('.qiclaw');
  });

  it('rejects malformed assistant toolCalls when restoring checkpoints', () => {
    const checkpointJson = JSON.stringify({
      version: 1,
      history: [
        {
          role: 'assistant',
          content: 'Calling Read tool.',
          toolCalls: [
            {
              id: 123,
              name: 'Read',
              input: { path: '/tmp/package.json' }
            }
          ]
        }
      ]
    });

    expect(parseInteractiveCheckpointJson(checkpointJson)).toBeUndefined();
  });

  it('rejects malformed session memory metadata when restoring checkpoints', () => {
    const checkpointJson = JSON.stringify({
      version: 1,
      history: [],
      sessionMemory: {
        storeSessionId: 'session_123',
        engine: 'file-session-memory-store',
        version: '1',
        memoryPath: '/tmp/memory/index.json',
        metaPath: '/tmp/memory/meta.json',
        totalEntries: 4
      }
    });

    expect(parseInteractiveCheckpointJson(checkpointJson)).toBeUndefined();
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
