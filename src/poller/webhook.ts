// One GitHub webhook delivery, turned into the jobs the poller would have queued for it.
// Behind `updraft run-event` (docs/run-event.md).
//
// The payload is a hint, not an authority. It reached this process through a launcher, so it
// decides nothing the poller decides from the API: it says which repository (by id), which issue
// and which label to look at, and everything else is read from GitHub and judged by the poller's
// own rules (buildJobs). The only thing a payload can do on its own is make this say "nothing to
// do" without asking GitHub at all.
//
// The rest of the system keys on the id of the issue's timeline event (job.eventId, the dedupe
// key, and the live-mode check that the label application that queued a job is still the current
// one). A webhook payload does not carry that id. It is found in the issue's events: the
// `labeled` event for this label, by the payload's sender, created at the payload's time. From
// there the existing pre-start checks run unchanged.
import { createHash } from 'node:crypto';
import type { UpdraftConfig } from '../config/schema.js';
import type { NewJob } from '../db/ingest.js';
import type { GitHubApi, GitHubIssueEvent } from '../github/api.js';
import { labelEquals } from '../routing.js';
import type { RepoRef } from '../types.js';
import type { Logger } from '../util/log.js';
import { buildJobs, findRepo, isGone, type IngestSkipReason, type PollerDeps } from './poller.js';

/** Why a delivery queued nothing. */
export type NothingToDoReason =
  | 'unsupported-event'
  | 'unsupported-action'
  | 'malformed-payload'
  | 'pull-request'
  | 'repository-not-configured'
  | 'label-not-configured'
  | IngestSkipReason;

/** What the delivery was about, as far as it could be read. `eventId` is the timeline event's id, from the API. */
export interface WebhookEventInfo {
  name: string;
  action: string | null;
  deliveryId: string | null;
  repository: string | null;
  repositoryId: number | null;
  issue: number | null;
  label: string | null;
  sender: string | null;
  eventId: string | null;
}

export type WebhookDecision =
  | { dispatch: false; reason: NothingToDoReason; message: string; event: WebhookEventInfo }
  | { dispatch: true; repo: RepoRef; jobs: Array<NewJob & { id: string }>; applied: GitHubIssueEvent; event: WebhookEventInfo };

/**
 * The label application of a delivery could not be found among the issue's events, even after
 * waiting for them to catch up. Not "nothing to do": the delivery may be real, so the caller
 * fails and a redelivery can try again.
 */
export class EventNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventNotFoundError';
  }
}

export interface WebhookDeps {
  api: GitHubApi;
  config: UpdraftConfig;
  log: Logger;
  /** The state database: the poller's rules use it when a workflow routes by triage (its cache). */
  db: PollerDeps['db'];
  /** As for the poller: where relative paths in the config resolve, the clock, and a triage runner for tests. */
  configDir?: string;
  now?: () => number;
  triage?: PollerDeps['triage'];
  signal?: AbortSignal;
  /**
   * The issue's events can trail the webhook by a moment: how many times to read them again when
   * the application is not there yet, and how long to wait in between. Defaults: 5 more reads, 3s apart.
   */
  eventLookup?: { retries?: number; delayMs?: number };
}

/**
 * How far before the payload's time a `labeled` event may have been created and still be the one
 * the payload is about. Both times are GitHub's, to the second; the slack only has to cover that.
 * It must stay short: an older application of the same label by the same person is a different
 * event, and taking it for this one would run (or skip) the wrong job.
 */
export const EVENT_MATCH_SLACK_MS = 60_000;

/**
 * The job id for an event in `updraft run-event`: the same for every delivery of the event, in
 * every state directory. The job branch is named after the job id (jobBranchName), so the branch
 * is the same too, and GitHub itself shows whether the event was already handled.
 * Shaped like any job id (isJobBranchName accepts the branch).
 */
export function eventJobId(repoId: number, workflowId: string, eventId: string): string {
  const scope = createHash('sha256').update(`${repoId}\n${workflowId}`).digest('hex').slice(0, 10);
  return `job_ev${eventId.replace(/[^A-Za-z0-9]/g, '')}x${scope}`;
}

