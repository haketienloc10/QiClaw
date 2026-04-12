import { describe, expect, it, vi } from 'vitest';

import { FileSessionStore } from '../../src/memory/fileSessionStore.js';
import {
  ensureSessionStoreWriteReady,
  verifySessionStoreOnOpen
} from '../../src/memory/sessionMemoryMaintenance.js';

describe('sessionMemoryMaintenance', () => {
  it('skips verify when the file-based index does not exist yet', async () => {
    const store = {
      paths: () => ({ memoryPath: '/tmp/memory/index.json', metaPath: '/tmp/memory/meta.json', directoryPath: '/tmp/memory' }),
      storeInstance: () => undefined
    } as unknown as FileSessionStore;

    const result = await verifySessionStoreOnOpen({
      store,
      meta: {
        memoryPath: '/tmp/memory/index.json'
      },
      exists: false
    });

    expect(result).toEqual({ ok: true, verified: false });
  });

  it('runs doctor explicitly through the provided doctor implementation when provided', async () => {
    const doctor = vi.fn(async () => ({ repaired: false }));

    const result = await import('../../src/memory/sessionMemoryMaintenance.js').then(({ runSessionStoreDoctor }) =>
      runSessionStoreDoctor({ memoryPath: '/tmp/memory/index.json', options: { dryRun: true } }, { doctor })
    );

    expect(doctor).toHaveBeenCalledWith({ dryRun: true });
    expect(result).toEqual({ repaired: false });
  });

  it('skips verification for file-based index artifacts', async () => {
    const store = {
      paths: () => ({ memoryPath: '/tmp/memory/index.json', metaPath: '/tmp/memory/meta.json', directoryPath: '/tmp/memory' }),
      storeInstance: () => undefined
    } as unknown as FileSessionStore;

    const result = await verifySessionStoreOnOpen({
      store,
      meta: {
        memoryPath: '/tmp/memory/index.json'
      },
      exists: true,
      now: '2026-04-12T11:00:00.000Z'
    });

    expect(result).toEqual({ ok: true, verified: false });
  });

  it('accepts write readiness for file-based index artifacts', async () => {
    const store = {
      paths: () => ({ memoryPath: '/tmp/memory/index.json', metaPath: '/tmp/memory/meta.json', directoryPath: '/tmp/memory' }),
      storeInstance: () => undefined
    } as unknown as FileSessionStore;

    await expect(ensureSessionStoreWriteReady({
      store,
      meta: {
        memoryPath: '/tmp/memory/index.json'
      },
      exists: true
    })).resolves.toEqual({ ok: true });
  });
});
