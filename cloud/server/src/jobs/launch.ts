import { waitingId } from '../native/sessions.js';
import { workflowIsPaused } from './stop.js';
import { WorkflowPausedError } from './workflow-gate.js';
import type { NativeMode } from '../native/store.js';
import { randomBytes } from 'node:crypto';
import { legacyNativeTriggers, sameNativeRepository, sameNativeTrigger, nativeJobToken, NATIVE_SLOT_HOLD_UNTIL, type NativeRoute } from '../native/route.js';
import { hashToken, jobPaths } from '../broker/broker.js';
import { NativeEnqueueRejectedError, type Job, type Quotas, type Store } from '../store/store.js';
import { decideDispatch, decidePullRequestDispatch, PULL_REQUEST_ACTIONS, pullRequestOfPayload } from '../tenants/dispatch.js';
import { AGENT_KEY_ENV, SUPPORTED_AGENT_KEY_ENV } from '../tenants/agents.js';
import type { BundleKeys } from '../tenants/key-needs.js';
import { safeMessage } from '../tenants/redact.js';
import { OFF_SWITCH, type KillSwitch } from './kill-switch.js';
import { dayOf, monthOf, tenantQuotas, type ThrottleNotice } from './quotas.js';
import { BENCHMARK_LABEL, isBenchmarkLabel, type BenchmarkIdentity } from '../benchmarks/config.js';

export type { ThrottleNotice } from './quotas.js';

/**
 * The multi-tenant launcher (#68): what the webhook does with a tenant's `issues.labeled`, and with
 * the pull request events of its review loop (`pull_request_review`, `pull_request`).
 *
 *   1. the tenant: active, with an active config version
 *   2. that version's dispatch rules: the repository (name and id), and for an issue a trigger
 *      label and an allowed actor; for a pull request its loop on, an Updraft branch, not the App's
 *      own doing, and an allowed actor for a review or a push (dispatch.ts)
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

/**
 * How long the first accepted event for a pull request holds it (`pr-<repository id>-<number>`):
 * another event for it within this starts no job, and the job starts its run no earlier than the
 * lease's end, so it sees every event folded into it (GitHub sends a review and the push before it
 * close together; two jobs would each find the same review and run an agent on the same branch).
 * The self-hosted launcher's PullRequestCoalesceSeconds, at its default.
 */
export const PR_COALESCE_MS = 20 * 1000;
export const pullRequestLease = (repositoryId: number, number: number) => `pr-${repositoryId}-${number}`;

/**
 * How long an event that found a pull request's lease taken waits for the job holding it to be
 * launched (its microVM recorded) before it calls itself covered. That launch may still fail; until
 * it is confirmed, the event is not acknowledged as coalesced. Within the webhook Lambda's 20 s, with
 * room for a launch of its own if the holder's fails.
 */
export const COALESCE_CONFIRM_MS = 8 * 1000;
const COALESCE_POLL_MS = 500;

/** How many of the tenant's latest jobs are searched for the job that opened a pull request. */
const ORIGIN_LOOKUP_JOBS = 500;

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
  /** The deployment's trusted console origin (https), for job links in GitHub comments; absent: plain IDs. */
  consoleOrigin?: string;
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

export interface NativeLaunch {
  route: NativeRoute;
  secret(): Promise<string>;
  enabled?(): Promise<boolean>;
  mode?(): Promise<NativeMode>;
  ready?(): Promise<boolean>;
  /** Why the worker cannot take a job now (or 'ready'); preferred over ready() when present. */
  readiness?(): Promise<NativeReadiness>;
}

/** Why a subscription worker is not taking a job now; see readinessAction for what it asks of the owner. */
export type NativeReadiness = 'ready' | 'not-connected' | 'image-outdated' | 'image-draining' | 'image-revoked' | 'image-unapproved' | 'protocol-incompatible' | 'worker-starting' | 'startup-failed' | 'worker-lost'
  | 'fenced' | 'heartbeat-stale' | 'environment-retiring' | 'environment-suspended' | 'environment-ended'
  | 'auth-required' | 'expired' | 'auth-unavailable';
/**
 * sign-in: the CLI login is gone or expired. reconnect: this environment can never serve again
 * (suspended with no resume, ended, fenced, its worker lost, or on a retired image). wait: a
 * bounded gap (startup, a heartbeat within its grace, an unreadable auth probe) that a healthy
 * environment recovers from; the parked job starts on the worker's next connected poll.
 */
