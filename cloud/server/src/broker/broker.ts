import { createHash, timingSafeEqual } from 'node:crypto';
import type { GitHubApi } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import { OFF_SWITCH, type KillSwitch } from '../jobs/kill-switch.js';
import { dayOf, isTerminated, unusedTime, type ThrottleNotice } from '../jobs/quotas.js';
import { isFailure, type Job, type Store } from '../store/store.js';
import { AGENT_KEY_NAMES, agentKeySecretName, agentKeySecretPrefix } from '../tenants/agent-keys.js';
// Not from publish.ts, which pulls in the CLI's validator.
import { configPrefix } from '../tenants/paths.js';

/**
 * The job broker (#68, "Isolation between tenants"): what a job's microVM may have, handed out to
 * whoever holds that job's token and to nobody else.
 *
 * A microVM's execution role can do almost nothing but invoke this function. Every job of every
 * tenant runs with that one role, so the role itself must not be able to read any tenant's data:
 * a compromised runner (root in the microVM) could otherwise read every other tenant's config,
 * keys, state and results, and with the platform App's key reach every installation. Instead the
 * runner presents the single-use, unguessable job token from its run-hook payload, and gets:
 *
 *   start / credentials   the job's descriptor (bucket and keys) and AWS credentials for an hour,
 *                         from AssumeRole with a session policy that reaches only this tenant's
 *                         prefix (this job's event, config version and results; the tenant's
 *                         state) and only this tenant's agent key secrets. `start` also holds
 *                         the delivery's claim and the job's quota slots for its lifetime
 *                         (refused if another job holds one by then), and charges the month its
 *                         maximum duration in microVM time
 *   github-token          an installation token for the job's one repository with only the
 *                         permissions a job needs, as the CLI's token file (#77)
 *   finish                the job is over; nothing more is served for it. Whatever the job's state,
 *                         and safe to repeat: a retried finish redoes what a failed one left undone
 *   terminate            stop the job's own microVM (as the launcher recorded it), whatever the
 *                         job's state; the shared execution role cannot terminate microVMs. The job
 *                         is retired at once (nothing more is served, it can never start). Its
 *                         quota slots are freed and the microVM time it did not use refunded once
 *                         Lambda shows the microVM TERMINATED, here or by reconciliation
 *
 * `credentials` and `github-token` serve only a job whose `start` committed. A refused `start`
 * retires the job and asks Lambda to stop its microVM, but keeps its slots: the microVM holds
 * that capacity until it is seen terminated.
 *
 * Refused alike, so nothing can be probed: an unknown job, a wrong token, a finished or expired
 * job, a tenant that is no longer active, and anything but finish and terminate while the
 * platform's kill switch is on.
 */

/** What a job's installation token may do: the publication permissions, nothing administrative. */
export const JOB_PERMISSIONS: Record<string, string> = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
};

/** Role chaining (the broker's own role assumes the data role) caps a session at an hour. */
export const SESSION_SECONDS = 3600;

export interface JobPaths {
  eventKey: string;
  configPrefix: string;
  resultKeyPrefix: string;
  stateKey: string;
}

/** Where a job's data is, all under its tenant's prefix of the tenant bucket. */
export function jobPaths(job: Pick<Job, 'installationId' | 'configVersion' | 'deliveryId'>): JobPaths {
  const base = `tenants/${job.installationId}/`;
  return {
    eventKey: `${base}events/${job.deliveryId}/event.json`,
    configPrefix: configPrefix(job.installationId, job.configVersion),
    resultKeyPrefix: `${base}results/${job.deliveryId}/`,
    stateKey: `${base}state/state.db`,
  };
}

export interface PolicyContext {
  bucket: string;
  partition: string;
  region: string;
  accountId: string;
}

/**
 * The session policy for one job. AWS intersects it with the data role's own policy, so the
 * credentials can never reach more than this, whatever the role allows.
 */
