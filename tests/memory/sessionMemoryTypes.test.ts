import { describe, expect, it } from 'vitest';

import { buildSessionMemoryUri, parseSessionMemoryUri } from '../../src/memory/sessionMemoryTypes.js';

describe('session memory uri helpers', () => {
  it('builds and parses memvid session memory uris deterministically', () => {
    const uri = buildSessionMemoryUri('session_123', 'abc123def456');

    expect(uri).toBe('mv2://sessions/session_123/memory/abc123def456');
    expect(parseSessionMemoryUri(uri)).toEqual({
      sessionId: 'session_123',
      hash: 'abc123def456'
    });
  });

  it('rejects uris outside the session memory namespace', () => {
    expect(parseSessionMemoryUri('mv2://projects/qiclaw/memory/abc123')).toBeUndefined();
  });
});
