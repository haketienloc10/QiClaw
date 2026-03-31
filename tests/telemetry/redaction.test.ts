import { describe, expect, it } from 'vitest';

import { redactSensitiveTelemetryValue } from '../../src/telemetry/redaction.js';

describe('redactSensitiveTelemetryValue', () => {
  it('redacts nested sensitive keys case-insensitively', () => {
    expect(redactSensitiveTelemetryValue({
      apiKey: 'top-secret',
      headers: {
        Authorization: 'Bearer abc',
        nested: [{ refreshToken: 'refresh-secret' }]
      },
      safe: 'visible'
    })).toEqual({
      apiKey: '[REDACTED]',
      headers: {
        Authorization: '[REDACTED]',
        nested: [{ refreshToken: '[REDACTED]' }]
      },
      safe: 'visible'
    });
  });
});
