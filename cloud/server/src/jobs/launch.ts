import { randomBytes } from 'node:crypto';
import { hashToken, jobPaths } from '../broker/broker.js';
import type { Job, Quotas, Store } from '../store/store.js';
import { decideDispatch } from '../tenants/dispatch.js';
import { OFF_SWITCH, type KillSwitch } from './kill-switch.js';
import { dayOf, monthOf, tenantQuotas, type ThrottleNotice } from './quotas.js';

export type { ThrottleNotice } from './quotas.js';

/**
 * The multi-tenant launcher (#68): what the webhook does with a tenant's `issues.labeled`.
 *
 *   1. the tenant: active, with an active config version
 *   2. that version's dispatch rules: the repository (name and id), a trigger label, an allowed actor
 *   3. jobs are on: a MicroVM image version is published (the image build sets it), and the
 *      platform's kill switch is off (kill-switch.ts)
 *   4. deduplication: one job per delivery, per tenant. The launcher's claim is short
 *      (PRELAUNCH_CLAIM_MS), so a launch that stops partway (its Lambda timed out) does not block
 *      a redelivery for long; the job's microVM holds it for its whole lifetime once it starts
 *      (the broker's `start`), and does not run if a redelivery's job has taken it by then
 *   5. quotas (quotas.ts): a slot of the tenant's and of the platform's, the day's jobs and the
 *      month's microVM minutes. Over one: recorded as throttled, the claim given up, one comment a
 *      day on the issue, and nothing started
 *   6. the event body to tenants/<id>/events/<delivery>/event.json
 *   7. the job record: its tenant, repository, label, sender, config and image versions, its
 *      slots and reserved seconds, and the hash of a fresh job token
 *   8. RunMicrovm, with a version 2 run-hook payload: the broker and the job's token, nothing else
 *   9. the microVM's id on the job, which is what lets the broker stop that microVM (and no other)
 *
 * Anything that is not a job answers 200 with why; a failure after the claim answers 500 (so the
 * delivery can be redelivered) and releases the claim and the reservation, so the redelivery is
 * not refused.
 */

export const RUN_HOOK_PAYLOAD_VERSION = 2;

/**
 * How long the launcher's claim on a delivery lasts: well past the webhook Lambda's timeout (20 s)
 * and a microVM's start, after which the job holds the claim itself. A redelivery after this, of a
 * delivery whose launch never got a job running, starts the job again.
 */
export const PRELAUNCH_CLAIM_MS = 5 * 60 * 1000;

