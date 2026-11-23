import { timingSafeEqual } from 'node:crypto';
import { hashToken } from '../broker/broker.js';
import { runHookPayload, type LaunchSettings } from '../jobs/launch.js';
import { isTerminated, unusedTime } from '../jobs/quotas.js';
import type { Job, Store } from '../store/store.js';
import { nativeJobToken, NATIVE_SLOT_HOLD_UNTIL, type NativeRoute } from './route.js';
import type { AuthState, NativeStore, Worker } from './store.js';

export const WORKER_LEASE_MS = 60_000;
const AUTH = new Set(['connected', 'auth-required', 'expired', 'unavailable']);
export interface NativeControlDeps {
  store: Store;
  workers: NativeStore;
  route?: NativeRoute;
  secret(): Promise<string>;
  settings: LaunchSettings;
  terminateMicrovm(id: string): Promise<void>;
  microvmState(id: string): Promise<string | null>;
  disabled(): Promise<boolean>;
  enabled?(): Promise<boolean>;
  now?: () => number;
}

/** No task is re-leased. A lost session is physically fenced before capacity is released. */
export function createNativeControl(d: NativeControlDeps) {
  const now = d.now ?? Date.now;
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
        await d.store.finishJob(job.jobId, 'microvm_gone', { at: now() });
        await d.store.releaseJob(job, unusedTime(job, now()));
        await d.store.releaseDelivery(job.installationId, job.deliveryId, job.jobId);
      }
    }
    return true;
  }
  async function canServe(job: Job): Promise<boolean> {
    if (!job.native) return true;
    const w = await d.workers.get(job.installationId, job.native.workerId);
    return !!w && !w.fenced && w.active?.jobId === job.jobId && w.active.until > now() && w.microvmId === job.microvmId;
  }
  async function complete(job: Job): Promise<boolean> {
    if (!job.native) return false;
    const w = await d.workers.get(job.installationId, job.native.workerId);
    if (w?.settling?.jobId === job.jobId) return finishSettlement(w, job);
    if (!w || w.active?.jobId !== job.jobId) return job.releasedAt !== undefined;
    // Only the trusted runner's completed job can release a healthy persistent worker.
    if (job.status !== 'finished' || w.fenced || w.active.until <= now()) { await fence(w); return false; }
    const next = { ...w, version: w.version + 1, settling: { jobId: job.jobId } };
    delete next.active;
    // A failed/ambiguous CAS must not free capacity. Once this transition commits,
    // the assignment can never be served again and no new job can be polled yet.
    if (!await d.workers.put(next, w.version)) return false;
    return finishSettlement(next, job);
  }
  async function finishSettlement(w: Worker, job: Job): Promise<boolean> {
    if (job.status !== 'finished' || w.settling?.jobId !== job.jobId) return false;
    // Retain the durable marker through partial failures. Completion retries and
    // reconciliation can repeat releaseJob safely, then make the worker available.
    await d.store.releaseJob(job, unusedTime(job, now()));
    const next = { ...w, version: w.version + 1 };
    delete next.settling;
    return d.workers.put(next, w.version);
  }
  async function reconcile(job: Job): Promise<boolean> {
    if (!job.native) return false;
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
    let w = await d.workers.get(r.installationId, r.workerId);
    if (w && (w.session !== p.session || w.microvmId !== p.microvmId || w.fenced || (w.active && w.active.until <= now()))) {
      if (!await fence(w)) return refused;
      const old = (await d.workers.get(r.installationId, r.workerId))!;
      if (!old.fenced || old.session !== w.session) return refused;
      w = { version: old.version + 1, installationId: r.installationId, workerId: r.workerId, session: p.session, microvmId: r.microvmId,
        imageVersion: r.imageVersion, workerVersion: p.workerVersion, auth: p.auth as AuthState, heartbeatAt: now() };
      // A terminated session can never register itself again, even after losing its response.
      if (old.session === p.session || old.microvmId === p.microvmId || isTerminated(await d.microvmState(r.microvmId)) || !await d.workers.put(w, old.version)) return refused;
    }
    if (!w) {
      if (p.op !== 'register' || isTerminated(await d.microvmState(r.microvmId))) return refused;
      w = { version: 1, installationId: r.installationId, workerId: r.workerId, session: p.session, microvmId: r.microvmId,
        imageVersion: r.imageVersion, workerVersion: p.workerVersion, auth: p.auth as AuthState, heartbeatAt: now() };
      if (!await d.workers.put(w, null)) return refused;
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
      if (p.op === 'poll' || p.op === 'register' || p.op === 'settled') return refused;
      const job = await d.store.getJob(w.active.jobId);
      const cancel = disabled || !job || job.stopRequestedAt !== undefined || job.expiresAt <= now() || p.auth !== 'connected';
      if (!await save(w, { heartbeatAt: now(), auth: p.auth as AuthState,
        active: { ...w.active, until: cancel ? w.active.until : Math.min(job?.expiresAt ?? now(), now() + WORKER_LEASE_MS) } })) return refused;
      return { ok: true, busy: true, cancel };
    }
    if (!await save(w, { heartbeatAt: now(), auth: p.auth as AuthState })) return refused;
    w = { ...w, version: w.version + 1 };
    if (p.op !== 'poll' || disabled || p.auth !== 'connected') return { ok: true, busy: false };
    for (const id of await d.workers.queued(r.installationId, r.workerId)) {
      const job = await d.store.getJob(id);
      if (!job || job.status === 'finished' || job.expiresAt <= now()) { await d.workers.dequeue(r.installationId, r.workerId, id); continue; }
      if (!job.native || job.native.workerId !== r.workerId || job.installationId !== r.installationId || job.microvmId || !job.launchingAt ||
          job.imageVersion !== r.imageVersion || job.native.generation !== r.generation) continue;
      const token = nativeJobToken(secret, job.jobId);
      if (hashToken(token) !== job.tokenHash) return refused; // rotated control key: drain before rotation
      if (!await save(w, { active: { jobId: id, until: Math.min(job.expiresAt, now() + WORKER_LEASE_MS) } })) return refused;
      // Assignment is durable before it is handed out. A lost response fences this VM on expiry;
      // it never hands the task out a second time or falls back to BYOK.
      await d.store.attachMicrovm(id, r.microvmId);
      await d.workers.dequeue(r.installationId, r.workerId, id);
      return { ok: true, busy: true, request: { microvmId: r.microvmId, payload: runHookPayload(d.settings, {
        jobId: id, token, deliveryId: job.deliveryId, launchedAt: Date.parse(job.createdAt), eventName: job.eventName,
        notBefore: job.native.notBefore, retry: job.native.retry }) } };
    }
    return { ok: true, busy: false };
  }
  return { handle, canServe, complete, reconcile };
}
