import type { GitHubApi } from '../github/client.js';
import { GitHubError } from '../github/client.js';
import { appJwt } from '../github/jwt.js';
import type { LoadSettings } from '../github/settings.js';
import type { Quotas, Store } from '../store/store.js';
import type { WorkflowRecorder } from '../workflows/recorder.js';
import { OFF_SWITCH, type KillSwitch } from './kill-switch.js';
import type { LaunchRequest, LaunchResult } from './launch.js';
import { isWaiting, type QueueEntry, type QueueState, type QueueStore, type QueueWaitReason } from './queue-store.js';
import { mayReplace, parseStatusMarker, renderStatusComment, STATUS_STAGE, statusLinkLine } from '../../../../src/publish/status-marker.js';

/**
 * The Cloud admission queue (#141). A tenant runs a bounded number of jobs at once (one by default)
 * and the platform has a ceiling; an eligible delivery that finds that capacity taken is not
 * refused: it is kept, acknowledged on GitHub, and started automatically once a slot is free.
 *
 *   enqueue      the launcher (jobs/launch.ts), where a reservation finds the tenant's or the
 *                platform's slots taken, or earlier work of the tenant already waits (FIFO). The
 *                event body is stored first, then the entry (queue-store.ts), and only then is the
 *                delivery answered: a crash before that leaves GitHub showing a failed delivery,
 *                and a redelivery finds the entry and joins it. Nothing is reserved or counted
 *                while an entry waits: no slot, no day's job, no microVM time.
 *   dispatch     on a slot's release (the table stream wakes the webhook function) and every
 *                minute (lost wakeups, expiries, backoff): the waiting entries, oldest first, one
 *                per tenant per round so a full tenant never holds up another. An entry is taken
 *                under a lease, checked again on GitHub (issue still open and labeled, pull request
 *                open and at the head its event was about), then launched under its stable job id
 *                through the same launcher, so everything a fresh delivery is checked against
 *                applies at admission (the tenant, the active config's rules and keys, a stop's
 *                pause, the kill switch, the atomic quota reservation).
 *   end states   admitted (a job started under the entry's id), canceled (label removed, issue or
 *                pull request closed, stale head, a pause, an owner's cancel), refused (a budget,
 *                missing keys, disabled routing or configuration: actionable, never retried in a
 *                loop), expired (it waited QUEUE_EXPIRY_MS).
 *
 * Queue policy (cloud/README.md, "Admission queue"): FIFO within a tenant, round robin across
 * tenants; QUEUE_MAX_PER_TENANT waiting entries; QUEUE_EXPIRY_MS; one waiting entry per issue or
 * pull request (a relabel or a redelivery joins it; a later pull request event replaces its
 * event, so the newest is the one run); budgets (jobs per day, microVM minutes) are not waited
 * out: they refuse, as before, with the existing comment, so no work runs by surprise at a reset.
 * The execution route (API key or subscription worker) is the one chosen at enqueue: a change
 * refuses the entry rather than rerouting it. Dispatch rules and keys are those active at admission.
 */

