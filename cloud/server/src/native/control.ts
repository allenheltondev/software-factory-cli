import { imageDecision, type ImagePolicy } from './image-policy.js';
import { timingSafeEqual } from 'node:crypto';
import { hashToken } from '../broker/broker.js';
import { runHookPayload, type LaunchSettings } from '../jobs/launch.js';
import { isTerminated, unusedTime } from '../jobs/quotas.js';
import { workflowIsPaused } from '../jobs/stop.js';
import type { Job, Store } from '../store/store.js';
import { effectiveRegistryHosts } from './registries.js';
import { nativeJobToken, NATIVE_SLOT_HOLD_UNTIL, type NativeRoute } from './route.js';
import type { AuthState, NativeStore, Worker } from './store.js';

export const WORKER_LEASE_MS = 60_000;
const COMPLETE_ATTEMPTS = 3;
const HANDLE_ATTEMPTS = 4;
const RETRY = Symbol('retry');
const AUTH = new Set(['connected', 'auth-required', 'expired', 'unavailable']);
export interface NativeControlDeps {
  store: Store;
  workers: NativeStore;
  route?: NativeRoute;
  imagePolicy?(): Promise<ImagePolicy>;
  secret(): Promise<string>;
  settings: LaunchSettings;
  terminateMicrovm(id: string): Promise<void>;
  microvmState(id: string): Promise<string | null>;
  disabled(): Promise<boolean>;
  enabled?(): Promise<boolean>;
  now?: () => number;
  /** Structured, credential-free decisions: reuse, retire, cancel. */
  log?: (entry: Record<string, unknown>) => void;
}

