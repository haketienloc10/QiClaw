import { appendFileSync, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, parse } from 'node:path';

import type { TelemetryEvent, TelemetryObserver } from './observer.js';

export interface JsonLineWriter {
  appendLine(line: string): void;
}

export interface FileJsonLineWriterOptions {
  now?: () => Date;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

export function createJsonLineLogger(writer: JsonLineWriter): TelemetryObserver {
  return {
    record(event: TelemetryEvent) {
      writer.appendLine(`${JSON.stringify(event)}\n`);
    }
  };
}

export function createFileJsonLineWriter(filePath: string, options: FileJsonLineWriterOptions = {}): JsonLineWriter {
  const now = options.now ?? (() => new Date());
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));

  return {
    appendLine(line: string) {
      const targetPath = resolveRotatedJsonLinePath(filePath, line, now(), maxBytes);
      appendFileSync(targetPath, line, 'utf8');
    }
  };
}

function resolveRotatedJsonLinePath(filePath: string, line: string, now: Date, maxBytes: number): string {
  const parsed = parse(filePath);
  const suffix = formatDateSuffix(now);
  const extension = extname(filePath) || '.log';
  const baseName = parsed.name.length > 0 ? parsed.name : 'debug';
  const byteLength = Buffer.byteLength(line, 'utf8');

  for (let index = 0; ; index += 1) {
    const candidatePath = join(
      dirname(filePath),
      `${baseName}-${suffix}${index === 0 ? '' : `.${index}`}${extension}`
    );

    if (!existsSync(candidatePath)) {
      return candidatePath;
    }

    const size = statSync(candidatePath).size;
    if (size + byteLength <= maxBytes) {
      return candidatePath;
    }
  }
}

function formatDateSuffix(value: Date): string {
  return value.toISOString().slice(0, 10);
}
