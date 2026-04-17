import { describe, expect, it, vi } from 'vitest';

import { buildCli } from '../../src/cli/main.js';

describe('tui fallback routing', () => {
  it('uses the local CLI path by default on interactive tty when QICLAW_TUI_ENABLED is not set', async () => {
    const launchTui = vi.fn(async () => {
      throw new Error('should not launch');
    });
    const writes: string[] = [];
    const previous = process.env.QICLAW_TUI_ENABLED;
    delete process.env.QICLAW_TUI_ENABLED;

    try {
      const cli = buildCli({
        cwd: '/tmp/qiclaw-cli-default',
        stdout: {
          isTTY: true,
          write(chunk: string | Uint8Array) {
            writes.push(String(chunk));
            return true;
          }
        },
        stderr: {
          write() {
            return true;
          }
        },
        readLine: async () => undefined,
        launchTui
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(launchTui).not.toHaveBeenCalled();
      expect(writes.join('')).toContain('Goodbye.');
    } finally {
      if (previous === undefined) {
        delete process.env.QICLAW_TUI_ENABLED;
      } else {
        process.env.QICLAW_TUI_ENABLED = previous;
      }
    }
  });

  it('tries TUI only when QICLAW_TUI_ENABLED is exactly true on an interactive tty', async () => {
    const launchTui = vi.fn(async () => 0);

    const previous = process.env.QICLAW_TUI_ENABLED;
    process.env.QICLAW_TUI_ENABLED = 'true';

    try {
      const cli = buildCli({
        cwd: '/tmp/qiclaw-tui-enabled',
        stdout: {
          isTTY: true,
          write() {
            return true;
          }
        },
        stderr: {
          write() {
            return true;
          }
        },
        readLine: async () => undefined,
        launchTui
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(launchTui).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) {
        delete process.env.QICLAW_TUI_ENABLED;
      } else {
        process.env.QICLAW_TUI_ENABLED = previous;
      }
    }
  });

  it('keeps the CLI/plain path when QICLAW_TUI_ENABLED=true but stdout is not a tty', async () => {
    const launchTui = vi.fn(async () => {
      throw new Error('should not launch');
    });
    const writes: string[] = [];
    const previous = process.env.QICLAW_TUI_ENABLED;
    process.env.QICLAW_TUI_ENABLED = 'true';

    try {
      const cli = buildCli({
        cwd: '/tmp/qiclaw-tui-disabled-non-tty',
        stdout: {
          isTTY: false,
          write(chunk: string | Uint8Array) {
            writes.push(String(chunk));
            return true;
          }
        },
        stderr: {
          write() {
            return true;
          }
        },
        readLine: async () => undefined,
        launchTui
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(launchTui).not.toHaveBeenCalled();
      expect(writes.join('')).toContain('Goodbye.');
    } finally {
      if (previous === undefined) {
        delete process.env.QICLAW_TUI_ENABLED;
      } else {
        process.env.QICLAW_TUI_ENABLED = previous;
      }
    }
  });

  it.each(['TRUE', '1', 'yes', 'false', ''])('does not launch TUI when QICLAW_TUI_ENABLED=%j', async (value) => {
    const launchTui = vi.fn(async () => {
      throw new Error('should not launch');
    });
    const previous = process.env.QICLAW_TUI_ENABLED;
    process.env.QICLAW_TUI_ENABLED = value;

    try {
      const cli = buildCli({
        cwd: `/tmp/qiclaw-tui-disabled-${String(value || 'empty')}`,
        stdout: {
          isTTY: true,
          write() {
            return true;
          }
        },
        stderr: {
          write() {
            return true;
          }
        },
        readLine: async () => undefined,
        launchTui
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(launchTui).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.QICLAW_TUI_ENABLED;
      } else {
        process.env.QICLAW_TUI_ENABLED = previous;
      }
    }
  });

  it('tries tui on interactive tty and falls back to plain repl with a warning when launch fails', async () => {
    const launchTui = vi.fn(async () => {
      throw new Error('missing tui binary');
    });
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const previous = process.env.QICLAW_TUI_ENABLED;
    process.env.QICLAW_TUI_ENABLED = 'true';

    try {
      const cli = buildCli({
        cwd: '/tmp/qiclaw-tui-fallback',
        stdout: {
          isTTY: true,
          write(chunk: string | Uint8Array) {
            stdoutWrites.push(String(chunk));
            return true;
          }
        },
        stderr: {
          write(chunk: string | Uint8Array) {
            stderrWrites.push(String(chunk));
            return true;
          }
        },
        readLine: async () => undefined,
        launchTui
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(launchTui).toHaveBeenCalledOnce();
      expect(stderrWrites.join('')).toContain('Falling back to plain mode');
      expect(stdoutWrites.join('')).toContain('Goodbye.');
    } finally {
      if (previous === undefined) {
        delete process.env.QICLAW_TUI_ENABLED;
      } else {
        process.env.QICLAW_TUI_ENABLED = previous;
      }
    }
  });

  it('wires controller startup and frontend actions through interactive tui launch path', async () => {
    const bridgeSend = vi.fn();
    let controllerEmit: ((message: string) => void) | undefined;
    const launchTui = vi.fn(async ({ cwd, onAction, onReady }) => {
      expect(cwd).toBe('/tmp/qiclaw-tui-wired');
      await onReady?.({ send: bridgeSend, completion: Promise.resolve(0) });
      await onAction({ type: 'request_status' });
      await onAction({ type: 'quit' });
      return 0;
    });
    const controllerStart = vi.fn(async () => {
      controllerEmit?.('{"type":"status","text":"booted"}\n');
    });
    const controllerHandleAction = vi.fn(async (action) => action.type !== 'quit');
    const createTuiController = vi.fn((options) => {
      controllerEmit = options.emit;
      return {
        start: controllerStart,
        handleAction: controllerHandleAction
      };
    });
    const previous = process.env.QICLAW_TUI_ENABLED;
    process.env.QICLAW_TUI_ENABLED = 'true';

    try {
      const cli = buildCli({
        cwd: '/tmp/qiclaw-tui-wired',
        stdout: {
          isTTY: true,
          write() {
            return true;
          }
        },
        stderr: {
          write() {
            return true;
          }
        },
        readLine: async () => undefined,
        launchTui,
        createTuiController
      });

      await expect(cli.run()).resolves.toBe(0);
      expect(createTuiController).toHaveBeenCalledOnce();
      expect(controllerStart).toHaveBeenCalledOnce();
      expect(controllerHandleAction).toHaveBeenCalledWith({ type: 'request_status' });
      expect(controllerHandleAction).toHaveBeenCalledWith({ type: 'quit' });
      expect(bridgeSend).toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.QICLAW_TUI_ENABLED;
      } else {
        process.env.QICLAW_TUI_ENABLED = previous;
      }
    }
  });
});
