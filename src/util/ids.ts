import { randomBytes } from 'node:crypto';

/**
 * Time-sortable identifier: <prefix>_<base36 millis><8 hex random>.
 * Stable once created; used for job and run IDs and any later GitHub writes.
 */
export function newId(prefix: 'job' | 'run' | 'wrk'): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(4).toString('hex');
  return `${prefix}_${time}${rand}`;
}

export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}
