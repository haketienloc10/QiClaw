import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import type { Tool } from './tool.js';

type SummaryMode = 'normal' | 'concise' | 'memory';

type SummaryToolInput = {
  texts: string[];
  mode?: string;
  dedupeSentences?: boolean;
};

type WorkerNormalResponse = {
  summary: string;
  input_truncated?: boolean;
};

type WorkerMemoryResponse = {
  facts: string[];
  decisions: string[];
  blockers: string[];
  input_truncated?: boolean;
};

const MAX_BLOCKS = 20;
const MAX_BLOCK_CHARS = 15_000;
const MAX_TOTAL_CHARS = 80_000;
const WORKER_TIMEOUT_MS = 15_000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(MODULE_DIR, 'python', 'summary_worker.py');

function formatSummaryActivityLabel(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return 'summarize';
  }

  const mode = typeof (input as { mode?: unknown }).mode === 'string'
    ? (input as { mode: string }).mode.trim()
    : '';

  return mode.length > 0 ? `summarize ${mode}` : 'summarize';
}

export const summaryTool: Tool<SummaryToolInput> = {
  name: 'summary_tool',
  description: 'Summarize text blocks via the Python summary worker wrapper.',
  formatActivityLabel: formatSummaryActivityLabel,
  inputSchema: {
    type: 'object',
    properties: {
      texts: {
        type: 'array',
        items: { type: 'string' }
      },
      mode: { type: 'string' },
      dedupeSentences: { type: 'boolean' }
    },
    required: ['texts'],
    additionalProperties: false
  },
  async execute(input, context) {
    const normalizedInput = normalizeAndValidateInput(input);
    const limitedInput = applyInputLimits(normalizedInput.texts);
    const payload = {
      texts: limitedInput.texts,
      mode: normalizedInput.mode,
      dedupe_sentences: normalizedInput.dedupeSentences,
      input_truncated: limitedInput.inputTruncated
    };

    const workerOutput = await runWorker(payload, context.cwd);

    if (normalizedInput.mode === 'memory') {
      return renderMemoryResult(workerOutput, limitedInput.inputTruncated);
    }

    return renderSummaryResult(workerOutput, limitedInput.inputTruncated);
  }
};

function normalizeAndValidateInput(input: SummaryToolInput): {
  texts: string[];
  mode: SummaryMode;
  dedupeSentences: boolean;
} {
  if (!Array.isArray(input.texts) || input.texts.length === 0) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: texts must be a non-empty array.');
  }

  if (input.texts.length > MAX_BLOCKS) {
    throw new Error(`SUMMARY_TOOL_INVALID_INPUT: texts must contain no more than ${MAX_BLOCKS} blocks.`);
  }

  if (input.texts.some((text) => typeof text !== 'string')) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: texts must contain only strings.');
  }

  const texts = input.texts.map((text) => text);
  if (texts.some((text) => text.trim().length === 0)) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: text blocks must be non-empty after trimming.');
  }

  const mode = (input.mode ?? 'normal') as SummaryMode;
  if (!isSummaryMode(mode)) {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: unsupported mode.');
  }

  const dedupeSentences = input.dedupeSentences ?? true;
  if (typeof dedupeSentences !== 'boolean') {
    throw new Error('SUMMARY_TOOL_INVALID_INPUT: dedupeSentences must be a boolean.');
  }

  return {
    texts,
    mode,
    dedupeSentences
  };
}

function isSummaryMode(mode: string): mode is SummaryMode {
  return mode === 'normal' || mode === 'concise' || mode === 'memory';
}

function applyInputLimits(texts: string[]): { texts: string[]; inputTruncated: boolean } {
  const truncatedTexts = texts.map((originalText) => originalText.slice(0, MAX_BLOCK_CHARS));
  const inputTruncated = truncatedTexts.some((text, index) => text.length !== texts[index]?.length);
  const totalChars = truncatedTexts.reduce((sum, text) => sum + text.length, 0);

  if (totalChars > MAX_TOTAL_CHARS) {
    throw new Error(`SUMMARY_TOOL_INVALID_INPUT: total text length must be no more than ${MAX_TOTAL_CHARS} characters after per-block truncation.`);
  }

  return {
    texts: truncatedTexts,
    inputTruncated
  };
}

