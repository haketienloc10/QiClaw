function sortTelemetryValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortTelemetryValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, sortTelemetryValue(entryValue)])
  );
}

export function buildTelemetryPreview(value: unknown, maxLength = 120): string {
  const serialized = JSON.stringify(sortTelemetryValue(value)) ?? 'undefined';

  if (serialized.length <= maxLength) {
    return serialized;
  }

  return `${serialized.slice(0, Math.max(0, maxLength - 3))}...`;
}