export const QUEUE_MAX_PER_TENANT = 25;
export const QUEUE_EXPIRY_MS = 72 * 60 * 60 * 1000;
/** A dispatcher's hold on an entry it admits: past the webhook function's 20 s timeout, so a dispatcher that died lets go. */
export const ADMIT_LEASE_MS = 60 * 1000;
/** Failed admission attempts (an error, an unconfirmed launch) before the entry is refused. */
export const MAX_ADMIT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;
export const backoff = (attempts: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
/**
 * How long one dispatch run starts admissions. An admission can take a pull request's coalescing
 * wait (up to 8 s) and a launch on top, all within the webhook function's 20 s; one cut short by
 * the timeout is safe (its lease runs out, and its job record, if any, wins), only slower.
 */
export const DISPATCH_BUDGET_MS = 6 * 1000;
/** When a queued launch finds its own delivery claim held (no job record yet): looked at again after this, at most this. */
export const DUPLICATE_RECHECK_MS = 5 * 1000;
export const DUPLICATE_RECHECK_MAX_MS = 60 * 1000;
/** How long the enqueue has to post its acknowledgement before the dispatcher posts a missing one. */
export const ACK_GRACE_MS = 60 * 1000;
/** Waiting entries one dispatch run reads. */
export const DISPATCH_SCAN = 500;

const WAIT_WORDS: Record<QueueWaitReason, string> = {
  concurrent_jobs: "Your account's current execution slot is occupied.",
  platform_concurrency: 'Updraft Cloud is running as many jobs as it can right now.',
  queue_ahead: 'Earlier queued work for your account starts first.',
  retrying: 'An earlier attempt to start it did not complete; Updraft tries again automatically.',
};
export const waitMessage = (reason: QueueWaitReason) => WAIT_WORDS[reason];

/** The marker on the acknowledgement comment: one per queued job, found again before any new post. */
export const queueCommentMarker = (jobId: string) => `<!-- updraft-queue: ${jobId} -->`;

export const jobLink = (consoleOrigin: string | undefined, e: Pick<QueueEntry, 'installationId' | 'jobId'>) => {
  if (!consoleOrigin) return null;
  try {
    const u = new URL(consoleOrigin);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return new URL(`/installations/${e.installationId}/jobs/${e.jobId}`, u.origin).href;
  } catch {
    return null;
  }
};

const minutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.round(m / 60)} hours`;
};

/** The acknowledgement on the issue or pull request, as the entry stands. No ETA, no claimed agent. */
export function queueComment(e: QueueEntry, consoleOrigin?: string, now = Date.now()): string {
  const link = jobLink(consoleOrigin, e);
  const job = `**Job:** ${link ? `[View in Updraft](${link})` : `\`${e.jobId}\``}`;
  const what = e.pullRequest !== undefined && e.issue === undefined ? 'the latest event on this pull request' : 'this issue';
  const expiry = Math.round((e.expiresAt - e.enqueuedAt) / 3_600_000);
  const lines = (status: string, text: string[]) => [...text, '', `**Status:** ${status}`, '', job, '', queueCommentMarker(e.jobId)].join('\n');
  if (isWaiting(e)) {
    return lines('Queued · Waiting for capacity', [
      `Updraft queued ${what}. ${waitMessage(e.reason)} Work will start automatically when capacity is available. No action is needed.`,
      '',
      `<sub>Queued work that has not started within ${expiry} hours is canceled, and this comment says so.</sub>`,
    ]);
  }
  const o = e.outcome;
  if (e.state === 'admitted' && o?.reason.startsWith('native_waiting')) {
    // Handed to the subscription's own wait: nothing has started yet, and this says so.
    return lines('Waiting for the Claude subscription', [
      `Capacity is available, and the job now waits for the connected Claude subscription (${o.reason === 'native_waiting_for_sign_in' ? 'a sign-in' : o.reason === 'native_waiting_for_reconnect' ? 'a reconnect' : 'its environment to be ready'}) before it starts. The job page says what is needed.`,
    ]);
  }
  if (e.state === 'admitted') {
    return lines(`Started · queued for ${minutes((o?.at ?? now) - e.enqueuedAt)}`, [
      `Updraft started the queued work${o?.jobId && o.jobId !== e.jobId ? ` as job \`${o.jobId}\`` : ''}. The job page shows what runs and how it ends.`,
      '',
      // Routing runs inside the job, after this edit: nothing about its choice is known here.
      e.pullRequest !== undefined && e.issue === undefined
        ? 'The worker, model and effort are chosen when the job runs; the review or revision it posts names them.'
        : 'Complexity, capability tier, worker, model and effort are chosen when the job runs; the assignment comment that follows names them.',
    ]);
  }
  const status = e.state === 'expired' ? 'Expired' : e.state === 'refused' ? 'Not started' : 'Canceled';
  return lines(`${status} · ${o?.reason ?? e.state}`, [
    `Updraft did not start the queued work: ${o?.message ?? 'it is no longer eligible.'}`,
    ...(o?.nextAction ? ['', o.nextAction] : []),
  ]);
}

/**
 * Quiet notifications (#173): the acknowledgement is the first stage of the issue's one live
 * status comment (src/publish/status-marker.ts), which the run takes over at assignment and edits
 * from then on. It carries the queue's own marker too, so a retried post finds it. Null: this
 * state writes nothing on the status comment (an admission: the run's assignment follows; any
 * pull request event: the review loop's stages are the run's to write).
 */
export function quietQueueComment(e: QueueEntry, consoleOrigin?: string): { body: string; stage: number } | null {
  if (e.issue === undefined) return null;
  const link = jobLink(consoleOrigin, e);
  const o = e.outcome;
  let status: { title: string; text: string; stage: number };
  if (isWaiting(e)) {
    status = { title: 'Queued', text: `Updraft queued this issue. ${waitMessage(e.reason)} It starts automatically when capacity is free; no action is needed.`, stage: STATUS_STAGE.queued };
  } else if (e.state === 'admitted' && o?.reason.startsWith('native_waiting')) {
    status = { title: 'Waiting for Claude', text: 'Capacity is free; the job now waits for the connected Claude subscription before it starts.', stage: STATUS_STAGE.waiting };
  } else if (e.state === 'admitted') {
    return null;
  } else {
    const title = e.state === 'expired' ? 'Expired' : e.state === 'refused' ? 'Not started' : 'Canceled';
    status = { title, text: `Updraft did not start this work: ${o?.message ?? 'it is no longer eligible.'}`, stage: STATUS_STAGE.ended };
  }
  const body = renderStatusComment({ title: status.title, text: status.text, link: link ? statusLinkLine(link, 'work') : null, mark: { key: e.jobId, stage: status.stage } });
  return { body: `${body}\n${queueCommentMarker(e.jobId)}`, stage: status.stage };
}

/** The marker of the separate comment that asks a person to act on queued work that did not start. */
export const queueActMarker = (jobId: string) => `<!-- updraft-queue-act: ${jobId} -->`;

/**
 * Quiet notifications: queued work that was refused or expired needs a person. One or two plain
 * sentences, what to do, the console link. Null for any other state.
 */
export function queueActComment(e: QueueEntry, consoleOrigin?: string): string | null {
  if (e.state !== 'refused' && e.state !== 'expired') return null;
  const link = jobLink(consoleOrigin, e);
  const what = e.issue === undefined ? 'the latest event on this pull request' : 'this issue';
  const why = (e.outcome?.message ?? 'it is no longer eligible.').replace(/\s+$/, '');
  const next = e.outcome?.nextAction ?? (e.state === 'expired' ? (e.issue === undefined ? 'Push a commit or submit the review again to try again.' : 'Remove the label and add it again to try again.') : '');
  return [`Updraft could not start the queued work for ${what}: ${why}${next ? ` ${next}` : ''}${link ? ` [Open it in Updraft](${link})` : ''}`, '', queueActMarker(e.jobId)].join('\n');
}

/** A queued job as the console shows it: never as running, finished or throttled. */
export interface QueueView {
  state: QueueState;
  reason: QueueWaitReason;
  /** Why it waits, in words. */
  waitMessage: string;
  enqueuedAt: string;
  expiresAt: string;
  /** Waiting until now, or until it ended. */
  waitedSeconds: number;
  /** Its place among the tenant's waiting work (1 starts next), shown only while it waits: the order is FIFO, its timing is not promised. */
  position?: number;
  attempts: number;
  /** Deliveries folded into it (relabels, redeliveries, later pull request events). */
  deliveries: number;
  eventName: string;
  route: 'standard' | 'subscription';
  outcome?: { at: string; reason: string; message: string; nextAction?: string; by?: string; jobId?: string };
}

export function queueView(e: QueueEntry, now: number, position?: number): QueueView {
  const end = e.outcome?.at ?? now;
  return {
    state: e.state,
    reason: e.reason,
    waitMessage: waitMessage(e.reason),
    enqueuedAt: new Date(e.enqueuedAt).toISOString(),
    expiresAt: new Date(e.expiresAt).toISOString(),
    waitedSeconds: Math.max(0, Math.round((end - e.enqueuedAt) / 1000)),
    ...(isWaiting(e) && position !== undefined ? { position } : {}),
    attempts: e.attempts,
    deliveries: e.deliveries,
    eventName: e.eventName,
    route: e.route === 'standard' ? 'standard' : 'subscription',
    ...(e.outcome ? { outcome: { ...e.outcome, at: new Date(e.outcome.at).toISOString() } } : {}),
  };
}

/** Each waiting entry's place in its tenant's line (oldest first). */
export const positions = (entries: QueueEntry[]): Map<string, number> =>
  new Map(entries.filter(isWaiting).sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.jobId.localeCompare(b.jobId)).map((e, i) => [e.jobId, i + 1]));

/** Posts or updates the acknowledgement comment (the webhook function, with an issues-scoped installation token). */
export interface QueueNotifier {
  /** Creates the comment and returns its id, or finds one already carrying `marker` (a post whose answer was lost). */
  post(e: QueueEntry, body: string, marker: string): Promise<number | undefined>;
  update(e: QueueEntry, commentId: number, body: string): Promise<void>;
  /**
   * The comment's body now, or null when it is gone. Quiet notifications read it before an edit:
   * the run may have taken the comment over, and a queue edit never writes over the run's stages.
   */
  read?(e: QueueEntry, commentId: number): Promise<string | null>;
  /** The App's own comment carrying `marker`, if one was posted (its id never recorded). */
  find?(e: QueueEntry, marker: string): Promise<number | undefined>;
}

export interface EnqueueInput {
  request: Pick<LaunchRequest, 'installationId' | 'deliveryId' | 'eventName' | 'appBot' | 'body' | 'payload'>;
  jobId: string;
  repository: string;
  repositoryId: number;
  issue?: number;
  pullRequest?: number;
  workflowIssue?: number;
  label?: string;
  route: string;
  configVersion: number;
  reason: QueueWaitReason;
  /** repositories.R.notifications at enqueue (#173). Absent: verbose, as before. */
  notifications?: 'quiet' | 'verbose';
  /** Called once the entry's write has committed (whatever its result), before any side effect. */
  persisted?: () => Promise<void>;
}

export type EnqueueOutcome =
  | { result: 'queued' | 'joined'; entry: QueueEntry }
  | { result: 'full' }
  /** The subject's entry is being admitted right now: the delivery is not acknowledged, redeliver it. */
  | { result: 'busy'; entry: QueueEntry };

export interface AdmissionQueue {
  /** Whether work of the tenant already waits: a new delivery waits behind it (FIFO). */
  hasWaiting(installationId: number): Promise<boolean>;
  enqueue(input: EnqueueInput): Promise<EnqueueOutcome>;
}

export const queueEventKey = (installationId: number, jobId: string, deliveryId: string) => `tenants/${installationId}/events/queue/${jobId}/${deliveryId}.json`;

/** The head a pull request event is about: a push's new head, a review's commit, a check suite's head. */
export function headOf(eventName: string, payload: LaunchRequest['payload']): string | undefined {
  const p = payload as { pull_request?: { head?: { sha?: unknown } }; check_suite?: { head_sha?: unknown }; review?: { commit_id?: unknown } };
  const sha = eventName === 'check_suite' ? p.check_suite?.head_sha : eventName === 'pull_request_review' ? (p.review?.commit_id ?? p.pull_request?.head?.sha) : p.pull_request?.head?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
}

export function createAdmissionQueue(deps: {
  store: QueueStore;
  putEvent: (key: string, body: string) => Promise<void>;
  notify?: QueueNotifier;
  workflows?: Pick<WorkflowRecorder, 'queued'>;
  consoleOrigin?: string;
  maxPerTenant?: number;
  expiryMs?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}): AdmissionQueue {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return {
    hasWaiting: async (installationId) => (await deps.store.depth(installationId)) > 0,
    async enqueue(input) {
      const at = now();
      const { request: req } = input;
      const action = typeof req.payload.action === 'string' ? req.payload.action.slice(0, 64) : undefined;
      const eventName = req.eventName ?? 'issues';
      const headSha = input.pullRequest !== undefined ? headOf(eventName, req.payload) : undefined;
      const eventKey = queueEventKey(input.request.installationId, input.jobId, req.deliveryId);
      // The event first: an entry never names a body that is not there.
      await deps.putEvent(eventKey, req.body);
      const sender = req.payload.sender?.login;
      const entry: QueueEntry = {
        jobId: input.jobId,
        installationId: req.installationId,
        repository: input.repository,
        repositoryId: input.repositoryId,
        ...(input.issue !== undefined ? { issue: input.issue } : {}),
        ...(input.pullRequest !== undefined ? { pullRequest: input.pullRequest } : {}),
        ...(input.workflowIssue !== undefined ? { workflowIssue: input.workflowIssue } : {}),
        deliveryId: req.deliveryId,
        eventName,
        ...(action ? { action } : {}),
        eventKey,
        ...(input.label ? { label: input.label } : {}),
        ...(typeof sender === 'string' ? { sender: sender.slice(0, 100) } : {}),
        ...(req.appBot ? { appBot: req.appBot } : {}),
        ...(headSha ? { headSha } : {}),
        route: input.route,
        configVersion: input.configVersion,
        ...(input.notifications ? { notifications: input.notifications } : {}),
        reason: input.reason,
        state: 'queued',
        enqueuedAt: at,
        expiresAt: at + (deps.expiryMs ?? QUEUE_EXPIRY_MS),
        attempts: 0,
        nextAttemptAt: at,
        deliveries: 1,
        version: 0,
      };
      const out = await deps.store.enqueue(entry, deps.maxPerTenant ?? QUEUE_MAX_PER_TENANT);
      // Kept (or joined, or refused for room): the launcher's delivery claim is released now, before
      // the workflow and the comment, so a dispatcher woken by this very enqueue finds it free.
      await input.persisted?.();
      if (out.result === 'full') return out;
      if (out.result === 'joined') {
        const existing = out.entry;
        // The same delivery again (a redelivery of the one that queued it): nothing changes.
        if (existing.deliveryId === req.deliveryId) return out;
        if (existing.state === 'admitting') {
          // An issue's relabel or redelivery is covered by the admission under way. A pull request's
          // newer event may not be: not acknowledged, so a redelivery brings it again.
          return existing.pullRequest !== undefined && existing.issue === undefined ? { result: 'busy', entry: existing } : out;
        }
        // A pull request's newer event replaces the waiting one (its head is the newer); a close is final.
        const replace = existing.pullRequest !== undefined && existing.issue === undefined && !(existing.eventName === 'pull_request' && existing.action === 'closed');
        const next: QueueEntry = {
          ...existing,
          deliveries: existing.deliveries + 1,
          lastDeliveryAt: at,
          ...(replace ? { deliveryId: req.deliveryId, eventName, eventKey, ...(action ? { action } : {}), ...(typeof sender === 'string' ? { sender: sender.slice(0, 100) } : {}), ...(req.appBot ? { appBot: req.appBot } : {}) } : {}),
        };
        if (replace) {
          if (headSha) next.headSha = headSha; else delete next.headSha;
          if (!action) delete next.action;
        }
        if (!(await deps.store.update(next, existing))) {
          // It moved on meanwhile (admitted, or taken for admission): a replacement is not
          // acknowledged; a plain join is covered either way.
          if (replace) return { result: 'busy', entry: existing };
          return out;
        }
        return { result: 'joined', entry: { ...next, version: existing.version + 1 } };
      }
      const queued = out.entry;
      log({ installationId: queued.installationId, jobId: queued.jobId, delivery: queued.deliveryId, queued: queued.reason, repository: queued.repository });
      await deps.workflows?.queued(
        { jobId: queued.jobId, installationId: queued.installationId, repository: queued.repository, repositoryId: queued.repositoryId, eventName: queued.eventName, deliveryId: queued.deliveryId, ...(queued.issue !== undefined ? { issue: queued.issue } : {}), ...(queued.pullRequest !== undefined ? { pullRequest: queued.pullRequest } : {}) },
        { reason: 'capacity_wait', code: queued.reason, message: `Queued: ${waitMessage(queued.reason)} It starts automatically when capacity is available.` },
      );
      // Acknowledged on GitHub once it is kept. Best effort: the dispatcher posts it later if this fails.
      if (deps.notify) await syncComment(deps.store, deps.notify, queued, deps.consoleOrigin, at, log).catch(() => {});
      return { result: 'queued', entry: queued };
    },
  };
}

/**
 * Brings the acknowledgement comment up to the entry's state: posted once while it waits, edited
 * in place when it ends. An entry that ends before anything was posted gets a comment only if a
 * person has something to do (refused, expired); a cancel for a removed label or a closed issue,
 * and an admission (its job posts its own assignment comment), stay quiet.
 */
export async function syncComment(store: QueueStore, notify: QueueNotifier, e: QueueEntry, consoleOrigin: string | undefined, now: number, log: (entry: Record<string, unknown>) => void, again = true): Promise<QueueEntry> {
  if (e.commentState === e.state) return e;
  const quiet = e.notifications === 'quiet';
  const status = quiet ? quietQueueComment(e, consoleOrigin) : { body: queueComment(e, consoleOrigin, now), stage: 0 };
  const marker = queueCommentMarker(e.jobId);
  try {
    // The comment's id as kept now (another writer may have recorded it after `e` was read), or
    // the comment itself on GitHub (its id was never recorded): an existing comment is edited,
    // whatever the state, rather than left saying something that is no longer true.
    let commentId = e.commentId ?? (await store.get(e.installationId, e.jobId))?.commentId;
    if (status) {
      if (commentId === undefined && notify.find) commentId = await notify.find(e, marker);
      if (commentId !== undefined) {
        // Quiet: the run takes the comment over at assignment. A queue edit that comes late (a
        // retried sync, a lost wakeup) reads it first, and never writes over the run's stages.
        const current = quiet && notify.read ? await notify.read(e, commentId) : undefined;
        const mark = current ? parseStatusMarker(current) : null;
        if (current !== null && (!mark || mayReplace(mark, status.stage))) await notify.update(e, commentId, status.body);
      } else if (quiet ? isWaiting(e) : isWaiting(e) || e.state === 'refused' || e.state === 'expired') {
        commentId = await notify.post(e, status.body, marker);
      }
    }
    // Quiet: work that a person has to start again gets one comment of its own that says so.
    const act = quiet && !e.actPosted ? queueActComment(e, consoleOrigin) : null;
    const actPosted = act ? (await notify.post(e, act, queueActMarker(e.jobId)), true) : false;
    // Recorded on the entry as it is now: a version conflict re-reads and merges, so the id is
    // never lost. The state shown is recorded only while the entry is still in it.
    let cur: QueueEntry | null = e;
    for (let attempt = 0; attempt < 4 && cur; attempt++) {
      if (attempt > 0) cur = await store.get(e.installationId, e.jobId);
      if (!cur) break;
      const next: QueueEntry = { ...cur, ...(commentId !== undefined ? { commentId } : {}), ...(actPosted ? { actPosted: true as const } : {}), ...(cur.state === e.state ? { commentState: e.state } : {}) };
      if (!(await store.update(next, cur))) continue;
      const stored = { ...next, version: cur.version + 1 };
      // The entry moved on while this comment was written (admitted, say, while the enqueue's
      // post was in flight): the comment shows the older state, whatever the entry records it
      // showed, so it is brought up to the entry's state now, once.
      if (cur.state !== e.state && !(isWaiting(cur) && isWaiting(e)) && commentId !== undefined && again) {
        const { commentState: _shown, ...unshown } = stored;
        return syncComment(store, notify, unshown as QueueEntry, consoleOrigin, now, log, false);
      }
      return stored;
    }
    return e;
  } catch (err) {
    log({ installationId: e.installationId, jobId: e.jobId, warning: `could not update the queue comment: ${(err as Error)?.name ?? 'error'}` });
    return e;
  }
}

/** What admission finds on GitHub: still eligible, or why not. Throws when GitHub cannot say (try again later). */
export type Revalidation = { ok: true } | { ok: false; reason: string; message: string };
export type Revalidate = (e: QueueEntry) => Promise<Revalidation>;

/**
 * GitHub's answer now, with an installation token for the entry's repository only: an issue is
 * open and still carries the trigger label; a pull request is open (a close event needs nothing
 * more), and for a push or a check suite its head is still the one the event was about.
 */
export function createGitHubRevalidator(deps: { github: Pick<GitHubApi, 'createInstallationToken' | 'issueState' | 'pullRequestHead'>; loadSettings: LoadSettings; now?: () => number }): Revalidate {
  const now = deps.now ?? Date.now;
  return async (e) => {
    const settings = await deps.loadSettings();
    if (!settings) throw new Error('the App settings are unavailable');
    const isIssue = e.issue !== undefined && e.eventName === 'issues';
    const { token } = await deps.github.createInstallationToken(appJwt(settings.appId, settings.privateKey, now()), e.installationId, {
      repositoryIds: [e.repositoryId],
      permissions: isIssue ? { issues: 'read' } : { pull_requests: 'read' },
    });
    try {
      if (isIssue) {
        if (!deps.github.issueState) throw new Error('issue state is unavailable');
        const state = await deps.github.issueState(token, e.repository, e.issue!);
        if (!state.open) return { ok: false, reason: 'issue_closed', message: 'the issue was closed while the job was queued.' };
        if (e.label && !state.labels.some((l) => l.toLowerCase() === e.label!.toLowerCase())) {
          return { ok: false, reason: 'label_removed', message: `the \`${e.label}\` label was removed while the job was queued.` };
        }
        return { ok: true };
      }
      if (e.eventName === 'pull_request' && e.action === 'closed') return { ok: true };
      if (!deps.github.pullRequestHead || e.pullRequest === undefined) throw new Error('pull request state is unavailable');
      const pr = await deps.github.pullRequestHead(token, e.repository, e.pullRequest);
      if (pr.state !== 'open') return { ok: false, reason: 'pull_request_closed', message: `pull request #${e.pullRequest} was ${pr.merged ? 'merged' : 'closed'} while the event was queued.` };
      // A push or a check suite is about one head: once the pull request moved on, the newer
      // head's own events drive the loop, and this one would act on code that is gone.
      if ((e.eventName === 'check_suite' || (e.eventName === 'pull_request' && e.action === 'synchronize')) && e.headSha && pr.headSha && !pr.headSha.startsWith(e.headSha) && !e.headSha.startsWith(pr.headSha)) {
        return { ok: false, reason: 'stale_head', message: `pull request #${e.pullRequest} moved on to ${pr.headSha.slice(0, 12)} while the event about ${e.headSha.slice(0, 12)} was queued; the newer head's events continue the loop.` };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return { ok: false, reason: 'not_accessible', message: 'the issue, pull request or repository is no longer accessible to the App.' };
      throw err;
    }
  };
}

