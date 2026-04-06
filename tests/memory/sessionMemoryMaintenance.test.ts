import { describe, expect, it, vi } from 'vitest';

import { MemvidSessionStore } from '../../src/memory/memvidSessionStore.js';
import {
  ensureSessionStoreWriteReady,
  verifySessionStoreOnOpen
} from '../../src/memory/sessionMemoryMaintenance.js';

vi.mock('@memvid/sdk', () => ({
  lockNudge: vi.fn(async () => false),
  lockWho: vi.fn(async () => ({ locked: false })),
  verifyMemvid: vi.fn(async () => ({ ok: true }))
}));

describe('sessionMemoryMaintenance', () => {
  it('skips verify when the mv2 file does not exist yet', async () => {
    const store = {
      paths: () => ({ memoryPath: '/tmp/new.mv2', metaPath: '/tmp/new.meta.json', directoryPath: '/tmp' }),
      memvidInstance: () => undefined
    } as unknown as MemvidSessionStore;

    const result = await verifySessionStoreOnOpen({
      store,
      meta: {
        memoryPath: '/tmp/new.mv2'
      },
      exists: false
    });

    expect(result).toEqual({ ok: true, verified: false });
  });

  it('runs doctor explicitly through the memvid instance when provided', async () => {
    const doctor = vi.fn(async () => ({ repaired: false }));

    const result = await import('../../src/memory/sessionMemoryMaintenance.js').then(({ runSessionStoreDoctor }) =>
      runSessionStoreDoctor({ memoryPath: '/tmp/doctor.mv2', options: { dryRun: true } }, { doctor })
    );

    expect(doctor).toHaveBeenCalledWith({ dryRun: true });
    expect(result).toEqual({ repaired: false });
  });

  it('rejects write readiness when the store is locked by another writer', async () => {
    const sdk = await import('@memvid/sdk');
    vi.mocked(sdk.lockWho).mockResolvedValueOnce({ locked: true, owner: 'other-process' } as never);

    const store = {
      paths: () => ({ memoryPath: '/tmp/locked.mv2', metaPath: '/tmp/locked.meta.json', directoryPath: '/tmp' }),
      memvidInstance: () => undefined
    } as unknown as MemvidSessionStore;

    await expect(ensureSessionStoreWriteReady({
      store,
      meta: {
        memoryPath: '/tmp/locked.mv2'
      },
      exists: true
    })).rejects.toThrow(/locked/i);
  });
});
