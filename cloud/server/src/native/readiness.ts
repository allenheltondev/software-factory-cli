import type { NativeReadiness } from '../jobs/launch.js';
import type { NativeRoute } from './route.js';
import type { Worker } from './store.js';

/** A worker that heartbeat within this long is live (its interval is 10 s, a call at most 15 s). */
export const HEARTBEAT_FRESH_MS = 60_000;
/**
 * How long a stale heartbeat on a running VM counts as a gap that recovers by itself (a slow
 * broker call, a throttled Lambda, an auth probe). The in-VM dispatcher never restarts its loop,
 * so past this it is lost: the owner reconnects, and cleanup retires the environment (#144).
 */
export const WORKER_LOST_MS = 3 * 60_000;

export interface ReadinessContext {
  /** The VM's AWS state, null when AWS no longer has it; undefined when not read. */
  vmState?: string | null;
  /** Until when a VM without a registered worker is still starting (never once it was ready). */
  startingUntil?: number;
}

const suspended = (s?: string | null) => s === 'SUSPENDED' || s === 'SUSPENDING';
const ended = (s?: string | null) => s === null || s === 'TERMINATED' || s === 'TERMINATING';

/**
 * Dispatch's readiness rules, pure, so cleanup and the operator trace script decide exactly as
 * the webhook does. Only a bounded startup or heartbeat gap is reported as one to wait for.
 */
export function classifyReadiness(route: NativeRoute, worker: Worker | null, now: number, latestImageVersion?: string, ctx: ReadinessContext = {}): NativeReadiness {
  if (latestImageVersion !== undefined && route.imageVersion !== latestImageVersion) return 'image-outdated';
  if (!worker || worker.microvmId !== route.microvmId || worker.imageVersion !== route.imageVersion) {
    // No worker has registered for this VM: it is starting, or its startup failed.
    if (suspended(ctx.vmState)) return 'environment-suspended';
    if (ended(ctx.vmState)) return 'environment-ended';
    return ctx.startingUntil !== undefined && now < ctx.startingUntil ? 'worker-starting' : 'worker-lost';
  }
  if (worker.fenced) return 'fenced';
  const age = now - worker.heartbeatAt;
  if (age > HEARTBEAT_FRESH_MS) {
    if (suspended(ctx.vmState)) return 'environment-suspended';
    if (ended(ctx.vmState)) return 'environment-ended';
    return age > WORKER_LOST_MS ? 'worker-lost' : 'heartbeat-stale';
  }
  if (worker.auth === 'auth-required') return 'auth-required';
  if (worker.auth === 'expired') return 'expired';
  return worker.auth === 'connected' ? 'ready' : 'auth-unavailable';
}

/** Whether a classification needs the VM's AWS state to be precise (only these paths read it). */
export const needsVmState = (r: NativeReadiness) => r === 'heartbeat-stale' || r === 'worker-lost' || r === 'worker-starting';
