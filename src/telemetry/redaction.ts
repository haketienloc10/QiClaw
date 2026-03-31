const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(key|token|secret|authorization|cookie|password)/i;

export function redactSensitiveTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveTelemetryValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactSensitiveTelemetryValue(entryValue)
  ]);

  return Object.fromEntries(entries);
}
