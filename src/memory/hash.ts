import { createHash } from 'node:crypto';

export function createSessionMemoryHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function isHashPrefixMatch(hash: string, prefix: string): boolean {
  return prefix.length > 0 && hash.startsWith(prefix.toLowerCase());
}