/** A queued job's console request. */
export interface QueueCancelRequest {
  updraftQueue: { action: 'cancel'; installationId: number; jobId: string; by: string };
}
export const isQueueCancelRequest = (event: unknown): event is QueueCancelRequest => {
  const r = (event as QueueCancelRequest | null)?.updraftQueue;
  return typeof r === 'object' && r !== null && r.action === 'cancel' && Number.isSafeInteger(r.installationId) && r.installationId > 0 &&
    typeof r.jobId === 'string' && /^job_[A-Za-z0-9_-]{8,64}$/.test(r.jobId) && typeof r.by === 'string' && r.by.length > 0 && r.by.length <= 200;
};
export type QueueCancelResult = { ok: true; state: QueueState } | { ok: false; status: number; code: 'not_found' | 'not_queued' | 'admitting'; message: string };

export interface DispatchReport {
  scanned: number;
  admitted: number;
  ended: number;
  deferred: number;
  waiting: number;
  /** Age of the oldest entry still waiting after the run, in seconds. */
  oldestWaitSeconds: number;
  /** Tenants that had capacity for none of their waiting entries. */
  tenantsAtCapacity: number;
  platformAtCapacity: boolean;
  failed: number;
  skipped?: 'kill_switch';
}

export const QUEUE_METRICS_NAMESPACE = 'Updraft/Queue';

