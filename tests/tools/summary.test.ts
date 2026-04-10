import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateToolInput } from '../../src/tools/validation.js';

type ExecaResult = {
  stdout: string;
  stderr?: string;
};

type ExecaInvocation = [
  command: string,
  args: string[],
  options: {
    timeout?: number;
    input?: string;
  }
];

async function loadSummaryToolWithExeca(
  mockImplementation?: (...args: ExecaInvocation) => Promise<ExecaResult>
) {
  vi.resetModules();

  const execaMock = vi.fn<(...args: ExecaInvocation) => Promise<ExecaResult>>(mockImplementation);

  vi.doMock('execa', () => ({
    execa: execaMock,
    default: execaMock
  }));

  const module = await import('../../src/tools/summary.js');

  return {
    summaryTool: module.summaryTool,
    execaMock
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('execa');
});

describe('summaryTool', () => {
  it('accepts the flat wrapper schema via validateToolInput', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca();

    expect(() =>
      validateToolInput(summaryTool, {
        texts: ['First block', 'Second block'],
        mode: 'normal',
        dedupeSentences: true
      })
    ).not.toThrow();
  });

  it('rejects semantic invalid input at execute time with SUMMARY_TOOL_INVALID_INPUT', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca();

    await expect(
      summaryTool.execute(
        {
          texts: ['   ', ''],
          mode: 'unsupported',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_INPUT/);
  });

  it('truncates oversized blocks before invoking the worker and surfaces input_truncated', async () => {
    const oversizedBlock = 'a'.repeat(15_050);
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca(async () => ({
      stdout: JSON.stringify({
        summary: 'Condensed summary',
        input_truncated: true
      })
    }));

    const result = await summaryTool.execute(
      {
        texts: [oversizedBlock, 'short block'],
        mode: 'normal',
        dedupeSentences: true
      } as never,
      { cwd: process.cwd() }
    );

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        timeout: 15_000,
        input: expect.stringMatching(/"input_truncated":true/)
      })
    );

    const firstCall = execaMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const execaOptions = firstCall?.[2];
    expect(execaOptions).toBeDefined();
    const workerPayload = JSON.parse(String(execaOptions?.input ?? ''));

    expect(workerPayload).toMatchObject({
      input_truncated: true,
      texts: ['a'.repeat(15_000), 'short block']
    });
    expect(result.data).toMatchObject({ input_truncated: true });
  });

  it('rejects when any text block is empty or whitespace-only', async () => {
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca();

    await expect(
      summaryTool.execute(
        {
          texts: ['valid block', '   '],
          mode: 'normal',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_INPUT/);

    expect(execaMock).not.toHaveBeenCalled();
  });

  it('rejects when more than 20 text blocks are provided', async () => {
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca();

    await expect(
      summaryTool.execute(
        {
          texts: Array.from({ length: 21 }, (_, index) => `block ${index + 1}`),
          mode: 'normal',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_INPUT/);

    expect(execaMock).not.toHaveBeenCalled();
  });

  it('rejects when total characters still exceed 80_000 after per-block truncation', async () => {
    const { summaryTool, execaMock } = await loadSummaryToolWithExeca();

    await expect(
      summaryTool.execute(
        {
          texts: Array.from({ length: 6 }, () => 'a'.repeat(15_050)),
          mode: 'normal',
          dedupeSentences: true
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_INPUT/);

    expect(execaMock).not.toHaveBeenCalled();
  });

  it('maps invalid worker JSON to SUMMARY_TOOL_INVALID_WORKER_OUTPUT', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => ({
      stdout: 'not valid json'
    }));

    await expect(
      summaryTool.execute(
        {
          texts: ['alpha'],
          mode: 'normal',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_WORKER_OUTPUT/);
  });

  it('rejects normal-mode worker JSON when the summary field is missing', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => ({
      stdout: JSON.stringify({ input_truncated: false })
    }));

    await expect(
      summaryTool.execute(
        {
          texts: ['alpha'],
          mode: 'normal',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_WORKER_OUTPUT/);
  });

  it('rejects memory-mode worker JSON when facts decisions or blockers are not string arrays', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => ({
      stdout: JSON.stringify({
        facts: 'not-an-array',
        decisions: [],
        blockers: []
      })
    }));

    await expect(
      summaryTool.execute(
        {
          texts: ['alpha'],
          mode: 'memory',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_INVALID_WORKER_OUTPUT/);
  });

  it('maps missing python executable to SUMMARY_TOOL_PYTHON_NOT_FOUND', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => {
      const error = new Error('Command failed with ENOENT: python3');
      Object.assign(error, {
        code: 'ENOENT',
        errno: -2,
        failed: true,
        shortMessage: 'Command failed with ENOENT: python3'
      });
      throw error;
    });

    await expect(
      summaryTool.execute(
        {
          texts: ['alpha'],
          mode: 'normal',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_PYTHON_NOT_FOUND/);
  });

  it('maps worker timeout to SUMMARY_TOOL_TIMEOUT', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => {
      const error = new Error('Command timed out after 15000 milliseconds');
      Object.assign(error, {
        timedOut: true,
        failed: true
      });
      throw error;
    });

    await expect(
      summaryTool.execute(
        {
          texts: ['alpha'],
          mode: 'normal',
          dedupeSentences: false
        } as never,
        { cwd: process.cwd() }
      )
    ).rejects.toThrow(/SUMMARY_TOOL_TIMEOUT/);
  });

  it('renders structured memory output from the worker payload', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => ({
      stdout: JSON.stringify({
        facts: ['Customer asked for weekly digest emails'],
        decisions: ['Ship the digest behind a feature flag'],
        blockers: ['Awaiting legal approval for retention policy']
      })
    }));

    const result = await summaryTool.execute(
      {
        texts: ['Meeting notes'],
        mode: 'memory',
        dedupeSentences: true
      } as never,
      { cwd: process.cwd() }
    );

    expect(result.content).toContain('Facts');
    expect(result.content).toContain('Customer asked for weekly digest emails');
    expect(result.content).toContain('Decisions');
    expect(result.content).toContain('Ship the digest behind a feature flag');
    expect(result.content).toContain('Blockers');
    expect(result.content).toContain('Awaiting legal approval for retention policy');
    expect(result.data).toMatchObject({
      facts: ['Customer asked for weekly digest emails'],
      decisions: ['Ship the digest behind a feature flag'],
      blockers: ['Awaiting legal approval for retention policy']
    });
  });

  it('surfaces input_truncated in memory mode when the worker reports it', async () => {
    const { summaryTool } = await loadSummaryToolWithExeca(async () => ({
      stdout: JSON.stringify({
        facts: ['Customer asked for weekly digest emails'],
        decisions: ['Ship the digest behind a feature flag'],
        blockers: ['Awaiting legal approval for retention policy'],
        input_truncated: true
      })
    }));

    const result = await summaryTool.execute(
      {
        texts: ['Meeting notes'],
        mode: 'memory',
        dedupeSentences: true
      } as never,
      { cwd: process.cwd() }
    );

    expect(result.data).toMatchObject({
      facts: ['Customer asked for weekly digest emails'],
      decisions: ['Ship the digest behind a feature flag'],
      blockers: ['Awaiting legal approval for retention policy'],
      input_truncated: true
    });
  });
});
