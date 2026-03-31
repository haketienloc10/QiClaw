import { describe, expect, it } from 'vitest';

import {
  redactSensitiveTelemetryPreviewValue,
  redactSensitiveTelemetryText,
  redactSensitiveTelemetryValue
} from '../../src/telemetry/redaction.js';

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

describe('redactSensitiveTelemetryText', () => {
  it('redacts sensitive plain-text header and assignment values', () => {
    expect(redactSensitiveTelemetryText(
      'Authorization: Bearer secret-token\napi_key=secret-key\ncookie: session=abc123\nsafe=value'
    )).toBe(
      'Authorization: [REDACTED]\napi_key=[REDACTED]\ncookie: [REDACTED]\nsafe=value'
    );
  });
});

describe('redactSensitiveTelemetryPreviewValue', () => {
  it('redacts sensitive strings in preview payloads', () => {
    expect(redactSensitiveTelemetryPreviewValue({
      text: 'Authorization: Bearer secret-token\napi_key=secret-key',
      safe: 'visible',
      nested: [{ cookie: 'session=abc123' }]
    })).toEqual({
      text: 'Authorization: [REDACTED]\napi_key=[REDACTED]',
      safe: 'visible',
      nested: [{ cookie: '[REDACTED]' }]
    });
  });
});