/**
 * A dispatch run as CloudWatch metrics (Embedded Metric Format, one log line, no API call): queue
 * depth, the oldest wait, admissions, ends, deferrals and failures. What to watch: cloud/README.md.
 */
export function dispatchMetricsLine(report: DispatchReport, trigger: 'schedule' | 'wake', at: number): string {
  const values: Record<string, { value: number; unit: 'Count' | 'Seconds' }> = {
    Runs: { value: 1, unit: 'Count' },
    Waiting: { value: report.waiting, unit: 'Count' },
    OldestWaitSeconds: { value: report.oldestWaitSeconds, unit: 'Seconds' },
    Admitted: { value: report.admitted, unit: 'Count' },
    Ended: { value: report.ended, unit: 'Count' },
    Deferred: { value: report.deferred, unit: 'Count' },
    TenantsAtCapacity: { value: report.tenantsAtCapacity, unit: 'Count' },
    PlatformAtCapacity: { value: report.platformAtCapacity ? 1 : 0, unit: 'Count' },
    DispatchFailures: { value: report.failed, unit: 'Count' },
  };
  return JSON.stringify({
    _aws: { Timestamp: at, CloudWatchMetrics: [{ Namespace: QUEUE_METRICS_NAMESPACE, Dimensions: [[]], Metrics: Object.entries(values).map(([Name, v]) => ({ Name, Unit: v.unit })) }] },
    queueDispatch: trigger,
    ...(report.skipped ? { skipped: report.skipped } : {}),
    ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value])),
  });
}