export function readinessAction(reason: NativeReadiness): 'none' | 'sign-in' | 'reconnect' | 'wait' {
  if (reason === 'ready') return 'none';
  // No session yet: connecting is signing in (the first connection or after a retirement).
  if (reason === 'not-connected' || reason === 'auth-required' || reason === 'expired') return 'sign-in';
  if (['environment-retiring', 'environment-suspended', 'environment-ended', 'fenced', 'worker-lost', 'startup-failed', 'image-outdated', 'image-draining', 'image-revoked', 'image-unapproved', 'protocol-incompatible'].includes(reason)) return 'reconnect';
  return 'wait';
}
export const needsSignIn = (reason: NativeReadiness) => readinessAction(reason) === 'sign-in';
/** The issue comment for a parked job: it asks the owner for sign-in only when auth is gone. */
export function waitingComment(link: string, reason?: NativeReadiness): string {
  const action = reason === undefined ? 'sign-in' : readinessAction(reason);
  if (action === 'reconnect') return `This Updraft job is waiting because the connected Claude environment can no longer run jobs (${reason}). [Open the waiting job in Updraft](${link}) and reconnect Claude; the job resumes automatically once it is connected.`;
  if (action === 'wait') return `This Updraft job is waiting for the connected Claude environment to become available (${reason}). It starts automatically when the environment is ready; no sign-in is needed. [Open the waiting job in Updraft](${link}).`;
  return `This Updraft job is waiting for Claude subscription sign-in. [Open the waiting job in Updraft](${link}). An installation owner can sign in once and the job will resume automatically.`;
}


export interface LaunchDeps {
  stopJob?: (job: Job, returnedMicrovmId?: string) => Promise<unknown>;
  benchmarkInstallationId?: number;
  native?: NativeLaunch;
  resolveNative?(installationId: number): Promise<NativeLaunch | undefined>;
  parkedClaude?(request: LaunchRequest): Promise<string | undefined>;
  waitForClaude?(request: LaunchRequest, repository: string, repositoryId: number, issue: number, reason?: NativeReadiness): Promise<string>;
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
  /** Reads the keys of a version published before dispatch rules recorded them (key-needs.ts). Absent: such a version is refused. */
  bundleKeys?: BundleKeys;
  /** Posts the over-quota comment on the issue (once a day per issue). Its failure is only logged. */
  notifyThrottled?: (input: ThrottleNotice) => Promise<void>;
  /** Records each launched job on its issue's workflow (workflows/recorder.ts). Best effort. */
  workflows?: import('../workflows/recorder.js').WorkflowRecorder;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** Retry pause for recording the microVM on the job. */
  retryDelayMs?: number;
  /** How long a coalesced event waits for the launch covering it, and how often it looks (tests shorten them). */
  coalesceConfirmMs?: number;
  coalescePollMs?: number;
}

export interface LaunchRequest {
  /** Server-owned workflow provenance, used by durable recovery after job retention expires. */
  workflowIssue?: number;
  benchmark?: { identity: BenchmarkIdentity; configVersion: number; configYaml: string; agentKey: string; agent: string; workflow: string };
  installationId: number;
  deliveryId: string;
  /** The X-GitHub-Event header. Absent: `issues`. */
  eventName?: string;
  /** The platform App's own login (`<slug>[bot]`): its reviews and pushes start nothing. */
  appBot?: string;
  /** The webhook body exactly as GitHub sent it (the job reads it as its event). */
  body: string;
  /** A retry from the console (jobs/retry.ts): the job requeues the event's failed jobs in the shared state before it runs. */
  retry?: boolean;
  retryRuntime?: { workerId?: string; resumeOf?: string };
  resumeClaude?: boolean;
  /**
   * The id the job is to have (newJobId), for a caller that must record it before the launch, to
   * find the job again if it never hears how the launch ended. Absent: the launcher chooses.
   */
  jobId?: string;
  payload: {
    action?: unknown;
    repository?: { id?: unknown; full_name?: unknown };
    label?: { name?: unknown };
    sender?: { login?: unknown };
    issue?: { number?: unknown };
    pull_request?: { number?: unknown; head?: { ref?: unknown } };
    review?: { state?: unknown };
    check_suite?: { head_branch?: unknown; pull_requests?: unknown };
  };
}

export interface LaunchResult {
  status: number;
  disposition: string;
  jobId?: string;
  /** Why it started nothing, as a code (dispatch.ts DispatchRefusalCode, or the quota limit). */
  reason?: string;
  /** The same for people (no secret, no AWS message). */
  message?: string;
  /** launch_failed: the error's class. */
  errorClass?: string;
}

// A GitHub delivery id is a GUID; it becomes part of an S3 key, so nothing else is accepted.
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const JOB_ID = /^job_[A-Za-z0-9_-]{16}$/;

/** A new job's id: what the launcher gives a job, and what a caller that chooses it must give. */
export const newJobId = () => `job_${randomBytes(12).toString('base64url')}`;