async function runWorker(payload: Record<string, unknown>, cwd: string): Promise<unknown> {
  try {
    return await invokeWorker('python3', payload, cwd);
  } catch (error) {
    if (isEnoentError(error)) {
      try {
        return await invokeWorker('python', payload, cwd);
      } catch (fallbackError) {
        if (isEnoentError(fallbackError)) {
          throw new Error('SUMMARY_TOOL_PYTHON_NOT_FOUND: Python executable was not found.');
        }

        throw mapWorkerExecutionError(fallbackError);
      }
    }

    throw mapWorkerExecutionError(error);
  }
}

async function invokeWorker(command: string, payload: Record<string, unknown>, cwd: string): Promise<unknown> {
  const result = await execa(command, [WORKER_PATH], {
    input: JSON.stringify(payload),
    timeout: WORKER_TIMEOUT_MS,
    cwd
  });

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('SUMMARY_TOOL_INVALID_WORKER_OUTPUT: Worker returned invalid JSON.');
  }
}

function mapWorkerExecutionError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('SUMMARY_TOOL_INVALID_WORKER_OUTPUT')) {
    return error;
  }

  if (isTimeoutError(error)) {
    return new Error('SUMMARY_TOOL_TIMEOUT: Summary worker timed out.');
  }

  if (isEnoentError(error)) {
    return new Error('SUMMARY_TOOL_PYTHON_NOT_FOUND: Python executable was not found.');
  }

  return new Error('SUMMARY_TOOL_WORKER_FAILED: Summary worker execution failed.');
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'timedOut' in error && (error as { timedOut?: unknown }).timedOut === true);
}

function renderSummaryResult(workerOutput: unknown, inputTruncated: boolean) {
  const output = parseNormalWorkerResponse(workerOutput);
  const workerInputTruncated = output.input_truncated === true;

  return {
    content: output.summary,
    data: {
      input_truncated: inputTruncated || workerInputTruncated
    }
  };
}

function renderMemoryResult(workerOutput: unknown, inputTruncated: boolean) {
  const output = parseMemoryWorkerResponse(workerOutput);
  const workerInputTruncated = output.input_truncated === true;

  return {
    content: [
      'Facts',
      ...renderBullets(output.facts),
      '',
      'Decisions',
      ...renderBullets(output.decisions),
      '',
      'Blockers',
      ...renderBullets(output.blockers)
    ].join('\n'),
    data: {
      facts: output.facts,
      decisions: output.decisions,
      blockers: output.blockers,
      input_truncated: inputTruncated || workerInputTruncated
    }
  };
}

function parseNormalWorkerResponse(workerOutput: unknown): WorkerNormalResponse {
  if (!isRecord(workerOutput) || typeof workerOutput.summary !== 'string') {
    throw new Error('SUMMARY_TOOL_INVALID_WORKER_OUTPUT: Worker returned an invalid normal-mode payload.');
  }

  if ('input_truncated' in workerOutput && typeof workerOutput.input_truncated !== 'boolean') {
    throw new Error('SUMMARY_TOOL_INVALID_WORKER_OUTPUT: Worker returned an invalid truncation flag.');
  }

  return workerOutput as WorkerNormalResponse;
}

function parseMemoryWorkerResponse(workerOutput: unknown): WorkerMemoryResponse {
  if (
    !isRecord(workerOutput) ||
    !isStringArray(workerOutput.facts) ||
    !isStringArray(workerOutput.decisions) ||
    !isStringArray(workerOutput.blockers)
  ) {
    throw new Error('SUMMARY_TOOL_INVALID_WORKER_OUTPUT: Worker returned an invalid memory-mode payload.');
  }

  if ('input_truncated' in workerOutput && typeof workerOutput.input_truncated !== 'boolean') {
    throw new Error('SUMMARY_TOOL_INVALID_WORKER_OUTPUT: Worker returned an invalid truncation flag.');
  }

  return workerOutput as WorkerMemoryResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function renderBullets(items: string[]): string[] {
  if (items.length === 0) {
    return ['- None'];
  }

  return items.map((item) => `- ${item}`);
}
