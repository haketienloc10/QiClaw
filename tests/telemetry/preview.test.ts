import { describe, expect, it } from 'vitest';

import { buildTelemetryPreview } from '../../src/telemetry/preview.js';

describe('buildTelemetryPreview', () => {
  it('serializes values deterministically and truncates long output', () => {
    expect(buildTelemetryPreview({ path: 'note.txt', limit: 10 })).toBe('{"limit":10,"path":"note.txt"}');
    expect(buildTelemetryPreview({ content: 'x'.repeat(200) }, 32)).toBe('{"content":"xxxxxxxxxxxxxxxxxxxx...');
  });
});