export function createLauncher(deps: LaunchDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const s = deps.settings;
  const killSwitch = deps.killSwitch ?? OFF_SWITCH;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * A pull request's lease: taken (`held`, this job launches), or another event's job holds it and
   * is confirmed launched (`covered`: its run starts after the lease and sees this event), or that
   * was not confirmed in time (`unconfirmed`). A holder whose launch fails gives the lease back,
   * and this event takes it then, so it is never acknowledged for a job that does not exist.
   */
  async function takeOrJoin(installationId: number, lease: string, jobId: string): Promise<'held' | 'covered' | 'unconfirmed'> {
    const pollMs = deps.coalescePollMs ?? COALESCE_POLL_MS;
    const attempts = Math.max(1, Math.ceil((deps.coalesceConfirmMs ?? COALESCE_CONFIRM_MS) / pollMs));
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt > 0) await sleep(pollMs);
      if (await deps.store.claimDelivery(installationId, lease, now() + PR_COALESCE_MS, jobId)) return 'held';
      const claim = await deps.store.getDeliveryClaim(installationId, lease);
      if (!claim) continue; // given back (a failed launch) or just expired: take it next time round
      const holder = await deps.store.getJob(claim.jobId);
      if (holder && holder.status !== 'finished' && (holder.microvmId !== undefined || holder.startedAt !== undefined || holder.native !== undefined)) return 'covered';
    }
    return 'unconfirmed';
  }

  return async function launch(req: LaunchRequest): Promise<LaunchResult> {
    const skip = (disposition: string, why: { reason?: string; message?: string } = {}): LaunchResult => ({ status: 200, disposition, ...why });
    if (!DELIVERY_ID.test(req.deliveryId)) return { status: 400, disposition: 'bad_delivery_id' };
    if (req.jobId !== undefined && !JOB_ID.test(req.jobId)) return { status: 400, disposition: 'bad_job_id' };
    const eventName = req.eventName ?? 'issues';
    const isIssue = eventName === 'issues';
    const benchmark = req.benchmark;
    if (benchmark ? (!isIssue || req.installationId !== deps.benchmarkInstallationId ||
      req.payload.label?.name !== BENCHMARK_LABEL || !req.jobId)
      : req.installationId === deps.benchmarkInstallationId || isBenchmarkLabel(req.payload.label?.name)) return skip('not_dispatched');
    if (isIssue ? !Number.isInteger(req.payload.issue?.number) : !Object.hasOwn(PULL_REQUEST_ACTIONS, eventName)) return skip('ignored');

    // Strongly consistent, both: a delivery right after a publish sees the new active config (not
    // "no_config"), and one right after a republish or a suspend does not start a job under the
    // config or the status it replaced.
    const tenant = await deps.store.getTenant(req.installationId, { consistent: true });
    if (!tenant) return skip('no_tenant');
    // A pull request action that leads to no work (opened, labeled, ...): before any more reads.
    if (!isIssue && (typeof req.payload.action !== 'string' || !PULL_REQUEST_ACTIONS[eventName]!.includes(req.payload.action))) return skip('ignored');
    if (tenant.status !== 'active') return skip('tenant_inactive');
    const configVersion = benchmark?.configVersion ?? tenant.activeConfigVersion;
    if (configVersion === undefined) return skip('no_config');
    const config = await deps.store.getConfigVersion(req.installationId, configVersion, { consistent: true });
    // What the job is for: an issue (its label) or a pull request (its review loop).
    let decision: { repository: string; repositoryId: number; keys: string[] | null; label?: string; issue?: number; pullRequest?: number };
    const binding = benchmark ? undefined : deps.native?.route.installationId === req.installationId ? deps.native : await deps.resolveNative?.(req.installationId);
    const mode = await binding?.mode?.();
    const triggers = binding ? (mode?.triggers ?? legacyNativeTriggers(binding.route)) : [];
    let workerId = req.retryRuntime?.workerId;
    let workflowIssue = req.workflowIssue;
    if (isIssue) {
      const d = decideDispatch(config?.dispatch, {
        repositoryFullName: req.payload.repository?.full_name,
        repositoryId: req.payload.repository?.id,
        label: req.payload.label?.name,
        sender: req.payload.sender?.login,
      });
      if (!d.start) {
        log({ delivery: req.deliveryId, installationId: req.installationId, ignored: d.reason });
        return skip('not_dispatched', { reason: d.code, message: d.reason });
      }
      decision = { repository: d.repository, repositoryId: d.repositoryId, keys: benchmark ? [benchmark.agentKey] : d.keys, label: d.label, issue: req.payload.issue!.number as number };
    } else {
      const subject = pullRequestOfPayload(eventName, req.payload);
      const d = decidePullRequestDispatch(
        config?.dispatch,
        {
          eventName,
          action: req.payload.action,
          repositoryFullName: req.payload.repository?.full_name,
          repositoryId: req.payload.repository?.id,
          sender: req.payload.sender?.login,
          number: subject.number,
          headRef: subject.headRef,
          reviewState: req.payload.review?.state,
        },
        req.appBot ? { appBot: req.appBot } : {},
      );
      if (!d.start) {
        if (d.code === 'event_not_accepted') return skip('ignored');
        log({ delivery: req.deliveryId, installationId: req.installationId, ignored: d.reason });
        return skip('not_dispatched', { reason: d.code, message: d.reason });
      }
      // The workflow that started the pull request: the label of the job that opened it (its finish
      // recorded this pull request), or of an earlier job of this pull request's loop (which carries
      // that label on), while one is kept. Only an exact match: one issue can have several pull
      // requests, from different workflows. Its keys are the ones checked. A close runs no agent and
      // needs none; a pull request whose origin is not known here is checked by the job itself
      // (run-event fails without the key, and says so on the job).
      let keys: string[] | null = [];
      let label: string | undefined;
      {
        const recent = await deps.store.listRecentJobs(req.installationId, ORIGIN_LOOKUP_JOBS);
        const sameRepo = (j: { repository: string }) => j.repository.toLowerCase() === d.repository.toLowerCase();
        const origin = recent.find((j) => sameRepo(j) && typeof j.label === 'string' && (j.detail?.prNumber === d.pullRequest || j.pullRequest === d.pullRequest));
        const originJob = origin ? await deps.store.getJob(origin.jobId) : null;
        // A failed read is retryable; a missing record is unknown, never evidence of API origin.
        if (!originJob && (mode?.triggers !== undefined || triggers.some((t) => sameNativeRepository(t, d)))) {
          return skip('not_dispatched', { reason: 'native_workflow_unknown', message: 'No kept job identifies this pull request runtime' });
        }
        workerId = originJob?.native?.workerId ?? workerId;
        workflowIssue = await deps.workflows?.issueOfPullRequest(req.installationId, d.repositoryId, d.pullRequest) ?? originJob?.workflowIssue ?? originJob?.issue ?? workflowIssue;
        if (origin?.label) {
          label = origin.label;
          // Only under the version active now, which this job runs: a republish may have changed
          // the workflow's agent, or moved its label to another workflow, and then nothing here
          // names the workflow; the runner follows the one stored for the pull request, and checks
          // its key itself. Under the same version: the keys that job was started with (two
          // workflows can share a label, for different actors), or, once its record is gone (it is
          // kept a week past its run), the label's when the label names one workflow's.
          if (!d.closing && origin.configVersion === tenant.activeConfigVersion) {
            const lower = origin.label.toLowerCase();
            keys = originJob ? (originJob.agentKeys ?? []) : Object.hasOwn(d.keysByLabel, lower) ? (d.keysByLabel[lower] ?? []) : [];
          }
        } else {
          log({ delivery: req.deliveryId, installationId: req.installationId, note: `no kept job names the workflow of pull request #${d.pullRequest}: its keys are left to the job` });
        }
      }
      decision = { repository: d.repository, repositoryId: d.repositoryId, keys, pullRequest: d.pullRequest, ...(label ? { label } : {}) };
    }
    // The issue or pull request the job is for: refusals and over-quota comments name it.
    const number = (decision.issue ?? decision.pullRequest)!;
    if (await workflowIsPaused(deps.store, { installationId: req.installationId, repositoryId: decision.repositoryId,
      issue: decision.issue, pullRequest: decision.pullRequest, workflowIssue,
      resumeOf: req.retry ? req.retryRuntime?.resumeOf : undefined })) return skip('not_dispatched', {
      reason: 'workflow_paused', message: 'An owner stopped this workflow. Resume automation or explicitly retry the stopped job to continue.',
    });

    const selected = isIssue && !req.retryRuntime && (mode?.triggers === undefined || decision.keys?.includes('ANTHROPIC_API_KEY')) && triggers.some((t) => sameNativeTrigger(t, decision));
    const candidate = binding && (selected || workerId === binding.route.workerId) ? binding : undefined;
    const native = candidate && (mode?.enabled ?? await candidate.enabled?.() ?? true) ? candidate : undefined;
    if (req.resumeClaude && !native) return skip('not_dispatched', { reason: 'native_mode_disabled', message: 'This workflow no longer uses Claude subscription routing' });
    if (workerId && !native) return skip('not_dispatched', { reason: 'native_mode_disabled', message: 'The subscription worker is disabled; reconnect it to continue this job' });
    const imageVersion = native?.route.imageVersion ?? await deps.imageVersion();
    if (!imageVersion) return skip('jobs_off');
    if (await killSwitch.engaged()) {
      log({ delivery: req.deliveryId, installationId: req.installationId, ignored: 'the kill switch is on' });
      return skip('kill_switch');
    }

    /** The issue's workflow waits for the sign-in (workflows/recorder.ts); it is blocked if no one signs in. */
    const waitingForSignIn = (jobId: string, action: 'sign-in' | 'reconnect' = 'sign-in') =>
      deps.workflows?.waiting(
        { installationId: req.installationId, repository: decision.repository, repositoryId: decision.repositoryId, eventName, deliveryId: req.deliveryId, jobId, ...(decision.issue !== undefined ? { issue: decision.issue } : {}), ...(decision.pullRequest !== undefined ? { pullRequest: decision.pullRequest } : {}) },
        action === 'sign-in'
          ? {
              reason: 'sign_in_required',
              message: 'The job waits for a Claude subscription sign-in before it can start.',
              nextAction: 'Open the Claude page of this installation and sign in; the job then starts on its own.',
            }
          : {
              reason: 'reconnect_required',
              message: 'The job waits for the Claude subscription to be reconnected before it can start.',
              nextAction: 'Open the Claude page of this installation and reconnect; the job then starts on its own.',
            },
      );
    if (binding?.route.workerId.startsWith('managed-') && !req.resumeClaude && !req.retry) {
      const jobId = await deps.parkedClaude?.(req);
      if (jobId) {
        await waitingForSignIn(jobId);
        return { status: 202, disposition: 'not_dispatched', reason: 'native_waiting_for_sign_in', message: 'Open the Claude sign-in request for this delivery', jobId };
      }
    }
    const readiness: NativeReadiness | undefined = native?.readiness ? await native.readiness()
      // A worker that reports no reason keeps the old meaning of not ready: sign-in.
      : native?.ready ? (await native.ready() ? 'ready' : 'auth-required') : undefined;
    if (native && readiness) {
      // One line per dispatch decision, with no credential or account detail (#144).
      log({ delivery: req.deliveryId, installationId: req.installationId, nativeDispatch: readiness === 'ready' ? 'reuse' : 'wait',
        readiness, ownerAction: readinessAction(readiness), generation: native.route.generation, microvmId: native.route.microvmId, imageVersion: native.route.imageVersion });
    }
    if (native && readiness && readiness !== 'ready') {
      if (native.route.workerId.startsWith('managed-') && decision.issue !== undefined && !req.resumeClaude && !req.retry && deps.waitForClaude) {
        const jobId = await deps.waitForClaude(req, decision.repository, decision.repositoryId, decision.issue, readiness);
        const action = readinessAction(readiness);
        // A wait only a person can end (a sign-in, a reconnect) is the workflow's too.
        if (action === 'sign-in' || action === 'reconnect') await waitingForSignIn(jobId, action);
        return action === 'sign-in'
          ? { status: 202, disposition: 'not_dispatched', reason: 'native_waiting_for_sign_in', message: 'Waiting for Claude subscription sign-in', jobId }
          : action === 'reconnect'
            ? { status: 202, disposition: 'not_dispatched', reason: 'native_waiting_for_reconnect', message: `Waiting for Claude to be reconnected (${readiness})`, jobId }
            : { status: 202, disposition: 'not_dispatched', reason: 'native_waiting_for_worker', message: `Waiting for the connected Claude environment (${readiness})`, jobId };
      }
      return skip('not_dispatched', { reason: 'native_worker_unavailable', message: 'The Claude subscription worker is offline or needs sign-in. Reconnect it before retrying this delivery.' });
    }

    // Bring your own key (#64): the agents this trigger's workflows run need their keys set.
    // Refused here, with the reason recorded for the console, rather than failing in a microVM
    // we pay for. Only the matched trigger's keys: a Codex workflow on another label does not
    // hold up this one. A version published before keys were recorded has them read from its
    // bundle; one whose bundle cannot tell is refused, not run without its keys checked.
    let needed = decision.keys;
    if (needed === null && isIssue) {
      needed = deps.bundleKeys
        ? await deps.bundleKeys.forEvent(req.installationId, configVersion, {
            repositoryFullName: req.payload.repository?.full_name,
            repositoryId: req.payload.repository?.id,
            label: req.payload.label?.name,
            sender: req.payload.sender?.login,
          })
        : null;
    }
    const issueNumber = number;
    const refuse = async (reason: string, detail: Record<string, unknown>) => {
      log({ delivery: req.deliveryId, installationId: req.installationId, repository: decision.repository, refused: 'missing_key', ...detail });
      await deps.store
        .recordRefusal(req.installationId, { at: new Date(now()).toISOString(), deliveryId: req.deliveryId, repository: decision.repository, issue: issueNumber, reason })
        .catch((err: unknown) => log({ delivery: req.deliveryId, warning: `could not record the refusal: ${(err as Error)?.name}` }));
      return skip('missing_key', { reason: 'missing_key', message: reason });
    };
    if (needed === null) return refuse('Updraft could not tell which agent keys this workflow needs: publish the configuration again', { unknown: true });
    // An agent this deployment no longer runs (CloudAgents): a version published while it did
    // names it, and its job would get no key. Refused with what to change.
    if (native) needed = needed.filter((k) => k !== 'ANTHROPIC_API_KEY');
    const offered = new Set(Object.values(AGENT_KEY_ENV));
    const retired = needed.filter((k) => !offered.has(k));
    if (retired.length > 0) {
      const agents = Object.entries(SUPPORTED_AGENT_KEY_ENV).filter(([, k]) => retired.includes(k)).map(([a]) => a);
      return refuse(`This workflow runs ${agents.join(' and ')}, which Updraft Cloud no longer runs here: choose another agent in the configuration and publish it again`, { unavailable: agents });
    }
    if (needed.length > 0) {
      const set = new Set((await deps.store.listAgentKeyMeta(req.installationId)).map((k) => k.name));
      const missing = needed.filter((k) => !set.has(k));
      if (missing.length > 0) {
        return refuse(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set: add ${missing.length > 1 ? 'them' : 'it'} under Agent keys`, { missing });
      }
    }

    const launchedAt = now();
    const durationMs = s.maximumDurationSeconds * 1000;
    const jobId = req.jobId ?? (isIssue && native?.route.workerId.startsWith('managed-')
      ? waitingId(req.installationId, req.deliveryId)
      : newJobId());
    // Secret retrieval can fail transiently. Do it before claiming a delivery or quota,
    // so a failure leaves the event immediately retryable and owns no capacity.
    const token = native ? nativeJobToken(await native.secret(), jobId) : randomBytes(32).toString('base64url');
    // Short, until the job starts and holds it for its lifetime; released early (by this job only)
    // when it fails.
    if (!(await deps.store.claimDelivery(req.installationId, req.deliveryId, launchedAt + (native ? durationMs : PRELAUNCH_CLAIM_MS), jobId))) return skip('duplicate');
    // A pull request's events within PR_COALESCE_MS of one that started a job are that job's: it
    // reads the pull request as it is once the lease is over. This delivery's claim is given up,
    // so a redelivery after that starts a job of its own.
    const lease = decision.pullRequest !== undefined ? pullRequestLease(decision.repositoryId, decision.pullRequest) : undefined;
    const releaseClaims = async () => {
      await deps.store.releaseDelivery(req.installationId, req.deliveryId, jobId).catch(() => {});
      if (lease) await deps.store.releaseDelivery(req.installationId, lease, jobId).catch(() => {});
    };
    let leaseAt = launchedAt;
    if (lease) {
      let covered: 'held' | 'covered' | 'unconfirmed';
      try {
        covered = await takeOrJoin(req.installationId, lease, jobId);
      } catch (err) {
        await deps.store.releaseDelivery(req.installationId, req.deliveryId, jobId).catch(() => {});
        throw err;
      }
      if (covered !== 'held') await deps.store.releaseDelivery(req.installationId, req.deliveryId, jobId).catch(() => {});
      if (covered === 'covered') return skip('coalesced', { message: `a job for pull request #${decision.pullRequest} starts in a few seconds and will see this event` });
      if (covered === 'unconfirmed') {
        // Not acknowledged: GitHub shows the delivery failed, and redelivering it tries again.
        log({ delivery: req.deliveryId, installationId: req.installationId, warning: `the job holding pull request #${decision.pullRequest} was not confirmed launched in time` });
        return { status: 503, disposition: 'coalesce_unconfirmed', message: `a launch for pull request #${decision.pullRequest} was under way and not confirmed: redeliver this event` };
      }
      leaseAt = now();
    }
    const notBefore = lease ? leaseAt + PR_COALESCE_MS + 1000 : undefined;

    // The slots are held for the job's lifetime from the start, before its microVM exists: a launch
    // that later fails gives them back, and one that stops partway (its Lambda timed out) keeps
    // them until reconciliation releases the job. Nothing after RunMicrovm has to extend them.
    const quotas = tenantQuotas(deps.quotas, tenant.limits);
    const day = dayOf(launchedAt);
    const month = monthOf(launchedAt);
    let reserved;
    try {
      reserved = await deps.store.reserveJob({ installationId: req.installationId, jobId, holdUntil: native ? NATIVE_SLOT_HOLD_UNTIL : launchedAt + durationMs, day, month, quotas });
    } catch (err) {
      await releaseClaims();
      throw err;
    }
    if (!reserved.ok) {
      // Not this delivery's to keep: re-applying the label (a new delivery) or redelivering it tries again.
      await releaseClaims();
      const issue = number;
      const first = await deps.store.recordThrottle(req.installationId, month, { repositoryId: decision.repositoryId, issue, day });
      log({ delivery: req.deliveryId, installationId: req.installationId, repository: decision.repository, issue, throttled: reserved.limit });
      if (first && !benchmark && deps.notifyThrottled) {
        await deps
          .notifyThrottled({ installationId: req.installationId, repository: decision.repository, repositoryId: decision.repositoryId, issue, limit: reserved.limit, quotas, ...(decision.pullRequest !== undefined ? { pullRequest: true } : {}) })
          .catch((err: unknown) => log({ delivery: req.deliveryId, installationId: req.installationId, warning: `could not comment on the issue: ${(err as Error)?.message}` }));
      }
      return skip('throttled', { reason: reserved.limit });
    }
    const reservation = { installationId: req.installationId, jobId, tenantSlot: reserved.tenantSlot, platformSlot: reserved.platformSlot, day, month };

    const sender = req.payload.sender?.login;
    const job: Job = {
      jobId,
      tokenHash: hashToken(token),
      ...(req.retryRuntime?.resumeOf ? { resumeOf: req.retryRuntime.resumeOf } : {}),
      ...(workflowIssue !== undefined ? { workflowIssue } : {}),
      installationId: req.installationId,
      repository: decision.repository,
      repositoryId: decision.repositoryId,
      configVersion,
      ...(benchmark ? { benchmark: benchmark.identity, benchmarkAgent: benchmark.agent, benchmarkWorkflow: benchmark.workflow } : {}),
      deliveryId: req.deliveryId,
      eventName,
      ...(native ? { native: { workerId: native.route.workerId, ...(native.route.generation ? { generation: native.route.generation } : {}), ...(mode?.routingVersion !== undefined ? { routingVersion: mode.routingVersion } : {}), ...(notBefore !== undefined ? { notBefore } : {}), ...(req.retry ? { retry: true } : {}) } } : {}),
      status: 'launched',
      createdAt: new Date(launchedAt).toISOString(),
      expiresAt: launchedAt + durationMs,
      ...(decision.label ? { label: decision.label } : {}),
      ...(typeof sender === 'string' ? { sender } : {}),
      imageVersion,
      tenantSlot: reserved.tenantSlot,
      platformSlot: reserved.platformSlot,
      reservedSeconds: s.maximumDurationSeconds,
      quotas,
      ...(needed.length ? { agentKeys: needed } : {}),
      ...(decision.issue !== undefined ? { issue: decision.issue } : {}),
      ...(decision.pullRequest !== undefined ? { pullRequest: decision.pullRequest } : {}),
    };

    let recorded = false;
    let launching = false;
    let microvmId: string | undefined;
    try {
      const paths = jobPaths(job);
      if (benchmark && paths.benchmarkConfigKey) await deps.putEvent(paths.benchmarkConfigKey, benchmark.configYaml);
      await deps.putEvent(paths.eventKey, req.body);
      await deps.store.putJob(job);
      recorded = true;
      // From here a microVM may exist: the reservation is no longer reclaimable as a launch that
      // never got this far.
      await deps.store.markLaunching(jobId);
      launching = true;
      await deps.workflows?.started(job);
      if (native) return { status: 202, disposition: 'launched', jobId };
      const out = await deps.runMicrovm(runMicrovmInput(s, imageVersion, { jobId, token, deliveryId: req.deliveryId, launchedAt, eventName, ...(notBefore !== undefined ? { notBefore } : {}), ...(req.retry ? { retry: true } : {}) }));
      microvmId = out.microvmId;
    } catch (err) {
      if (recorded && err instanceof WorkflowPausedError) {
        const stopped = await deps.store.requestJobStop(job, { requestedAt: now(), by: 'workflow control', reason: 'Workflow paused before launch admission' }, []);
        if (stopped && deps.stopJob) await deps.stopJob(stopped);
        else if (await deps.store.cancelReservation(reservation, 'reserved') === 'cancelled') {
          await deps.store.finishJob(jobId, 'canceled');
          await deps.store.recordJobStop(job, { confirmedAt: now() });
          await deps.store.releaseJob(job);
        }
        return { status: 202, disposition: 'cancelled', jobId };
      }
      if (native && !recorded && err instanceof NativeEnqueueRejectedError) {
        // The mode condition rolled back the enqueue: nothing can execute this reservation.
        await deps.store.cancelReservation(reservation, 'reserved');
        await releaseClaims();
        return { status: 503, disposition: 'launch_failed', jobId, errorClass: errorClassOf(err) };
      }
      // An ambiguous transaction may already have queued this job. Keep its full-duration
      // delivery claim and quota reservation; reconciliation retires it without a duplicate.
      if (native) return { status: 503, disposition: 'launch_failed', jobId, errorClass: errorClassOf(err) };
      log({ delivery: req.deliveryId, installationId: req.installationId, jobId, error: 'launch failed', name: (err as Error)?.name, message: safeMessage(err) });
      await releaseClaims();
      const stopping = recorded ? await deps.store.getJob(jobId).catch(() => null) : null;
      // RunMicrovm may have accepted a request whose response was lost. A canceled attempt
      // retains its capacity and fence until the VM is found or its maximum duration passes.
      if (launching && stopping?.stop) return { status: 202, disposition: 'cancelled', jobId };
      await deps.store.cancelReservation(reservation, launching ? 'launching' : 'reserved').catch(() => {});
      // Nothing runs for this record; its token must not be served, and it needs no reconciling.
      let outcome: string | null = null;
      if (recorded) {
        outcome = await deps.store.finishJob(jobId, stopping?.stop ? 'canceled' : 'launch_failed').catch(() => null);
        await deps.store.releaseJob(job).catch(() => {});
        if (stopping?.stop) await deps.store.recordJobStop(job, { confirmedAt: now() });
      }
      // Finished with another outcome before it could launch: an admin released it, on purpose.
      // Not an error to have GitHub show (and nothing to redeliver).
      if (outcome !== null && outcome !== 'launch_failed') return { status: 200, disposition: 'cancelled', jobId };
      return { status: 500, disposition: 'launch_failed', jobId, errorClass: errorClassOf(err) };
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
      if (!attached) {
        if (!deps.stopJob) throw new Error(`Could not register or retire VM ${microvmId} for ${jobId}`);
        // The trusted response is retained by the stop service independently of the
        // failed attachment. Never forget a known VM and leave it billing to expiry.
        await deps.stopJob(job, microvmId);
        return { status: 503, disposition: 'launch_failed', jobId, errorClass: 'VmRegistrationFailed' };
      }
    }

    const current = await deps.store.getJob(jobId);
    if (current && !current.stop && await workflowIsPaused(deps.store, current)) {
      // Launch admission won before the pause. Its VM may now exist, but no agent may
      // start after the pause: retire this sibling without replacing the owner's pause.
      await deps.store.requestJobStop(current, { requestedAt: now(), by: 'workflow control', reason: 'Workflow paused while VM launch was in flight' }, []);
    }
    const latest = await deps.store.getJob(jobId);
    if (latest?.stop && deps.stopJob) await deps.stopJob(latest);
    log({ delivery: req.deliveryId, installationId: req.installationId, jobId, microvmId, repository: job.repository, configVersion: job.configVersion, imageVersion, launched: true });
    return { status: 202, disposition: 'launched', jobId };
  };
}

export type Launcher = ReturnType<typeof createLauncher>;

/** An error's class for the console: its name when it is a plain identifier (an AWS exception's), else Error. */
export function errorClassOf(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error';
}

type HookJob = { jobId: string; token: string; deliveryId: string; launchedAt: number; eventName?: string; notBefore?: number; retry?: boolean };

function validConsoleOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * The run-hook payload: the broker and the job's token; the runner gets everything else from the
 * broker. `notBefore`: a pull request job's coalescing lease ends then, and the runner starts the
 * run no earlier.
 */
export function runHookPayload(s: LaunchSettings, job: HookJob) {
  return {
    version: RUN_HOOK_PAYLOAD_VERSION,
    deliveryId: job.deliveryId,
    eventName: job.eventName ?? 'issues',
    ...(job.notBefore !== undefined ? { notBefore: new Date(job.notBefore).toISOString() } : {}),
    ...(job.retry ? { retry: true } : {}),
    region: s.region,
    broker: { functionName: s.brokerFunctionName, jobId: job.jobId, jobToken: job.token },
    ...(validConsoleOrigin(s.consoleOrigin) ? { consoleOrigin: new URL(s.consoleOrigin!).origin } : {}),
    maximumDurationSeconds: s.maximumDurationSeconds,
    watchdogReserveSeconds: s.watchdogReserveSeconds,
    launchedAt: new Date(job.launchedAt).toISOString(),
    agentIsolation: 'enforced',
  };
}

export function runMicrovmInput(s: LaunchSettings, imageVersion: string, job: HookJob): RunMicrovmInput {
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
