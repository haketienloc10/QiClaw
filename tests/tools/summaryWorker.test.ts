import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectoryPath = dirname(fileURLToPath(import.meta.url));
const projectRootPath = resolve(testDirectoryPath, '..', '..');
const workerPath = resolve(projectRootPath, 'src/tools/python/summary_worker.py');

function readWorkerSource() {
  return readFileSync(workerPath, 'utf8');
}

describe('summary worker spec guardrails', () => {
  it('references the underthesea NLP stack', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/underthesea/i);
  });

  it('references rapidfuzz for deterministic dedupe similarity checks', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/rapidfuzz/i);
  });

  it('references sklearn TF-IDF support', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/sklearn|TfidfVectorizer/i);
  });

  it('references networkx for graph-based ranking or clustering', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/networkx/i);
  });

  it('contains structured memory buckets for facts decisions and blockers', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/facts/i);
    expect(workerSource).toMatch(/decisions/i);
    expect(workerSource).toMatch(/blockers/i);
  });

  it('defines a clear deterministic dedupe threshold of 92', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/\b92(?:\.0+)?\b|>=\s*92|>\s*91(?:\.9+)?/i);
  });

  it('supports concise normal and memory execution modes', () => {
    const workerSource = readWorkerSource();

    expect(workerSource).toMatch(/concise/i);
    expect(workerSource).toMatch(/normal/i);
    expect(workerSource).toMatch(/memory/i);
  });

  it('runs under the project python3 runtime without syntax or typing crashes', () => {
    const result = spawnSync('python3', [workerPath], {
      input: JSON.stringify({ texts: ['alpha'], mode: 'normal', input_truncated: false }),
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as {
      summary?: string;
      input_truncated?: boolean;
    };

    expect(payload).toMatchObject({
      summary: 'alpha',
      input_truncated: false
    });
  });

  it('respects dedupe_sentences=false by keeping repeated sentences in normal mode', () => {
    const result = spawnSync('python3', [workerPath], {
      input: JSON.stringify({
        texts: ['Lặp lại. Lặp lại.'],
        mode: 'normal',
        dedupe_sentences: false,
        input_truncated: false
      }),
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      summary?: string;
    };

    expect(payload.summary).toBe('Lặp lại. Lặp lại.');
  });
});
