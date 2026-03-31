const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(key|token|secret|authorization|cookie|password)/i;
const SAFE_USAGE_COUNTER_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'inputTokens',
  'outputTokens',
  'totalTokens'
]);
const SENSITIVE_TEXT_PATTERNS = [
  /(authorization\s*:\s*)([^\r\n]+)/gi,
  /(cookie\s*:\s*)([^\r\n]+)/gi,
  /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password)\b\s*[:=]\s*)([^\r\n]+)/gi
] as const;

export function redactSensitiveTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveTelemetryValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) && !SAFE_USAGE_COUNTER_KEYS.has(key)
      ? REDACTED_VALUE
      : redactSensitiveTelemetryValue(entryValue)
  ]);

  return Object.fromEntries(entries);
}

export function redactSensitiveTelemetryPreviewValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveTelemetryText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveTelemetryPreviewValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) && !SAFE_USAGE_COUNTER_KEYS.has(key)
      ? REDACTED_VALUE
      : redactSensitiveTelemetryPreviewValue(entryValue)
  ]);

  return Object.fromEntries(entries);
}

export function redactSensitiveTelemetryText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, `$1${REDACTED_VALUE}`),
    value
  );
}