export function jobSessionPolicy(job: Pick<Job, 'installationId' | 'configVersion' | 'deliveryId'>, ctx: PolicyContext) {
  const p = jobPaths(job);
  const bucketArn = `arn:${ctx.partition}:s3:::${ctx.bucket}`;
  const statePrefix = p.stateKey.slice(0, p.stateKey.lastIndexOf('/') + 1);
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: 's3:GetObject', Resource: [`${bucketArn}/${p.eventKey}`, `${bucketArn}/${p.configPrefix}*`] },
      // Listing is how the runner learns the config's file names and whether a state database exists.
      { Effect: 'Allow', Action: 's3:ListBucket', Resource: bucketArn, Condition: { StringLike: { 's3:prefix': [`${p.configPrefix}*`, `${statePrefix}*`] } } },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${bucketArn}/${statePrefix}*` },
      { Effect: 'Allow', Action: 's3:PutObject', Resource: `${bucketArn}/${p.resultKeyPrefix}*` },
      {
        Effect: 'Allow',
        Action: 'secretsmanager:GetSecretValue',
        Resource: `arn:${ctx.partition}:secretsmanager:${ctx.region}:${ctx.accountId}:secret:${agentKeySecretPrefix(job.installationId)}*`,
      },
    ],
  };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO time. */
  expiration: string;
}

export interface BrokerDeps {
  store: Store;
  loadSettings: LoadSettings;
  github: Pick<GitHubApi, 'createInstallationToken' | 'getBotUser'>;
  /** sts:AssumeRole on the job data role with this session policy. */
  assumeRole(input: { sessionName: string; policy: string; durationSeconds: number }): Promise<ScopedCredentials>;
  /** lambda:TerminateMicrovm, with the broker's role. */
  terminateMicrovm(microvmId: string): Promise<void>;
  /** lambda:GetMicrovm: the microVM's state, or null when Lambda has no such microVM. */
  microvmState(microvmId: string): Promise<string | null>;
  /** Posts the over-quota comment for a job refused at start (once a day per issue). */
  notifyThrottled?: (notice: ThrottleNotice) => Promise<void>;
  /** Pause between looks at a microVM that was asked to stop. */
  stopCheckDelayMs?: number;
  log?: (entry: Record<string, unknown>) => void;
  policy: PolicyContext;
  /** Absent: never engaged. */
  killSwitch?: KillSwitch;
  now?: () => number;
}

export type BrokerResponse =
  | { ok: true; descriptor: JobPaths & { bucket: string; region: string; agentKeySecrets: Record<string, string> }; credentials: ScopedCredentials }
  | { ok: true; tokenFile: Record<string, unknown> }
  | { ok: true; finished: true }
  | { ok: true; terminated: true }
  | { ok: false; error: 'refused' | 'bad_request' | 'unavailable' };

const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const OUTCOME = /^[a-z_]{1,40}$/;
const REFUSED: BrokerResponse = { ok: false, error: 'refused' };
/** A job that started after a redelivery's job had taken its delivery's claim: it never runs. */
export const SUPERSEDED_OUTCOME = 'superseded';
/** A job that started after another job had taken one of its quota slots: it never runs. */
export const THROTTLED_OUTCOME = 'throttled';

export function createBroker(deps: BrokerDeps) {
  const now = deps.now ?? Date.now;
  const killSwitch = deps.killSwitch ?? OFF_SWITCH;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const bots = new Map<string, { id: number; login: string }>();

  /** The job, if the token is its token; else null. */
  async function verify(jobId: unknown, token: unknown): Promise<Job | null> {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId) || typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const job = await deps.store.getJob(jobId);
    if (!job) return null;
    const given = Buffer.from(hashToken(token), 'hex');
    const stored = Buffer.from(job.tokenHash, 'hex');
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
    return job;
  }

  /** Whether a verified job may still be served. */
  async function servable(job: Job): Promise<boolean> {
    if (job.status === 'finished' || job.stopRequestedAt !== undefined || now() > job.expiresAt) return false;
    // Strongly consistent, like the job: a suspend or uninstall that has committed stops the next
    // request, rather than one that happens to read a stale replica.
    const tenant = await deps.store.getTenant(job.installationId, { consistent: true });
    return tenant?.status === 'active';
  }

  /** Whether Lambda shows the microVM terminated (or gone), looking a few times after the terminate. */
  async function seenTerminated(microvmId: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (isTerminated(await deps.microvmState(microvmId))) return true;
      if (attempt < 4) await new Promise((r) => setTimeout(r, (deps.stopCheckDelayMs ?? 500) * attempt));
    }
    return false;
  }

  /** Asks Lambda to stop a refused job's microVM, if the launcher has recorded it; the runner asks too. */
  async function requestStop(job: Job): Promise<void> {
    if (!job.microvmId) return;
    await deps.terminateMicrovm(job.microvmId).catch((err: unknown) => log({ jobId: job.jobId, warning: `could not stop the refused microVM: ${(err as Error)?.name}` }));
  }

  /** A job refused at start for a quota: recorded as throttled, with the comment on its issue once a day. */
  async function throttledAtStart(job: Job, limit: ThrottleNotice['limit']): Promise<void> {
    const at = now();
    const notice = job.issue !== undefined ? { repositoryId: job.repositoryId, issue: job.issue, day: dayOf(at) } : undefined;
    const first = await deps.store.recordThrottle(job.installationId, job.createdAt.slice(0, 7), notice);
    log({ jobId: job.jobId, installationId: job.installationId, throttled: limit, at: 'start' });
    if (first && job.issue !== undefined && job.quotas && deps.notifyThrottled) {
      await deps
        .notifyThrottled({ installationId: job.installationId, repository: job.repository, repositoryId: job.repositoryId, issue: job.issue, limit, quotas: job.quotas })
        .catch((err: unknown) => log({ jobId: job.jobId, warning: `could not comment on the issue: ${(err as Error)?.message}` }));
    }
  }

  return async function handle(request: unknown): Promise<BrokerResponse> {
    if (typeof request !== 'object' || request === null) return { ok: false, error: 'bad_request' };
    const { action, jobId, token, outcome } = request as Record<string, unknown>;
    if (action !== 'start' && action !== 'credentials' && action !== 'github-token' && action !== 'finish' && action !== 'terminate') {
      return { ok: false, error: 'bad_request' };
    }
    const job = await verify(jobId, token);
    if (!job) return REFUSED;

    // Stopping the job's own microVM is allowed whatever the job's state (finished, expired, its
    // tenant suspended): it only ever ends that one microVM, which the launcher recorded. The
    // execution role every job shares cannot terminate microVMs at all, so a runner cannot stop
    // another tenant's.
    if (action === 'terminate') {
      // Retired first, whatever its outcome: a job being stopped is served nothing more, and a
      // delayed start can never admit it.
      await deps.store.markStopping(job.jobId);
      if (!job.microvmId) return { ok: false, error: 'unavailable' };
      await deps.terminateMicrovm(job.microvmId);
      // The job's quota capacity follows its microVM, not its outcome: freed (and its unused time
      // refunded) once Lambda shows the microVM TERMINATED. Usually it is not yet (the /terminate
      // hook runs first); reconciliation (jobs/reconcile.ts) releases it on a later run.
      let terminated = false;
      try {
        terminated = await seenTerminated(job.microvmId);
      } catch (err) {
        log({ jobId: job.jobId, warning: `could not read the microVM's state: ${(err as Error)?.name}` });
      }
      if (terminated) await deps.store.releaseJob(job, unusedTime(job, now()));
      return { ok: true, terminated: true };
    }

    // Finishing only ever takes away (nothing more is served for the job) and gives up this job's
    // own claim, so it is allowed whatever the job's state, and repeatable: the first outcome is
    // kept, and a finish retried because releasing the claim failed releases it this time. The
    // claim is released only if this job holds it; a redelivery's job keeps its own. The quota
    // slots stay: the microVM may still be running (terminate frees them).
    if (action === 'finish') {
      const given = typeof outcome === 'string' && OUTCOME.test(outcome) ? outcome : 'unknown';
      const recorded = (await deps.store.finishJob(job.jobId, given)) ?? given;
      // Redelivering the webhook is how a failed job is retried: anything but a clean success
      // gives up the delivery's claim, so the launcher starts a job for the redelivery.
      if (recorded !== 'succeeded') await deps.store.releaseDelivery(job.installationId, job.deliveryId, job.jobId);
      // The key's "last used": this job ran with it (it started) and it worked or it did not.
      // Best effort: a failure here must not fail the job's finish.
      if (job.agentKeys?.length && job.startedAt !== undefined && (recorded === 'succeeded' || (isFailure(recorded) && recorded !== 'terminated'))) {
        const use = { at: new Date(now()).toISOString(), ok: recorded === 'succeeded', jobStartedAt: new Date(job.startedAt).toISOString() };
        await Promise.all(job.agentKeys.map((name) => deps.store.recordAgentKeyUse(job.installationId, name, use))).catch((err: unknown) =>
          log({ jobId: job.jobId, warning: `could not record the key use: ${(err as Error)?.name}` }),
        );
      }
      return { ok: true, finished: true };
    }

    if (!(await servable(job))) return REFUSED;
    if (await killSwitch.engaged()) return REFUSED;

    // The launcher's claim on the delivery and its quota slots are short, so they run out on their
    // own if the launch never got this far (its Lambda stopped before RunMicrovm, say). A job that
    // does start holds them for as long as it may run; if another job holds one by now (a
    // redelivery's, or another launch in its slot), that one runs, not this.
    if (action === 'start') {
      const started = await deps.store.startJob(job, job.expiresAt);
      if (started.result === 'retired') return REFUSED;
      if (started.result === 'superseded' || started.result === 'throttled') {
        // It is served nothing and charged nothing, but its microVM is running: the slots it still
        // has are held as long as it may run, until Lambda shows it terminated (reconciliation).
        await deps.store.markStopping(job.jobId);
        await deps.store.finishJob(job.jobId, started.result === 'superseded' ? SUPERSEDED_OUTCOME : THROTTLED_OUTCOME);
        await deps.store.holdSlots(job, job.expiresAt);
        await requestStop(job);
        if (started.result === 'throttled') {
          await deps.store.releaseDelivery(job.installationId, job.deliveryId, job.jobId);
          await throttledAtStart(job, started.limit);
        }
        return REFUSED;
      }
    } else if (job.startedAt === undefined) {
      // Credentials and tokens only for a job whose start committed (its quota admission).
      return REFUSED;
    }

    if (action === 'start' || action === 'credentials') {
      const credentials = await deps.assumeRole({
        sessionName: `job-${job.jobId}`.slice(0, 64),
        policy: JSON.stringify(jobSessionPolicy(job, deps.policy)),
        durationSeconds: SESSION_SECONDS,
      });
      // The tenant's key secrets by variable name; the runner reads them with the credentials (a
      // missing one is a key the tenant has not set).
      const agentKeySecrets = Object.fromEntries(AGENT_KEY_NAMES.map((name) => [name, agentKeySecretName(job.installationId, name)]));
      return { ok: true, descriptor: { ...jobPaths(job), bucket: deps.policy.bucket, region: deps.policy.region, agentKeySecrets }, credentials };
    }

    // github-token: a token for this job's repository only, as the CLI reads it (token-file-auth.ts).
    const settings = await deps.loadSettings();
    if (!settings) return { ok: false, error: 'unavailable' };
    const minted = await deps.github.createInstallationToken(appJwt(settings.appId, settings.privateKey, now()), job.installationId, {
      repositoryIds: [job.repositoryId],
      permissions: JOB_PERMISSIONS,
    });
    let bot = bots.get(settings.slug);
    if (!bot) {
      bot = await deps.github.getBotUser(minted.token, settings.slug);
      bots.set(settings.slug, bot);
    }
    return {
      ok: true,
      tokenFile: {
        app: { id: Number(settings.appId), slug: settings.slug },
        installationId: job.installationId,
        token: minted.token,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        permissions: minted.permissions ?? JOB_PERMISSIONS,
        repositories: [job.repository],
        bot,
      },
    };
  };
}

export type Broker = ReturnType<typeof createBroker>;
