import { describe, expect, it, vi } from 'vitest';

import { createCompositeObserver } from '../../src/telemetry/composite.js';
import { createTelemetryEvent } from '../../src/telemetry/observer.js';

describe('createCompositeObserver', () => {
  it('fans out each event to every observer in order', () => {
    const first = { record: vi.fn() };
    const second = { record: vi.fn() };
    const observer = createCompositeObserver([first, second]);
    const event = createTelemetryEvent('turn_started', { userInput: 'hello' });

    observer.record(event);

    expect(first.record).toHaveBeenCalledWith(event);
    expect(second.record).toHaveBeenCalledWith(event);
    expect(first.record.mock.invocationCallOrder[0]).toBeLessThan(second.record.mock.invocationCallOrder[0]);
  });
});