export interface DispatcherDeps {
  queue: QueueStore;
  jobs: Pick<Store, 'getJob' | 'getDeliveryClaim'>;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  readEvent: (key: string) => Promise<string | null>;
  revalidate: Revalidate;
  notify?: QueueNotifier;
  workflows?: Pick<WorkflowRecorder, 'queueEnded' | 'queueCovered'> & Partial<Pick<WorkflowRecorder, 'queueAdmitted'>>;
  killSwitch?: KillSwitch;
  consoleOrigin?: string;
  budgetMs?: number;
  /**
   * The slots held now and the quotas they count against (the stack's defaults, with the tenant's
   * overrides): a full tenant, or a full platform, is skipped before any lease, GitHub call or
   * launch, so it neither spends an attempt nor holds up tenants with room. Only a hint: the
   * launcher's atomic reservation decides. Absent: every due entry is tried.
   */
  capacity?: { store: Pick<Store, 'getTenant' | 'heldSlots'>; quotas: Quotas };
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

type Step = 'admitted' | 'ended' | 'tenant_full' | 'platform_full' | 'hold';

/** Launch dispositions that end a queued entry as refused: a person has to change something. */
const REFUSALS: Record<string, string> = {
  tenant_inactive: 'The installation is suspended or disabled.',
  no_config: 'The installation has no active configuration.',
  missing_key: 'An agent key this workflow needs is not set.',
};

export function createQueueDispatcher(deps: DispatcherDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const killSwitch = deps.killSwitch ?? OFF_SWITCH;

  const subjectRef = (e: QueueEntry) => ({
    jobId: e.jobId, installationId: e.installationId, repository: e.repository, repositoryId: e.repositoryId, eventName: e.eventName, deliveryId: e.deliveryId,
    ...(e.issue !== undefined ? { issue: e.issue } : {}), ...(e.pullRequest !== undefined ? { pullRequest: e.pullRequest } : {}),
  });

  async function end(e: QueueEntry, state: 'admitted' | 'canceled' | 'refused' | 'expired', outcome: { reason: string; message: string; nextAction?: string; by?: string; jobId?: string }): Promise<QueueEntry | null> {
    const at = now();
    const { admittingUntil: _a, ...rest } = e;
    const next: QueueEntry = { ...rest, state, outcome: { at, ...outcome } };
    if (!(await deps.queue.settle(next, e))) return null;
    const settled = { ...next, version: e.version + 1 };
    log({ installationId: e.installationId, jobId: e.jobId, queue: state, reason: outcome.reason, waitedSeconds: Math.round((at - e.enqueuedAt) / 1000) });
    if (state !== 'admitted') await deps.workflows?.queueEnded(subjectRef(e), { reason: `queue_${state}`, message: `The queued job did not start: ${outcome.message}`, ...(outcome.nextAction ? { nextAction: outcome.nextAction } : {}) }, { enqueuedAt: e.enqueuedAt });
    // Admitted under its own id: the timeline says how long it waited, by this entry's clock.
    else if (outcome.reason === 'admitted' && (outcome.jobId ?? e.jobId) === e.jobId) await deps.workflows?.queueAdmitted?.(subjectRef(e), { enqueuedAt: e.enqueuedAt, reason: e.reason });
    if (deps.notify) await syncComment(deps.queue, deps.notify, settled, deps.consoleOrigin, at, log);
    return settled;
  }

  /**
   * Back to waiting, at its place (FIFO keeps its enqueue time), looked at again after `delayMs`.
   * `wait`: it waited for something outside it (capacity, the kill switch, a worker, its own launch
   * claim), not a failed attempt: the lease's attempt is given back, so waiting never exhausts them.
   */
  async function release(e: QueueEntry, delayMs: number, reason?: QueueWaitReason, wait = false, backingOff = false): Promise<void> {
    const { admittingUntil: _a, ...rest } = e;
    // A wait that can last (an offline worker, the kill switch) backs off like a failure, without
    // being one: 30 s, doubling to 15 min, so a stuck entry costs a few GitHub reads an hour.
    const waits = backingOff ? (e.waits ?? 0) + 1 : 0;
    const delay = backingOff ? backoff(waits) : delayMs;
    const next: QueueEntry = { ...rest, state: 'queued', nextAttemptAt: now() + delay, waits, ...(reason ? { reason } : {}), ...(wait ? { attempts: Math.max(0, e.attempts - 1) } : {}) };
    if (!(await deps.queue.update(next, e))) return;
    await ackMissing({ ...next, version: e.version + 1 });
  }

  /**
   * An acknowledgement that never got out (the enqueue's post failed, or its Lambda died after the
   * entry was kept): posted now, once the enqueue has had its chance.
   */
  async function ackMissing(e: QueueEntry): Promise<void> {
    if (deps.notify && e.state === 'queued' && e.commentState === undefined && now() - e.enqueuedAt >= ACK_GRACE_MS) {
      await syncComment(deps.queue, deps.notify, e, deps.consoleOrigin, now(), log);
    }
  }

  /** Whether the tenant, and the platform, have a slot free now (a hint; reserveJob decides). */
  async function capacityFor(installationId: number): Promise<'free' | 'tenant_full' | 'platform_full'> {
    const c = deps.capacity;
    if (!c) return 'free';
    const full = (held: number[], count: number) => {
      const set = new Set(held);
      for (let n = 0; n < count; n++) if (!set.has(n)) return false;
      return true;
    };
    const tenant = await c.store.getTenant(installationId);
    // No tenant, or not active: the launch says why, and ends the entry.
    if (!tenant || tenant.status !== 'active') return 'free';
    // As quotas.ts tenantQuotas: the defaults, with the tenant's overrides.
    const quotas: Quotas = { ...c.quotas, ...Object.fromEntries(Object.entries(tenant.limits ?? {}).filter(([, v]) => typeof v === 'number')) };
    if (full(await c.store.heldSlots(installationId), quotas.concurrentJobs)) return 'tenant_full';
    if (full(await c.store.heldSlots('platform'), quotas.platformConcurrentJobs)) return 'platform_full';
    return 'free';
  }

  /** A failed attempt: retried with backoff, refused once attempts run out. */
  async function failed(e: QueueEntry, why: string): Promise<Step> {
    if (e.attempts >= MAX_ADMIT_ATTEMPTS) {
      await end(e, 'refused', { reason: 'admission_failed', message: `Updraft could not start it after ${e.attempts} attempts (${why}).`, nextAction: 'Apply the label again on GitHub (or push to the pull request) to queue it once more.' });
      return 'ended';
    }
    await release(e, backoff(e.attempts), 'retrying');
    return 'hold';
  }

  async function admit(first: QueueEntry): Promise<Step> {
    const at = now();
    if (first.state === 'admitting' && (first.admittingUntil ?? 0) > at) return 'hold';
    const expired = at >= first.expiresAt;
    if (!expired && first.state === 'queued' && first.nextAttemptAt > at) return 'hold';
    // (A stale `admitting` entry is taken whatever the slots say: its earlier attempt's job, if
    // any, may be what holds them, and its record ends the entry.)
    if (!expired && first.state === 'queued') {
      const room = await capacityFor(first.installationId);
      if (room !== 'free') {
        // Nothing taken, nothing asked of GitHub: the entry keeps its place and its attempts.
        await ackMissing(first);
        return room;
      }
    }
    // Taken under a lease: no other dispatcher admits it until the lease runs out.
    const taken: QueueEntry = { ...first, state: 'admitting', admittingUntil: at + ADMIT_LEASE_MS, attempts: first.attempts + 1 };
    if (!(await deps.queue.update(taken, first))) return 'hold';
    const e: QueueEntry = { ...taken, version: first.version + 1 };

    // An earlier attempt got as far as the job's record (a dispatcher that died, an ambiguous
    // launch answer): that job is this entry's, whatever became of it. Never a second launch.
    if (await deps.jobs.getJob(e.jobId)) {
      await end(e, 'admitted', { reason: 'admitted', message: 'Started.', jobId: e.jobId });
      return 'admitted';
    }
    if (expired) {
      await end(e, 'expired', { reason: 'queue_expired', message: `it waited ${Math.round((at - e.enqueuedAt) / 3_600_000)} hours without capacity becoming available.`, nextAction: 'Apply the label again on GitHub (or push to the pull request) to queue it again.' });
      return 'ended';
    }
    let check: Revalidation;
    try {
      check = await deps.revalidate(e);
    } catch (err) {
      return failed(e, `GitHub could not be asked: ${(err as Error)?.name ?? 'error'}`);
    }
    if (!check.ok) {
      await end(e, 'canceled', { reason: check.reason, message: check.message });
      return 'ended';
    }
    const body = await deps.readEvent(e.eventKey).catch(() => undefined);
    if (body === undefined) return failed(e, 'its event could not be read');
    if (body === null) {
      await end(e, 'refused', { reason: 'event_unavailable', message: 'its stored event is gone.', nextAction: 'Apply the label again on GitHub.' });
      return 'ended';
    }
    let payload: LaunchRequest['payload'];
    try {
      payload = JSON.parse(body) as LaunchRequest['payload'];
    } catch {
      await end(e, 'refused', { reason: 'event_unavailable', message: 'its stored event could not be read.' });
      return 'ended';
    }

    let result: LaunchResult;
    try {
      result = await deps.launch({
        installationId: e.installationId, deliveryId: e.deliveryId, eventName: e.eventName, ...(e.appBot ? { appBot: e.appBot } : {}),
        body, payload, jobId: e.jobId, ...(e.workflowIssue !== undefined ? { workflowIssue: e.workflowIssue } : {}),
        queued: { route: e.route },
      });
    } catch (err) {
      log({ installationId: e.installationId, jobId: e.jobId, warning: 'queued launch failed', name: (err as Error)?.name });
      // The job's record decides whether it got far enough to be this entry's job.
      if (await deps.jobs.getJob(e.jobId).catch(() => null)) {
        await end(e, 'admitted', { reason: 'admitted', message: 'Started.', jobId: e.jobId });
        return 'admitted';
      }
      return failed(e, (err as Error)?.name ?? 'error');
    }
    return settleLaunch(e, result);
  }

  async function settleLaunch(e: QueueEntry, r: LaunchResult): Promise<Step> {
    switch (r.disposition) {
      case 'launched':
        await end(e, 'admitted', { reason: 'admitted', message: 'Started.', jobId: r.jobId ?? e.jobId });
        return 'admitted';
      case 'capacity_wait':
        // Capacity went again between the release and this launch: back in line, at its place.
        // A wait, not a failed attempt.
        await release(e, 0, r.reason === 'platform_concurrency' ? 'platform_concurrency' : 'concurrent_jobs', true);
        return r.reason === 'platform_concurrency' ? 'platform_full' : 'tenant_full';
      case 'coalesced': {
        // A job of the pull request is starting and reads it as it is then: this event is in it.
        // The workflow follows that job, not this entry's (which never runs).
        const settled = await end(e, 'admitted', { reason: 'coalesced', message: r.message ?? 'Covered by a job of the same pull request.', ...(r.coveredBy ? { jobId: r.coveredBy } : {}) });
        if (settled) await deps.workflows?.queueCovered(subjectRef(e), r.coveredBy, { enqueuedAt: e.enqueuedAt });
        return 'admitted';
      }
      case 'cancelled':
        await end(e, 'canceled', { reason: 'canceled', message: 'it was canceled while starting.', ...(r.jobId ? { jobId: r.jobId } : {}) });
        return 'ended';
      case 'throttled':
        // A budget, not capacity: not waited out (no surprise run at a reset). Refused, with what to do.
        await end(e, 'refused', {
          reason: r.reason ?? 'budget',
          message: r.reason === 'jobs_per_day' ? "the account's jobs for today (UTC) are used." : r.reason === 'microvm_minutes' ? "the account's job time for this month (UTC) is used." : 'a quota refused it.',
          nextAction: r.reason === 'jobs_per_day' ? 'Apply the label again tomorrow (UTC).' : 'Apply the label again once the budget resets, or ask an admin to raise it.',
        });
        return 'ended';
      case 'duplicate': {
        // Another launch holds this delivery. Ours (an earlier attempt still under way, or one that
        // died before recording the job): wait for its claim to run out. Another job's: that job has it.
        const claim = await deps.jobs.getDeliveryClaim(e.installationId, e.deliveryId).catch(() => null);
        if (claim && claim.jobId !== e.jobId) {
          await end(e, 'canceled', { reason: 'superseded', message: `job \`${claim.jobId}\` already took this delivery.`, jobId: claim.jobId });
          return 'ended';
        }
        // Ours, with no job record (getJob found none before this launch): the enqueuing launch
        // still finishing, or one that died before recording the job. Looked at again soon, within
        // the claim's life, without spending an attempt or changing why it waits.
        await release(e, Math.min(DUPLICATE_RECHECK_MAX_MS, Math.max(DUPLICATE_RECHECK_MS, (claim?.expiresAt ?? 0) - now())), undefined, true);
        return 'hold';
      }
      case 'kill_switch':
      case 'jobs_off':
        // The platform paused jobs: the entry keeps its place, its expiry and its attempts.
        await release(e, 0, undefined, true, true);
        return 'platform_full';
      case 'coalesce_unconfirmed':
        // Another job of the pull request is starting: wait for it, without spending an attempt.
        await release(e, DUPLICATE_RECHECK_MS, undefined, true);
        return 'hold';
      case 'launch_failed':
        if (r.jobId && (await deps.jobs.getJob(r.jobId).catch(() => null))) {
          // A launch that got as far as the job's record: never relaunched from here (its VM may
          // exist). The job's own record and recovery own it now: reconciliation, or a console
          // retry of a job whose launch failed.
          await end(e, 'admitted', { reason: 'admitted', message: 'A job was recorded for it; its page shows how its launch ended.', jobId: r.jobId });
          return 'admitted';
        }
        return failed(e, r.errorClass ?? r.disposition);
      case 'not_dispatched': {
        if (r.reason === 'native_waiting_for_sign_in' || r.reason === 'native_waiting_for_reconnect' || r.reason === 'native_waiting_for_worker') {
          // The subscription's own durable wait took it over, under the same id.
          await end(e, 'admitted', { reason: r.reason, message: r.message ?? 'Waiting for the Claude subscription.', ...(r.jobId ? { jobId: r.jobId } : {}) });
          return 'admitted';
        }
        if (r.reason === 'native_worker_unavailable') {
          // A worker that is offline is a wait (it reconnects), not a failed attempt: expiry bounds it.
          await release(e, 0, undefined, true, true);
          return 'hold';
        }
        if (r.reason === 'workflow_paused') {
          await end(e, 'canceled', { reason: 'workflow_paused', message: 'an owner stopped this workflow while the job was queued.', nextAction: 'Resume automation from the workflow page, then apply the label again.' });
          return 'ended';
        }
        await end(e, 'refused', { reason: r.reason ?? 'not_dispatched', message: r.message ? `${r.message.replace(/\.$/, '')}.` : 'the configuration active now does not start it.', nextAction: 'Check the installation configuration, then apply the label again.' });
        return 'ended';
      }
      default: {
        const refusal = REFUSALS[r.disposition];
        if (refusal) {
          await end(e, 'refused', { reason: r.disposition, message: r.message ?? refusal, nextAction: 'Fix it in Updraft, then apply the label again on GitHub.' });
          return 'ended';
        }
        // ignored, bad ids, no tenant: nothing a queued entry can become.
        await end(e, 'refused', { reason: r.disposition, message: r.message ?? 'it is no longer eligible.' });
        return 'ended';
      }
    }
  }

  async function dispatch(): Promise<DispatchReport> {
    const started = now();
    const report: DispatchReport = { scanned: 0, admitted: 0, ended: 0, deferred: 0, waiting: 0, oldestWaitSeconds: 0, tenantsAtCapacity: 0, platformAtCapacity: false, failed: 0 };
    if (await killSwitch.engaged()) return { ...report, skipped: 'kill_switch' };
    const items = await deps.queue.listWaiting(DISPATCH_SCAN);
    report.scanned = items.length;
    // Each tenant's entries in order; tenants in the order of their oldest entry.
    const lines = new Map<number, typeof items>();
    for (const item of items) lines.set(item.installationId, [...(lines.get(item.installationId) ?? []), item]);
    const blocked = new Set<number>();
    let progress = true;
    while (progress && !report.platformAtCapacity && now() - started < (deps.budgetMs ?? DISPATCH_BUDGET_MS)) {
      progress = false;
      // One entry per tenant per round: a tenant with a long line never starves another.
      for (const [tenant, line] of lines) {
        if (blocked.has(tenant) || line.length === 0) continue;
        if (now() - started >= (deps.budgetMs ?? DISPATCH_BUDGET_MS)) break;
        const item = line[0]!;
        let step: Step;
        try {
          const e = await deps.queue.get(item.installationId, item.jobId);
          if (!e || !isWaiting(e)) {
            // Settled (its index entry outlived it), or its tenant was swept.
            if (!e) await deps.queue.dropIndex(item);
            step = 'ended';
          } else {
            step = await admit(e);
          }
        } catch (err) {
          report.failed++;
          log({ installationId: item.installationId, jobId: item.jobId, error: 'queue dispatch failed', name: (err as Error)?.name, message: (err as Error)?.message });
          step = 'hold';
        }
        if (step === 'admitted' || step === 'ended') {
          report[step === 'admitted' ? 'admitted' : 'ended']++;
          line.shift();
          progress = true;
        } else {
          // FIFO: the tenant's later entries wait behind this one.
          if (step === 'hold') report.deferred++;
          if (step === 'tenant_full') report.tenantsAtCapacity++;
          if (step === 'platform_full') report.platformAtCapacity = true;
          blocked.add(tenant);
          if (report.platformAtCapacity) break;
        }
      }
    }
    const left = [...lines.values()].flat();
    report.waiting = left.length;
    const oldest = left.reduce((m, i) => Math.min(m, i.enqueuedAt), Number.POSITIVE_INFINITY);
    if (Number.isFinite(oldest)) report.oldestWaitSeconds = Math.max(0, Math.round((now() - oldest) / 1000));
    return report;
  }

  /** An owner cancels a waiting entry from the console. One being admitted right now is a job to stop instead. */
  async function cancel(installationId: number, jobId: string, by: string): Promise<QueueCancelResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = await deps.queue.get(installationId, jobId);
      if (!e) return { ok: false, status: 404, code: 'not_found', message: 'There is no such queued job in this installation' };
      if (!isWaiting(e)) return { ok: false, status: 409, code: 'not_queued', message: `This job is no longer queued (${e.state})` };
      if (e.state === 'admitting' && ((e.admittingUntil ?? 0) > now() || (await deps.jobs.getJob(e.jobId)))) {
        return { ok: false, status: 409, code: 'admitting', message: 'This job is starting now; stop it from its page once it has started' };
      }
      if (await end(e, 'canceled', { reason: 'canceled_by_owner', message: `${by} canceled it from the Updraft console.`, by })) return { ok: true, state: 'canceled' };
    }
    return { ok: false, status: 409, code: 'admitting', message: 'This job changed while it was being canceled; look again' };
  }

  /**
   * A GitHub event that ends a subject's queued work at once: its trigger label removed, or the
   * issue closed (admission checks both anyway; this answers without waiting for capacity).
   */
  async function subjectChanged(installationId: number, repositoryId: number, subject: { issue?: number; pullRequest?: number }, change: { kind: 'unlabeled'; label: string } | { kind: 'closed' }): Promise<boolean> {
    const e = await deps.queue.waitingFor(installationId, repositoryId, subject);
    if (!e || e.state !== 'queued') return false;
    if (change.kind === 'unlabeled' && (!e.label || e.label.toLowerCase() !== change.label.toLowerCase())) return false;
    // A pull request's close is its own event, queued in the entry's place: not a cancel.
    if (change.kind === 'closed' && e.issue === undefined) return false;
    const why = change.kind === 'closed'
      ? { reason: 'issue_closed', message: 'the issue was closed while the job was queued.' }
      : { reason: 'label_removed', message: `the \`${e.label}\` label was removed while the job was queued.` };
    return (await end(e, 'canceled', why)) !== null;
  }

  return { dispatch, cancel, subjectChanged };
}

export type QueueDispatcher = ReturnType<typeof createQueueDispatcher>;
