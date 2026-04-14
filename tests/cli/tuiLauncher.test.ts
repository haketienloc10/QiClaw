import { describe, expect, it, vi } from 'vitest';

import { createTuiBridge, launchTui } from '../../src/cli/tuiLauncher.js';
import { serializeBridgeMessage } from '../../src/cli/tuiProtocol.js';

describe('tuiLauncher bridge', () => {
  it('frames fd4 as ndjson lines and forwards parsed frontend actions while writing host events to fd3', async () => {
    let resolveHandledActions: (() => void) | undefined;
    const handledActions = new Promise<void>((resolve) => {
      resolveHandledActions = resolve;
    });
    const actionHandler = vi.fn(async () => {
      if (actionHandler.mock.calls.length === 2) {
        resolveHandledActions?.();
      }
    });
    const fd3Writes: string[] = [];
    const fd4Listeners: Array<(chunk: string) => void> = [];
    let exitHandler: ((code: number | null) => void) | undefined;

    const bridge = await createTuiBridge({
      cwd: '/tmp/qiclaw-launcher',
      spawnProcess: () => ({
        stdio: [
          null,
          null,
          null,
          {
            write(chunk) {
              fd3Writes.push(String(chunk));
              return true;
            }
          },
          {
            setEncoding() {},
            on(event, listener) {
              if (event === 'data') {
                fd4Listeners.push(listener as (chunk: string) => void);
              }
            }
          }
        ],
        kill() {
          return true;
        },
        once(event, listener) {
          if (event === 'exit') {
            exitHandler = listener as (code: number | null) => void;
          }
          return this;
        }
      } as never),
      binaryPath: '/tmp/qiclaw-tui',
      onAction: actionHandler
    });

    const completion = bridge.completion;

    fd4Listeners[0](serializeBridgeMessage({ type: 'request_status' }).slice(0, 10));
    fd4Listeners[0](serializeBridgeMessage({ type: 'request_status' }).slice(10));
    fd4Listeners[0](serializeBridgeMessage({ type: 'run_shell_command', command: 'git', args: ['status'] }));
    await handledActions;
    bridge.send({ type: 'status', text: 'ready' });
    exitHandler?.(0);

    await completion;

    expect(actionHandler).toHaveBeenNthCalledWith(1, { type: 'request_status' });
    expect(actionHandler).toHaveBeenNthCalledWith(2, { type: 'run_shell_command', command: 'git', args: ['status'] });
    expect(fd3Writes).toEqual([serializeBridgeMessage({ type: 'status', text: 'ready' })]);
  });

  it('rejects completion on malformed ndjson instead of throwing from fd4 handler', async () => {
    const fd4Listeners: Array<(chunk: string) => void> = [];

    const bridge = await createTuiBridge({
      cwd: '/tmp/qiclaw-launcher-bad-json',
      spawnProcess: () => ({
        stdio: [
          null,
          null,
          null,
          { write() { return true; } },
          {
            setEncoding() {},
            on(event, listener) {
              if (event === 'data') {
                fd4Listeners.push(listener as (chunk: string) => void);
              }
            }
          }
        ],
        kill() {
          return true;
        },
        once() {
          return this;
        }
      } as never),
      binaryPath: '/tmp/qiclaw-tui',
      onAction: vi.fn(async () => {})
    });

    expect(() => fd4Listeners[0]('{"type":"request_status"}\nnot-json\n')).not.toThrow();
    await expect(bridge.completion).rejects.toThrow(/invalid bridge message/i);
  });

  it('rejects completion when fd4 receives a host event instead of a frontend action', async () => {
    const fd4Listeners: Array<(chunk: string) => void> = [];

    const bridge = await createTuiBridge({
      cwd: '/tmp/qiclaw-launcher-wrong-direction',
      spawnProcess: () => ({
        stdio: [
          null,
          null,
          null,
          { write() { return true; } },
          {
            setEncoding() {},
            on(event, listener) {
              if (event === 'data') {
                fd4Listeners.push(listener as (chunk: string) => void);
              }
            }
          }
        ],
        kill() {
          return true;
        },
        once() {
          return this;
        }
      } as never),
      binaryPath: '/tmp/qiclaw-tui',
      onAction: vi.fn(async () => {})
    });

    expect(() => fd4Listeners[0](serializeBridgeMessage({ type: 'status', text: 'ready' }))).not.toThrow();
    await expect(bridge.completion).rejects.toThrow(/unexpected host event on action pipe/i);
  });

  it('serializes action handling and rejects completion when an action handler fails', async () => {
    const actionHandler = vi.fn(async (action: { type: string }) => {
      observedOrder.push(`start:${action.type}`);
      if (action.type === 'request_status') {
        await firstGate;
      }
      if (action.type === 'clear_session') {
        throw new Error('action failed');
      }
      observedOrder.push(`finish:${action.type}`);
    });
    const fd4Listeners: Array<(chunk: string) => void> = [];
    const observedOrder: string[] = [];
    let releaseFirstGate: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstGate = resolve;
    });

    const bridge = await createTuiBridge({
      cwd: '/tmp/qiclaw-launcher-serialized',
      spawnProcess: () => ({
        stdio: [
          null,
          null,
          null,
          { write() { return true; } },
          {
            setEncoding() {},
            on(event, listener) {
              if (event === 'data') {
                fd4Listeners.push(listener as (chunk: string) => void);
              }
            }
          }
        ],
        kill() {
          return true;
        },
        once() {
          return this;
        }
      } as never),
      binaryPath: '/tmp/qiclaw-tui',
      onAction: actionHandler as never
    });

    fd4Listeners[0]([
      serializeBridgeMessage({ type: 'request_status' }).trim(),
      serializeBridgeMessage({ type: 'clear_session' }).trim()
    ].join('\n') + '\n');

    await Promise.resolve();
    expect(actionHandler).toHaveBeenCalledTimes(1);
    releaseFirstGate?.();

    await expect(bridge.completion).rejects.toThrow(/action failed/i);
    expect(observedOrder).toEqual([
      'start:request_status',
      'finish:request_status',
      'start:clear_session'
    ]);
  });

  it('disposes the child when onReady fails after spawn', async () => {
    const kill = vi.fn();

    await expect(launchTui({
      cwd: '/tmp/qiclaw-launcher-ready-fail',
      onAction: vi.fn(async () => {}),
      onReady: async () => {
        throw new Error('boot failed');
      },
      createBridge: async () => ({
        send() {},
        dispose: kill,
        completion: Promise.resolve(0)
      })
    } as never)).rejects.toThrow(/boot failed/i);

    expect(kill).toHaveBeenCalledOnce();
  });

  it('forwards prompt, slash, and shell actions from one interactive fd4 burst before exit', async () => {
    const handled: Array<{ type: string }> = [];
    const fd4Listeners: Array<(chunk: string) => void> = [];
    let exitHandler: ((code: number | null) => void) | undefined;

    const bridge = await createTuiBridge({
      cwd: '/tmp/qiclaw-launcher-interactive',
      spawnProcess: () => ({
        stdio: [
          null,
          null,
          null,
          { write() { return true; } },
          {
            setEncoding() {},
            on(event, listener) {
              if (event === 'data') {
                fd4Listeners.push(listener as (chunk: string) => void);
              }
            }
          }
        ],
        kill() {
          return true;
        },
        once(event, listener) {
          if (event === 'exit') {
            exitHandler = listener as (code: number | null) => void;
          }
          return this;
        }
      } as never),
      binaryPath: '/tmp/qiclaw-tui',
      onAction: vi.fn(async (action: { type: string }) => {
        handled.push(action);
      })
    });

    fd4Listeners[0]([
      serializeBridgeMessage({ type: 'submit_prompt', prompt: 'hello from tui' }).trim(),
      serializeBridgeMessage({ type: 'run_slash_command', command: '/status' }).trim(),
      serializeBridgeMessage({ type: 'run_shell_command', command: 'pwd', args: [] }).trim()
    ].join('\n') + '\n');

    await Promise.resolve();
    await Promise.resolve();
    exitHandler?.(0);
    await expect(bridge.completion).resolves.toBe(0);

    expect(handled).toHaveLength(3);
    expect(handled[0]).toMatchObject({ type: 'submit_prompt', prompt: 'hello from tui' });
    expect(handled[1]).toMatchObject({ type: 'run_slash_command', command: '/status' });
    expect(handled[2]).toMatchObject({ type: 'run_shell_command', command: 'pwd', args: [] });
  });
});
