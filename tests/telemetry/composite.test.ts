import { describe, expect, it, vi } from 'vitest';

import { createCompositeObserver } from '../../src/telemetry/composite.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompositeObserver', () => {
  it('fans out each event to every observer in order', () => {
    const calls: string[] = [];
    const first = {
      record: vi.fn(() => {
        calls.push('first');
      })
    };
    const second = {
      record: vi.fn(() => {
        calls.push('second');
      })
    };
    const observer = createCompositeObserver([first, second]);
    const event = createTelemetryEvent('turn_started', 'input_received', {
      turnId: 'turn-1',
      providerRound: 0,
      toolRound: 0,
      cwd: '/tmp/workspace',
      userInput: 'hello',
      maxToolRounds: 3,
      toolNames: []
    });

    observer.record(event);

    expect(first.record).toHaveBeenCalledWith(event);
    expect(second.record).toHaveBeenCalledWith(event);
    expect(calls).toEqual(['first', 'second']);
  });
});
