import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFileJsonLineWriter } from '../../src/telemetry/logger.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }));
});

describe('createFileJsonLineWriter', () => {
  it('writes into a day-scoped file derived from the requested path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'telemetry-logger-'));
    tempDirs.push(tempDir);

    const requestedPath = join(tempDir, 'debug.jsonl');
    const writer = createFileJsonLineWriter(requestedPath, {
      now: () => new Date('2026-04-07T10:00:00.000Z')
    });

    writer.appendLine('{"type":"first"}\n');

    const rotatedPath = join(tempDir, 'debug-2026-04-07.jsonl');
    const content = await readFile(rotatedPath, 'utf8');

    expect(content).toBe('{"type":"first"}\n');
  });

  it('rotates to the next numbered file when the active day file exceeds 500MB', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'telemetry-logger-'));
    tempDirs.push(tempDir);

    const requestedPath = join(tempDir, 'debug.jsonl');
    const writer = createFileJsonLineWriter(requestedPath, {
      now: () => new Date('2026-04-07T10:00:00.000Z'),
      maxBytes: 10
    });

    writer.appendLine('1234567890\n');
    writer.appendLine('abc\n');

    const firstPath = join(tempDir, 'debug-2026-04-07.jsonl');
    const secondPath = join(tempDir, 'debug-2026-04-07.1.jsonl');

    expect(await readFile(firstPath, 'utf8')).toBe('1234567890\n');
    expect(await readFile(secondPath, 'utf8')).toBe('abc\n');
  });

  it('switches to a fresh day file when the date changes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'telemetry-logger-'));
    tempDirs.push(tempDir);

    const requestedPath = join(tempDir, 'debug.jsonl');
    let currentTime = new Date('2026-04-07T23:59:59.000Z');
    const writer = createFileJsonLineWriter(requestedPath, {
      now: () => currentTime
    });

    writer.appendLine('old-day\n');
    currentTime = new Date('2026-04-08T00:00:01.000Z');
    writer.appendLine('new-day\n');

    expect(await readFile(join(tempDir, 'debug-2026-04-07.jsonl'), 'utf8')).toBe('old-day\n');
    expect(await readFile(join(tempDir, 'debug-2026-04-08.jsonl'), 'utf8')).toBe('new-day\n');
  });

  it('keeps the rotated file under the size limit after each append', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'telemetry-logger-'));
    tempDirs.push(tempDir);

    const requestedPath = join(tempDir, 'debug.jsonl');
    const writer = createFileJsonLineWriter(requestedPath, {
      now: () => new Date('2026-04-07T10:00:00.000Z'),
      maxBytes: 10
    });

    writer.appendLine('1234\n');
    writer.appendLine('5678\n');
    writer.appendLine('90\n');

    const firstStats = await stat(join(tempDir, 'debug-2026-04-07.jsonl'));
    const secondStats = await stat(join(tempDir, 'debug-2026-04-07.1.jsonl'));

    expect(firstStats.size).toBeLessThanOrEqual(10);
    expect(secondStats.size).toBeLessThanOrEqual(10);
    expect(dirname(requestedPath)).toBe(tempDir);
  });
});
