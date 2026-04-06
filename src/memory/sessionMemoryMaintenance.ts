import { existsSync } from 'node:fs';

import {
  lockNudge,
  lockWho,
  verifyMemvid,
  doctorMemvid,
  type Memvid
} from '@memvid/sdk';

import type { MemvidSessionStore } from './memvidSessionStore.js';
import type { SessionMemoryMeta } from './sessionMemoryTypes.js';

type VerifyOptions = Parameters<typeof verifyMemvid>[1];
type DoctorOptions = Parameters<typeof doctorMemvid>[1];

export interface SessionMemoryMaintenanceTarget {
  store: MemvidSessionStore;
  meta: Pick<SessionMemoryMeta, 'memoryPath'>;
  exists?: boolean;
  now?: string;
}

export interface SessionMemoryMaintenanceResult {
  ok: true;
}

export interface SessionMemoryOpenVerifyResult extends SessionMemoryMaintenanceResult {
  verified: boolean;
  meta?: Partial<Pick<SessionMemoryMeta, 'lastVerifiedAt'>>;
}

export interface SessionMemoryDoctorOptions {
  memoryPath: string;
  options?: DoctorOptions;
}

export async function verifySessionStoreOnOpen(
  input: SessionMemoryMaintenanceTarget,
  options?: VerifyOptions
): Promise<SessionMemoryOpenVerifyResult> {
  const memoryPath = input.meta.memoryPath;
  const exists = input.exists ?? existsSync(memoryPath);

  if (!exists) {
    return { ok: true, verified: false };
  }

  const memvid = input.store.memvidInstance();
  if (memvid && typeof memvid.verify === 'function') {
    await memvid.verify(options);
  } else {
    await verifyMemvid(memoryPath, options);
  }

  return {
    ok: true,
    verified: true,
    meta: {
      lastVerifiedAt: input.now ?? new Date().toISOString()
    }
  };
}

export async function ensureSessionStoreWriteReady(input: SessionMemoryMaintenanceTarget): Promise<SessionMemoryMaintenanceResult> {
  const memoryPath = input.meta.memoryPath;
  const exists = input.exists ?? existsSync(memoryPath);

  if (!exists) {
    return { ok: true };
  }

  const lockState = await lockWho(memoryPath) as { locked?: boolean; owner?: string };
  if (lockState?.locked) {
    const nudged = await lockNudge(memoryPath);
    if (!nudged) {
      throw new Error(
        typeof lockState.owner === 'string' && lockState.owner.length > 0
          ? `Session memory is locked by ${lockState.owner}`
          : 'Session memory is locked by another writer'
      );
    }
  }

  return { ok: true };
}

export async function runSessionStoreDoctor(
  input: SessionMemoryDoctorOptions,
  memvid?: Pick<Memvid, 'doctor'>
): Promise<unknown> {
  if (memvid && typeof memvid.doctor === 'function') {
    return memvid.doctor(input.options);
  }

  return doctorMemvid(input.memoryPath, input.options);
}
