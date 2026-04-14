import { describe, expect, it, vi } from 'vitest';

import { buildCli } from '../../src/cli/main.js';

describe('tui fallback routing', () => {
  it('uses plain repl routing for --plain even on interactive tty', async () => {
    const launchTui = vi.fn(async () => {
      throw new Error('should not launch');
    });
    const writes: string[] = [];

    const cli = buildCli({
      argv: ['--plain'],
      cwd: '/tmp/qiclaw-tui-plain',
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
  });

  it('tries tui on interactive tty and falls back to plain repl with a warning when launch fails', async () => {
    const launchTui = vi.fn(async () => {
      throw new Error('missing tui binary');
    });
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];

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
  });
});
