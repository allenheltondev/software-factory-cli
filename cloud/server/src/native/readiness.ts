import type { NativeReadiness } from '../jobs/launch.js';
import type { NativeRoute } from './route.js';
import { imageDecision, type ImagePolicy } from './image-policy.js';
import type { Worker } from './store.js';

/** A worker that heartbeat within this long is live (its interval is 10 s, a call at most 15 s). */
export const HEARTBEAT_FRESH_MS = 60_000;
/**
 * How long a stale heartbeat on a running VM counts as a gap that recovers by itself (a slow
 * broker call, a throttled Lambda, an auth probe). The in-VM dispatcher never restarts its loop,
 * so past this it is lost: the owner reconnects, and cleanup retires the environment (#144).
 */
export const WORKER_LOST_MS = 3 * 60_000;

/** The installation's managed session as dispatch sees it (a pinned route has none). */
export type SessionPhase =
  | { phase: 'none' }
  | { phase: 'retiring' }
  /** Reserved, no VM bound yet: the route carries only the `mvm-pending` placeholder. */
  | { phase: 'pending'; startingUntil: number }
  /** A VM is bound; `startingUntil` is set until the session was first ready. */
  | { phase: 'bound'; startingUntil?: number };

export interface ReadinessContext {
  /** The VM's AWS state, null when AWS no longer has it; undefined when not read. */
  vmState?: string | null;
  imagePolicy?: ImagePolicy;
  /** Until when a VM without a registered worker is still starting (never once it was ready). */
  startingUntil?: number;
  /** Managed routes only: the session record read for this decision. */
  session?: SessionPhase;
}

export const PENDING_MICROVM = 'mvm-pending';

const suspended = (s?: string | null) => s === 'SUSPENDED' || s === 'SUSPENDING';
const ended = (s?: string | null) => s === null || s === 'TERMINATED' || s === 'TERMINATING';

/**
 * Dispatch's readiness rules, pure, so cleanup and the operator trace script decide exactly as
 * the webhook does. Only a bounded startup or heartbeat gap is reported as one to wait for.
 */
export function classifyReadiness(route: NativeRoute, worker: Worker | null, now: number, latestImageVersion?: string, ctx: ReadinessContext = {}): NativeReadiness {
  const session = ctx.session;
  // The session record decides first: with no bound VM there is no worker to judge.
  if (session?.phase === 'none') return 'not-connected';
  if (session?.phase === 'retiring') return 'environment-retiring';
  if (session?.phase === 'pending') return now < session.startingUntil ? 'worker-starting' : 'startup-failed';
  if (route.microvmId === PENDING_MICROVM) return 'not-connected';
  const startingUntil = session?.phase === 'bound' ? session.startingUntil : ctx.startingUntil;
  if (ctx.imagePolicy) {
    if (ctx.imagePolicy.imageVersion !== route.imageVersion) return 'image-unapproved';
    const decision = imageDecision(ctx.imagePolicy, worker?.workerVersion);
    if (decision !== 'approved') return decision;
  } else if (latestImageVersion !== undefined && route.imageVersion !== latestImageVersion) return 'image-unapproved';
  if (!worker || worker.microvmId !== route.microvmId || worker.imageVersion !== route.imageVersion) {
    // No worker has registered for this VM: it is starting, its startup failed, or (once the
    // session was ready) its worker is gone.
    if (suspended(ctx.vmState)) return 'environment-suspended';
    if (ended(ctx.vmState)) return 'environment-ended';
    if (startingUntil !== undefined) return now < startingUntil ? 'worker-starting' : 'startup-failed';
    return 'worker-lost';
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

/**
 * Whether a classification needs the VM's AWS state to be precise. Only a bound VM is ever read:
 * never the placeholder of a session that has not launched.
 */
export const needsVmState = (r: NativeReadiness, route: NativeRoute, session?: SessionPhase) =>
  route.microvmId !== PENDING_MICROVM && (session === undefined || session.phase === 'bound') &&
  (r === 'heartbeat-stale' || r === 'worker-lost' || r === 'worker-starting' || r === 'startup-failed');

/** The session phase of a managed session record, for the route dispatch is judging. */
export function sessionPhase(session: { generation: string; microvmId?: string; retiring?: boolean; readyAt?: number; startupDeadline?: number; requestedAt: number } | undefined,
  route: NativeRoute, startupMs: number): SessionPhase {
  if (!session) return { phase: 'none' };
  if (session.retiring) return { phase: 'retiring' };
  const startingUntil = session.startupDeadline ?? session.requestedAt + startupMs;
  if (!session.microvmId) return { phase: 'pending', startingUntil };
  // The route was resolved from an earlier read: judge it against the session it named. A newer
  // generation means it was replaced, and its job waits for that one.
  if (route.generation !== undefined && route.generation !== session.generation) return { phase: 'pending', startingUntil };
  return { phase: 'bound', ...(session.readyAt ? {} : { startingUntil }) };
}