/** No task is re-leased. A lost session is physically fenced before capacity is released. */
export function createNativeControl(d: NativeControlDeps) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const refused = { ok: false, error: 'refused' };
  const save = (w: Worker, patch: Partial<Worker>) => d.workers.put({ ...w, ...patch, version: w.version + 1 }, w.version);
  async function fence(w: Worker): Promise<boolean> {
    if (!w.fenced && !await save(w, { fenced: true })) return false;
    if (!isTerminated(await d.microvmState(w.microvmId))) {
      await d.terminateMicrovm(w.microvmId);
      if (!isTerminated(await d.microvmState(w.microvmId))) return false;
    }
    if (w.active || w.settling) {
      const job = await d.store.getJob((w.active ?? w.settling)!.jobId);
      if (job) {
        await d.store.markStopping(job.jobId);
        await d.store.finishJob(job.jobId, job.stop ? 'canceled' : 'microvm_gone', { at: now() });
        if (job.stop) await d.store.recordJobStop(job, { confirmedAt: now(), error: '', reconnectRequired: true });
        await d.store.releaseJob(job, unusedTime(job, now()));
        await d.store.releaseDelivery(job.installationId, job.deliveryId, job.jobId);
      }
      const current = await d.workers.get(w.installationId, w.workerId);
      if (current?.session === w.session && current.microvmId === w.microvmId && current.fenced) {
        const cleared = { ...current, version: current.version + 1 };
        delete cleared.active;
        delete cleared.settling;
        if (!await d.workers.put(cleared, current.version)) return false;
      }
    }
    return true;
  }
  async function canServe(job: Job): Promise<boolean> {
    if (!job.native) return true;
    const w = await d.workers.get(job.installationId, job.native.workerId);
    const policy = await d.imagePolicy?.();
    const access = policy && imageDecision(policy, w?.workerVersion);
    if (access && access !== 'approved' && access !== 'image-draining') return false;
    return !!w && w.imageVersion === job.imageVersion && (!d.route || job.native.generation === d.route.generation && w.microvmId === d.route.microvmId && w.imageVersion === d.route.imageVersion) && !w.fenced && w.active?.jobId === job.jobId && w.active.until > now() && w.microvmId === job.microvmId;
  }
  async function complete(job: Job): Promise<boolean> {
    if (!job.native) return false;
    // A heartbeat landing between the read and the write is routine for a healthy worker: read
    // again a few times rather than leave the runner retrying (and the slot held) for nothing.
    for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
      const w = await d.workers.get(job.installationId, job.native.workerId);
      if (w?.settling?.jobId === job.jobId) return finishSettlement(w, job);
      if (!w || w.active?.jobId !== job.jobId) return job.releasedAt !== undefined || (await d.store.getJob(job.jobId))?.releasedAt !== undefined;
      // Only the trusted runner's completed job can release a healthy persistent worker.
      if (job.status !== 'finished' || w.fenced || w.active.until <= now()) {
        log({ nativeWorker: 'retire', installationId: job.installationId, jobId: job.jobId,
          reason: job.status !== 'finished' ? 'job_unfinished' : w.fenced ? 'worker_fenced' : 'lease_expired' });
        await fence(w);
        return false;
      }
      const next = { ...w, version: w.version + 1, settling: { jobId: job.jobId } };
      delete next.active;
      // A failed/ambiguous CAS must not free capacity. Once this transition commits,
      // the assignment can never be served again and no new job can be polled yet.
      if (await d.workers.put(next, w.version)) {
        const settled = await finishSettlement(next, job);
        log({ nativeWorker: 'reuse', installationId: job.installationId, jobId: job.jobId, settled });
        return settled;
      }
    }
    return false;
  }
  async function finishSettlement(w: Worker, job: Job): Promise<boolean> {
    if (job.status !== 'finished' || w.settling?.jobId !== job.jobId) return false;
    if (w.fenced) return fence(w);
    // Retain the durable marker through partial failures. Completion retries and
    // reconciliation can repeat releaseJob safely, then make the worker available.
    if (job.stop) await d.store.recordJobStop(job, { confirmedAt: now(), error: '' });
    await d.store.releaseJob(job, unusedTime(job, now()));
    const reused = async () => {
      if (job.stop) await d.store.recordJobStop(job, { reconnectRequired: false });
      return true;
    };
    for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
      const next = { ...w, version: w.version + 1, lastWorkAt: now() };
      delete next.settling;
      if (await d.workers.put(next, w.version)) return reused();
      // The runner's terminate, the dispatcher's settled and reconciliation all finish the same
      // settlement. Losing that race is not a failure: if this exact session and VM no longer
      // hold the job in any form, the release above is confirmed and the worker is free (#144).
      const fresh = await d.workers.get(w.installationId, w.workerId);
      const same = !!fresh && fresh.session === w.session && fresh.microvmId === w.microvmId && !fresh.fenced;
      if (same && fresh.settling?.jobId !== job.jobId && fresh.active?.jobId !== job.jobId) return reused();
      // Fenced, replaced, or reassigned: uncertain, so fail closed.
      if (!same || fresh.settling?.jobId !== job.jobId) return false;
      w = fresh; // still settling this job; another write moved the version on
    }
    return false;
  }
  async function stop(job: Job): Promise<boolean> {
    if (!job.native || !job.stop) return false;
    const w = await d.workers.get(job.installationId, job.native.workerId);
    if (w?.settling?.jobId === job.jobId) return finishSettlement(w, job);
    if (job.releasedAt !== undefined) return true;
    if (w?.active?.jobId === job.jobId) {
      if (job.microvmId && w.microvmId !== job.microvmId) throw new Error('Stopped assignment has a different worker VM');
      // Heartbeats cancel the process tree without renewing this lease. Give the trusted
      // runner time to reap it; only fence the exact assignment if it fails to settle.
      if (!w.fenced && now() < job.stop.requestedAt + WORKER_LEASE_MS && w.active.until > now()) return false;
      return fence(w);
    }
    if (!job.microvmId && w?.active?.jobId !== job.jobId) {
      // A queued job never owns the busy worker. Dequeue it; leave unrelated work alone.
      await d.store.finishJob(job.jobId, 'canceled', { at: now() });
      await d.workers.dequeue(job.installationId, job.native.workerId, job.jobId);
      return true;
    }
    // A completed assignment may have yielded the session to another job. Never kill it.
    throw new Error('Cannot identify the stopped subscription assignment safely');
  }
  async function reconcile(job: Job): Promise<boolean> {
    if (!job.native) return false;
    if (job.stop) return stop(job);
    if (d.imagePolicy && imageDecision(await d.imagePolicy()) === 'image-revoked') {
      const worker = await d.workers.get(job.installationId, job.native.workerId);
      if (worker?.active?.jobId === job.jobId || worker?.settling?.jobId === job.jobId) return fence(worker);
    }
    const w = await d.workers.get(job.installationId, job.native.workerId);
    if (w?.settling?.jobId === job.jobId) return finishSettlement(w, job);
    if (w?.active?.jobId === job.jobId) {
      if (w.fenced || w.active.until <= now() || job.expiresAt <= now()) return fence(w);
      await d.store.holdSlots(job, NATIVE_SLOT_HOLD_UNTIL);
      return false;
    }
    // A job with an attached VM may have completed just before its worker CAS committed.
    if (job.releasedAt !== undefined) { await d.store.releaseJob(job); return true; }
    if (!job.microvmId && (job.expiresAt <= now() || job.status === 'finished')) {
      await d.store.markStopping(job.jobId);
      await d.store.finishJob(job.jobId, 'launch_failed');
      await d.store.releaseJob(job);
      await d.store.releaseDelivery(job.installationId, job.deliveryId, job.jobId);
      await d.workers.dequeue(job.installationId, job.native.workerId, job.jobId);
      return true;
    }
    // Uncertain assignment: retain capacity; never infer safety from a missing worker row.
    await d.store.holdSlots(job, NATIVE_SLOT_HOLD_UNTIL);
    return false;
  }
  async function handle(request: unknown): Promise<Record<string, unknown>> {
    const r = d.route;
    if (!r || !request || typeof request !== 'object') return refused;
    const p = request as Record<string, unknown>;
    if (p.action !== 'worker' || p.workerId !== r.workerId || typeof p.token !== 'string' || p.token.length > 256) return refused;
    const secret = await d.secret();
    if (secret.length < 32 || !timingSafeEqual(Buffer.from(hashToken(secret), 'hex'), Buffer.from(hashToken(p.token), 'hex'))) return refused;
    // Only these scalar fields are persisted. Raw CLI output and arbitrary metadata are rejected.
    if (Object.keys(p).some((k) => !['action', 'op', 'workerId', 'token', 'session', 'microvmId', 'auth', 'imageVersion', 'workerVersion', 'jobId'].includes(k))) return refused;
    if (p.op === 'status') {
      const w = await d.workers.get(r.installationId, r.workerId);
      return { ok: true, worker: w ? { workerId: w.workerId, installationId: w.installationId, auth: w.auth, heartbeatAt: w.heartbeatAt,
        busy: !!(w.active || w.settling), jobId: (w.active ?? w.settling)?.jobId, fenced: !!w.fenced, imageVersion: w.imageVersion, workerVersion: w.workerVersion } : null };
    }
    if (p.op === 'cancel') {
      const job = typeof p.jobId === 'string' ? await d.store.getJob(p.jobId) : null;
      if (!job?.native || job.installationId !== r.installationId || job.native.workerId !== r.workerId) return refused;
      await d.store.markStopping(job.jobId);
      await d.store.finishJob(job.jobId, 'canceled');
      await reconcile(await d.store.getJob(job.jobId) ?? job);
      return { ok: true };
    }
    if (!['register', 'heartbeat', 'poll', 'settled'].includes(String(p.op)) || typeof p.session !== 'string' || !/^[\w-]{16,80}$/.test(p.session) ||
        p.microvmId !== r.microvmId || p.imageVersion !== r.imageVersion || typeof p.workerVersion !== 'string' || !/^[\w.-]{1,64}$/.test(p.workerVersion) || !AUTH.has(String(p.auth))) return refused;
    // A write that loses to another writer (the runner's completion, reconciliation, a second
    // request) is answered from the state that won, read again, rather than refused: the
    // dispatcher stops for good on any refusal, which would strand a healthy session (#144).
    for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
      const result = await step(p as typeof p & { session: string; workerVersion: string }, r, secret);
      if (result !== RETRY) return result;
    }
    log({ nativeWorker: 'refuse', installationId: r.installationId, op: String(p.op), reason: 'write_contention' });
    return refused;
  }
  async function step(p: Record<string, unknown> & { session: string; workerVersion: string }, r: NativeRoute, secret: string): Promise<Record<string, unknown> | typeof RETRY> {
    let w: Worker | null = await d.workers.get(r.installationId, r.workerId);
    if (w && (w.session !== p.session || w.microvmId !== p.microvmId || w.fenced || (w.active && w.active.until <= now()))) {
      if (!await fence(w)) return refused;
      const old = (await d.workers.get(r.installationId, r.workerId))!;
      if (!old.fenced || old.session !== w.session) return refused;
      const replacement: Worker = { version: old.version + 1, installationId: r.installationId, workerId: r.workerId, session: p.session, microvmId: r.microvmId,
        imageVersion: r.imageVersion, workerVersion: p.workerVersion, auth: p.auth as AuthState, heartbeatAt: now() };
      // A terminated session can never register itself again, even after losing its response.
      if (old.session === p.session || old.microvmId === p.microvmId || isTerminated(await d.microvmState(r.microvmId)) || !await d.workers.put(replacement, old.version)) return refused;
      w = replacement;
    }
    if (!w) {
      if (p.op !== 'register' || isTerminated(await d.microvmState(r.microvmId))) return refused;
      const registered: Worker = { version: 1, installationId: r.installationId, workerId: r.workerId, session: p.session, microvmId: r.microvmId,
        imageVersion: r.imageVersion, workerVersion: p.workerVersion, auth: p.auth as AuthState, heartbeatAt: now() };
      if (!await d.workers.put(registered, null)) return refused;
      w = registered;
    }
    if (w.workerVersion !== p.workerVersion) return refused;
    const policy = await d.imagePolicy?.();
    const access = policy && imageDecision(policy, p.workerVersion);
    if (access && access !== 'approved' && access !== 'image-draining') {
      log({ nativeWorker: 'retire', installationId: r.installationId, reason: access, imageVersion: r.imageVersion });
      await fence(w);
      return refused;
    }
    const tenant = await d.store.getTenant(r.installationId, { consistent: true });
    const disabled = tenant?.status !== 'active' || await d.disabled() || (d.enabled ? !await d.enabled() : false);
    if (w.settling) {
      // A heartbeat must not resurrect the retired lease or race its final clear.
      // A runner that exited during settlement can have its dispatcher finish it.
      if (p.op === 'settled') {
        const job = await d.store.getJob(w.settling.jobId);
        if (job && await finishSettlement(w, job)) return { ok: true, busy: false };
      }
      return { ok: true, busy: true, cancel: false };
    }
    if (w.active) {
      if (p.op === 'settled') {
        // The runner exited after reporting its finish, but its own release has not landed (its
        // terminate failed, or is still on its way): settle that exact assignment here. A runner
        // that exited without a finish is uncertain and stays refused, to be fenced.
        const job = await d.store.getJob(w.active.jobId);
        if (job?.native && job.status === 'finished' && await complete(job)) {
          await d.store.markStopping(job.jobId);
          return { ok: true, busy: false };
        }
        return refused;
      }
      if (p.op === 'poll' || p.op === 'register') return refused;
      const job = await d.store.getJob(w.active.jobId);
      const cancel = disabled || !job || job.stopRequestedAt !== undefined || job.expiresAt <= now() || p.auth !== 'connected';
      // The worker stops for good on a cancel, so each one says why.
      if (cancel) log({ nativeWorker: 'cancel', installationId: r.installationId, jobId: w.active.jobId,
        reason: disabled ? 'disabled' : !job ? 'job_missing' : job.stopRequestedAt !== undefined ? 'stop_requested' : job.expiresAt <= now() ? 'job_expired' : 'auth_' + String(p.auth) });
      if (!await save(w, { heartbeatAt: now(), auth: p.auth as AuthState,
        active: { ...w.active, until: cancel ? w.active.until : Math.min(job?.expiresAt ?? now(), now() + WORKER_LEASE_MS) } })) return RETRY;
      return { ok: true, busy: true, cancel };
    }
    if (!await save(w, { heartbeatAt: now(), auth: p.auth as AuthState })) return RETRY;
    w = { ...w, version: w.version + 1 };
    if (p.op !== 'poll' || disabled || access === 'image-draining' || p.auth !== 'connected') return { ok: true, busy: false };
    for (const id of await d.workers.queued(r.installationId, r.workerId)) {
      let job = await d.store.getJob(id);
      if (!job || job.status === 'finished' || job.stopRequestedAt !== undefined || job.expiresAt <= now()) { await d.workers.dequeue(r.installationId, r.workerId, id); continue; }
      if (await workflowIsPaused(d.store, job)) continue;
      if (job.native?.workerId === r.workerId && job.native.generation && r.generation && job.native.generation !== r.generation && !job.microvmId && !job.startedAt) {
        const tokenHash = hashToken(nativeJobToken(secret, job.jobId));
        if (!await d.workers.rebindQueued?.(job, r, tokenHash)) continue;
        job = (await d.store.getJob(id))!;
        log({ nativeWorker: 'reuse', installationId: r.installationId, jobId: id, reason: 'queued_generation_rebound', imageVersion: r.imageVersion });
      }
      if (!job.native || job.native.workerId !== r.workerId || job.installationId !== r.installationId || job.microvmId || !job.launchingAt ||
          job.imageVersion !== r.imageVersion || job.native.generation !== r.generation) continue;
      const token = nativeJobToken(secret, job.jobId);
      if (hashToken(token) !== job.tokenHash) return refused; // rotated control key: drain before rotation
      // The installation's registry hosts (#157), read before the assignment commits so a failed
      // read hands nothing out. Snapshotted for this job: a later change applies from the next one.
      // Bound to this job and to the route's installation, never another's. A stored value that no
      // longer validates gives no hosts (the image's only) and says so; the worker checks again.
      const registryPolicy = await d.store.getRegistryPolicy(r.installationId);
      const registries = effectiveRegistryHosts(registryPolicy);
      if (registries.problem) log({ nativeWorker: 'egress', installationId: r.installationId, jobId: id, reason: registries.problem });
      const egress = { jobId: id, hosts: registries.hosts, version: registryPolicy?.version ?? 0, ...(registries.problem ? { problem: registries.problem } : {}) };
      // Lost to another poll: read again, and the winner's assignment refuses this poll.
      if (!await d.workers.assign(job, w, now(), Math.min(job.expiresAt, now() + WORKER_LEASE_MS), policy)) return RETRY;
      // Assignment is durable before it is handed out. A lost response fences this VM on expiry;
      // it never hands the task out a second time or falls back to BYOK.
      return { ok: true, busy: true, egress, request: { microvmId: r.microvmId, payload: runHookPayload(d.settings, {
        jobId: id, token, deliveryId: job.deliveryId, launchedAt: Date.parse(job.createdAt), eventName: job.eventName,
        notBefore: job.native.notBefore, retry: job.native.retry }) } };
    }
    return { ok: true, busy: false };
  }
  return { handle, canServe, complete, reconcile, stop };
}
