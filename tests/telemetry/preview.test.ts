import { describe, expect, it } from 'vitest';

import { buildTelemetryPreview } from '../../src/telemetry/preview.js';

describe('buildTelemetryPreview', () => {
  it('serializes values deterministically and truncates long output', () => {
    expect(buildTelemetryPreview({ path: 'note.txt', limit: 10 })).toBe('{"limit":10,"path":"note.txt"}');

    const preview = buildTelemetryPreview({ content: 'x'.repeat(200) }, 32);
    expect(preview.startsWith('{"content":"')).toBe(true);
    expect(preview.endsWith('...')).toBe(true);
    expect(preview.length).toBe(32);
  });
});
