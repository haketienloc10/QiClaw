import { existsSync } from 'node:fs';

import type { FileSessionStore } from './fileSessionStore.js';
import type { GlobalMemoryStore } from './globalMemoryStore.js';
import type { SessionMemoryMeta } from './sessionMemoryTypes.js';

export interface SessionMemoryMaintenanceTarget {
  store: FileSessionStore | GlobalMemoryStore;
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
  options?: {
    dryRun?: boolean;
  };
}

export async function verifySessionStoreOnOpen(
  input: SessionMemoryMaintenanceTarget,
  _options?: unknown
): Promise<SessionMemoryOpenVerifyResult> {
  const memoryPath = input.meta.memoryPath;
  const exists = input.exists ?? existsSync(memoryPath);

  if (!exists || isFileBasedMemoryPath(memoryPath)) {
    return { ok: true, verified: false };
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

  if (!exists || isFileBasedMemoryPath(memoryPath)) {
    return { ok: true };
  }

  throw new Error(`Session memory path is not file-based: ${memoryPath}`);
}

export async function runSessionStoreDoctor(
  input: SessionMemoryDoctorOptions,
  doctor?: { doctor(options?: { dryRun?: boolean }): Promise<unknown> | unknown }
): Promise<unknown> {
  if (doctor && typeof doctor.doctor === 'function') {
    return doctor.doctor(input.options);
  }

  return {
    repaired: false,
    skipped: true,
    memoryPath: input.memoryPath,
    dryRun: input.options?.dryRun ?? false
  };
}

function isFileBasedMemoryPath(memoryPath: string): boolean {
  return /(?:^|\/)index\.json$/u.test(memoryPath);
}