type Payload = Record<string, unknown>;
const obj = (v: unknown): Payload | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

type Handler = (deps: WebhookDeps, payload: Payload, event: WebhookEventInfo) => Promise<WebhookDecision>;

/**
 * What is recognised: event name (the X-GitHub-Event header) to action to handler. Everything
 * else is "nothing to do". `pull_request_review` (the revision and review loops) belongs here
 * when those loops are driven by webhooks.
 */
const HANDLERS: Readonly<Record<string, Readonly<Record<string, Handler>>>> = {
  issues: { labeled: issueLabeled },
};

/** Event names and actions `decideWebhook` acts on, for messages and docs. */
export function supportedWebhookEvents(): string[] {
  return Object.entries(HANDLERS).flatMap(([name, actions]) => Object.keys(actions).map((a) => `${name}.${a}`));
}

/**
 * Decide what one delivery queues. Reads GitHub; writes nothing. Throws for API failures and for
 * EventNotFoundError: neither is "nothing to do".
 */
export async function decideWebhook(deps: WebhookDeps, input: { eventName: string; deliveryId?: string | null; payload: unknown }): Promise<WebhookDecision> {
  const payload = obj(input.payload);
  const repository = obj(payload?.repository);
  const issue = obj(payload?.issue);
  const event: WebhookEventInfo = {
    name: input.eventName,
    action: str(payload?.action),
    deliveryId: input.deliveryId ?? null,
    repository: str(repository?.full_name),
    repositoryId: int(repository?.id),
    issue: int(issue?.number),
    label: str(obj(payload?.label)?.name),
    sender: str(obj(payload?.sender)?.login),
    eventId: null,
  };
  const nothing = (reason: NothingToDoReason, message: string): WebhookDecision => ({ dispatch: false, reason, message, event });
  if (!payload) return nothing('malformed-payload', 'the event is not a JSON object');
  const actions = Object.hasOwn(HANDLERS, event.name) ? HANDLERS[event.name] : undefined;
  if (!actions) return nothing('unsupported-event', `"${event.name}" events are not handled (handled: ${supportedWebhookEvents().join(', ')})`);
  if (!event.action) return nothing('malformed-payload', `the ${event.name} event has no action`);
  const handler = Object.hasOwn(actions, event.action) ? actions[event.action] : undefined;
  if (!handler) return nothing('unsupported-action', `${event.name} events with action "${event.action}" are not handled (handled: ${supportedWebhookEvents().join(', ')})`);
  return handler(deps, payload, event);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * The `labeled` event a payload is about, among the issue's events (oldest first): this label,
 * this sender, created no earlier than the payload's time (minus EVENT_MATCH_SLACK_MS), and of
 * those the one nearest that time. Without a usable time in the payload: the newest by the sender.
 */
export function findLabelApplication(
  events: readonly GitHubIssueEvent[],
  want: { label: string; sender: string | null; at: string | null },
): number {
  const at = want.at ? Date.parse(want.at) : Number.NaN;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  events.forEach((e, i) => {
    if (e.event !== 'labeled' || e.label === null || !labelEquals(e.label, want.label)) return;
    if (want.sender !== null && e.actor?.toLowerCase() !== want.sender.toLowerCase()) return;
    const created = Date.parse(e.createdAt);
    if (!Number.isFinite(at) || !Number.isFinite(created)) {
      if (!Number.isFinite(at)) best = i; // no time to go by: the newest
      return;
    }
    if (created < at - EVENT_MATCH_SLACK_MS) return;
    const distance = Math.abs(created - at);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

async function issueLabeled(deps: WebhookDeps, payload: Payload, event: WebhookEventInfo): Promise<WebhookDecision> {
  const nothing = (reason: NothingToDoReason, message: string): WebhookDecision => ({ dispatch: false, reason, message, event });
  const issue = obj(payload.issue);
  if (event.repositoryId === null || event.issue === null || event.label === null || !issue) {
    return nothing('malformed-payload', 'the issues.labeled event lacks a repository id, an issue number or a label');
  }
  // Screens that need no request. They can only say no; every yes below comes from the API.
  if (issue.pull_request !== undefined && issue.pull_request !== null) return nothing('pull-request', `#${event.issue} is a pull request, not an issue`);
  const found = findRepo(deps.config, event.repositoryId);
  if (!found) {
    return nothing('repository-not-configured', `no configured repository has id ${event.repositoryId}${event.repository ? ` (${event.repository})` : ''}`);
  }
  const label = event.label;
  if (!found.cfg.workflows.some((wf) => labelEquals(wf.trigger.label, label))) {
    return nothing('label-not-configured', `label "${label}" is not the trigger label of any workflow of ${found.fullName}`);
  }
  // The configured name for the configured id, never the payload's.
  const repo: RepoRef = { id: found.cfg.id, fullName: found.fullName };
  const issueNumber = event.issue;

  const retries = deps.eventLookup?.retries ?? 5;
  const delayMs = deps.eventLookup?.delayMs ?? 3_000;
  const want = { label, sender: event.sender, at: str(issue.updated_at) };
  let events: GitHubIssueEvent[] = [];
  let index = -1;
  for (let attempt = 0; ; attempt++) {
    try {
      events = await deps.api.listEventsForIssue(repo, issueNumber);
    } catch (err) {
      if (isGone(err)) return nothing('issue-gone', `issue #${issueNumber} was deleted, transferred or is no longer accessible`);
      throw err;
    }
    index = findLabelApplication(events, want);
    if (index >= 0 || attempt >= retries || deps.signal?.aborted) break;
    deps.log.info('the label application is not among the issue events yet; reading them again', { issue: issueNumber, label, attempt: attempt + 1 });
    await sleep(delayMs, deps.signal);
  }
  const applied = events[index];
  if (!applied) {
    throw new EventNotFoundError(
      `GitHub's events for ${repo.fullName}#${issueNumber} show no "${label}" label applied` +
        `${event.sender ? ` by ${event.sender}` : ''}${want.at ? ` at ${want.at}` : ''}; the event cannot be matched, so nothing was started`,
    );
  }
  event.eventId = String(applied.id);

  // The poller's rules, on what the poller would have seen: this application and everything that
  // happened on the issue after it. A later application of the label is another delivery's event.
  const subject = { number: issueNumber, title: '', htmlUrl: '', isPullRequest: false };
  const scan = [applied, ...events.slice(index + 1).filter((e) => e.event !== 'labeled')].map((e) => ({ ...e, issue: subject }));
  let skipped: { reason: IngestSkipReason; message: string } | null = null;
  const jobs = await buildJobs(
    deps,
    repo,
    found.cfg,
    scan,
    (r, n) => deps.api.getIssue(r, n),
    deps.log.child({ repo: repo.fullName }),
    (reason, message) => (skipped = { reason, message }),
  );
  if (!jobs.length) {
    const why = skipped as { reason: IngestSkipReason; message: string } | null;
    const who = applied.actor ?? 'an unknown actor';
    const messages: Record<IngestSkipReason, string> = {
      'actor-not-allowed': `"${label}" was applied to #${issueNumber} by ${who}, who is not an allowed actor`,
      'label-removed': `"${label}" was removed from #${issueNumber} again after this application`,
      'issue-gone': `issue #${issueNumber} was deleted, transferred or is no longer accessible`,
      'pull-request': `#${issueNumber} is a pull request, not an issue`,
      'issue-closed': `issue #${issueNumber} is closed`,
      'label-missing': `issue #${issueNumber} no longer carries the label "${label}"`,
    };
    return why ? nothing(why.reason, messages[why.reason]) : nothing('label-not-configured', `label "${label}" matched no workflow of ${repo.fullName}`);
  }
  return {
    dispatch: true,
    repo,
    applied,
    event,
    jobs: jobs.map((j) => ({ ...j, id: eventJobId(j.repoId, j.workflowId, j.eventId) })),
  };
}