/** The Lambda-provided connectors: no inbound traffic, internet egress. */
export const noIngressConnector = (partition: string, region: string) => `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:NO_INGRESS`;
export const internetEgressConnector = (partition: string, region: string) =>
  `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

export interface LaunchSettings {
  region: string;
  bucket: string;
  imageArn: string;
  executionRoleArn: string;
  ingressConnectorArn: string;
  egressConnectorArn: string;
  logGroup: string;
  brokerFunctionName: string;
  maximumDurationSeconds: number;
  watchdogReserveSeconds: number;
}

/** RunMicrovmRequest's fields as used here (@aws-sdk/client-lambda-microvms). */
export interface RunMicrovmInput {
  imageIdentifier: string;
  imageVersion: string;
  executionRoleArn: string;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  maximumDurationInSeconds: number;
  logging: { cloudWatch: { logGroup: string } };
  idlePolicy: { maxIdleDurationSeconds: number; suspendedDurationSeconds: number; autoResumeEnabled: boolean };
  runHookPayload: string;
  /** The job's id: a retried RunMicrovm for the same job starts no second microVM. */
  clientToken: string;
}

export interface LaunchDeps {
  store: Store;
  settings: LaunchSettings;
  /** The published image version; null while jobs are off (no image built yet). */
  imageVersion: () => Promise<string | null>;
  putEvent: (key: string, body: string) => Promise<void>;
  runMicrovm: (input: RunMicrovmInput) => Promise<{ microvmId?: string }>;
  /** The stack's default quotas; a tenant's `limits` override them. */
  quotas: Quotas;
  /** Absent: never engaged. */
  killSwitch?: KillSwitch;
  /** Posts the over-quota comment on the issue (once a day per issue). Its failure is only logged. */
  notifyThrottled?: (input: ThrottleNotice) => Promise<void>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** Retry pause for recording the microVM on the job. */
  retryDelayMs?: number;
}

export interface LaunchRequest {
  installationId: number;
  deliveryId: string;
  /** The webhook body exactly as GitHub sent it (the job reads it as its event). */
  body: string;
  payload: {
    repository?: { id?: unknown; full_name?: unknown };
    label?: { name?: unknown };
    sender?: { login?: unknown };
    issue?: { number?: unknown };
  };
}

export interface LaunchResult {
  status: number;
  disposition: string;
  jobId?: string;
}

// A GitHub delivery id is a GUID; it becomes part of an S3 key, so nothing else is accepted.
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export function createLauncher(deps: LaunchDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const s = deps.settings;
  const killSwitch = deps.killSwitch ?? OFF_SWITCH;

  return async function launch(req: LaunchRequest): Promise<LaunchResult> {
    const skip = (disposition: string): LaunchResult => ({ status: 200, disposition });
    if (!DELIVERY_ID.test(req.deliveryId)) return { status: 400, disposition: 'bad_delivery_id' };
    if (!Number.isInteger(req.payload.issue?.number)) return skip('ignored');

    // Strongly consistent, both: a delivery right after a publish sees the new active config (not
    // "no_config"), and one right after a republish or a suspend does not start a job under the
    // config or the status it replaced.
    const tenant = await deps.store.getTenant(req.installationId, { consistent: true });
    if (!tenant) return skip('no_tenant');
    if (tenant.status !== 'active') return skip('tenant_inactive');
    if (tenant.activeConfigVersion === undefined) return skip('no_config');
    const config = await deps.store.getConfigVersion(req.installationId, tenant.activeConfigVersion, { consistent: true });
    const decision = decideDispatch(config?.dispatch, {
      repositoryFullName: req.payload.repository?.full_name,
      repositoryId: req.payload.repository?.id,
      label: req.payload.label?.name,
      sender: req.payload.sender?.login,
    });
    if (!decision.start) {
      log({ delivery: req.deliveryId, installationId: req.installationId, ignored: decision.reason });
      return skip('not_dispatched');
    }

    const imageVersion = await deps.imageVersion();
    if (!imageVersion) return skip('jobs_off');
    if (await killSwitch.engaged()) {
      log({ delivery: req.deliveryId, installationId: req.installationId, ignored: 'the kill switch is on' });
      return skip('kill_switch');
    }

    const launchedAt = now();
    const durationMs = s.maximumDurationSeconds * 1000;
    const jobId = `job_${randomBytes(12).toString('base64url')}`;
    // Short, until the job starts and holds it for its lifetime; released early (by this job only)
    // when it fails.
    if (!(await deps.store.claimDelivery(req.installationId, req.deliveryId, launchedAt + PRELAUNCH_CLAIM_MS, jobId))) return skip('duplicate');

    // The slots are held for the job's lifetime from the start, before its microVM exists: a launch
    // that later fails gives them back, and one that stops partway (its Lambda timed out) keeps
    // them until reconciliation releases the job. Nothing after RunMicrovm has to extend them.
    const quotas = tenantQuotas(deps.quotas, tenant.limits);
    const day = dayOf(launchedAt);
    const month = monthOf(launchedAt);
    let reserved;
    try {
      reserved = await deps.store.reserveJob({ installationId: req.installationId, jobId, holdUntil: launchedAt + durationMs, day, month, quotas });
    } catch (err) {
      await deps.store.releaseDelivery(req.installationId, req.deliveryId, jobId).catch(() => {});
      throw err;
    }
    if (!reserved.ok) {
      // Not this delivery's to keep: re-applying the label (a new delivery) or redelivering it tries again.
      await deps.store.releaseDelivery(req.installationId, req.deliveryId, jobId).catch(() => {});
      const issue = req.payload.issue!.number as number;
      const first = await deps.store.recordThrottle(req.installationId, month, { repositoryId: decision.repositoryId, issue, day });
      log({ delivery: req.deliveryId, installationId: req.installationId, repository: decision.repository, issue, throttled: reserved.limit });
      if (first && deps.notifyThrottled) {
        await deps
          .notifyThrottled({ installationId: req.installationId, repository: decision.repository, repositoryId: decision.repositoryId, issue, limit: reserved.limit, quotas })
          .catch((err: unknown) => log({ delivery: req.deliveryId, installationId: req.installationId, warning: `could not comment on the issue: ${(err as Error)?.message}` }));
      }
      return skip('throttled');
    }
    const reservation = { installationId: req.installationId, jobId, tenantSlot: reserved.tenantSlot, platformSlot: reserved.platformSlot, day, month };

    const token = randomBytes(32).toString('base64url');
    const sender = req.payload.sender?.login;
    const job: Job = {
      jobId,
      tokenHash: hashToken(token),
      installationId: req.installationId,
      repository: decision.repository,
      repositoryId: decision.repositoryId,
      configVersion: tenant.activeConfigVersion,
      deliveryId: req.deliveryId,
      eventName: 'issues',
      status: 'launched',
      createdAt: new Date(launchedAt).toISOString(),
      expiresAt: launchedAt + durationMs,
      label: decision.label,
      ...(typeof sender === 'string' ? { sender } : {}),
      imageVersion,
      tenantSlot: reserved.tenantSlot,
      platformSlot: reserved.platformSlot,
      reservedSeconds: s.maximumDurationSeconds,
      quotas,
      issue: req.payload.issue!.number as number,
    };

    let recorded = false;
    let launching = false;
    let microvmId: string | undefined;
    try {
      await deps.putEvent(jobPaths(job).eventKey, req.body);
      await deps.store.putJob(job);
      recorded = true;
      // From here a microVM may exist: the reservation is no longer reclaimable as a launch that
      // never got this far.
      await deps.store.markLaunching(jobId);
      launching = true;
      const out = await deps.runMicrovm(runMicrovmInput(s, imageVersion, { jobId, token, deliveryId: req.deliveryId, launchedAt }));
      microvmId = out.microvmId;
    } catch (err) {
      log({ delivery: req.deliveryId, installationId: req.installationId, jobId, error: 'launch failed', name: (err as Error)?.name, message: (err as Error)?.message });
      await deps.store.releaseDelivery(req.installationId, req.deliveryId, jobId).catch(() => {});
      await deps.store.cancelReservation(reservation, launching ? 'launching' : 'reserved').catch(() => {});
      // Nothing runs for this record; its token must not be served, and it needs no reconciling.
      let outcome: string | null = null;
      if (recorded) {
        outcome = await deps.store.finishJob(jobId, 'launch_failed').catch(() => null);
        await deps.store.releaseJob(job).catch(() => {});
      }
      // Finished with another outcome before it could launch: an admin released it, on purpose.
      // Not an error to have GitHub show (and nothing to redeliver).
      if (outcome !== null && outcome !== 'launch_failed') return { status: 200, disposition: 'cancelled', jobId };
      return { status: 500, disposition: 'launch_failed', jobId };
    }

    if (!microvmId) {
      log({ delivery: req.deliveryId, jobId, warning: 'RunMicrovm returned no microVM id; the job cannot stop its own microVM, its maximum duration will' });
    } else {
      // The runner asks the broker to stop "its" microVM, and reconciliation asks Lambda about it:
      // this record is the only link. Retried; if it never lands, the maximum duration ends the
      // microVM (and reconciliation releases the job then).
      let attached = false;
      for (let attempt = 1; attempt <= 3 && !attached; attempt++) {
        try {
          await deps.store.attachMicrovm(jobId, microvmId);
          attached = true;
        } catch (err) {
          if (attempt === 3) log({ delivery: req.deliveryId, jobId, microvmId, warning: `could not record the microVM: ${(err as Error)?.message}` });
          else await new Promise((r) => setTimeout(r, (deps.retryDelayMs ?? 200) * attempt));
        }
      }
    }

    log({ delivery: req.deliveryId, installationId: req.installationId, jobId, microvmId, repository: job.repository, configVersion: job.configVersion, imageVersion, launched: true });
    return { status: 202, disposition: 'launched', jobId };
  };
}

export type Launcher = ReturnType<typeof createLauncher>;

/** The run-hook payload: the broker and the job's token; the runner gets everything else from the broker. */
export function runHookPayload(s: LaunchSettings, job: { jobId: string; token: string; deliveryId: string; launchedAt: number }) {
  return {
    version: RUN_HOOK_PAYLOAD_VERSION,
    deliveryId: job.deliveryId,
    eventName: 'issues',
    region: s.region,
    broker: { functionName: s.brokerFunctionName, jobId: job.jobId, jobToken: job.token },
    maximumDurationSeconds: s.maximumDurationSeconds,
    watchdogReserveSeconds: s.watchdogReserveSeconds,
    launchedAt: new Date(job.launchedAt).toISOString(),
    agentIsolation: 'enforced',
  };
}

export function runMicrovmInput(s: LaunchSettings, imageVersion: string, job: { jobId: string; token: string; deliveryId: string; launchedAt: number }): RunMicrovmInput {
  return {
    imageIdentifier: s.imageArn,
    imageVersion,
    executionRoleArn: s.executionRoleArn,
    // Nobody connects to a job; Lambda still calls its hooks.
    ingressNetworkConnectors: [s.ingressConnectorArn],
    egressNetworkConnectors: [s.egressConnectorArn],
    maximumDurationInSeconds: s.maximumDurationSeconds,
    logging: { cloudWatch: { logGroup: s.logGroup } },
    // A job gets no endpoint traffic, so it is "idle" from the first second: let it be idle for as
    // long as it may live, and never keep a suspended one (as the self-hosted launcher does).
    idlePolicy: { maxIdleDurationSeconds: s.maximumDurationSeconds, suspendedDurationSeconds: 0, autoResumeEnabled: false },
    runHookPayload: JSON.stringify(runHookPayload(s, job)),
    clientToken: job.jobId,
  };
}
