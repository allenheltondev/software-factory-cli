import type { DispatchRules } from '../store/store.js';

/**
 * Which labeled issues of a tenant start a job (#68, the launcher's filter). Computed from the
 * compiled config when it is published and stored with the version, so the launcher decides
 * without reading the bundle, and changing it takes a publish, not a deploy.
 *
 * Like the self-hosted launcher's filter this is an optimisation, not the authority: `updraft
 * run-event` in the microVM decides again, against GitHub and the same config. What it must never
 * do is start a job the config would not: an unknown repository, a label that is no trigger, an
 * actor who is not allowed.
 */

type Workflow = { trigger?: { label?: unknown }; allowedActors?: unknown };
type Repository = { id?: unknown; workflows?: unknown; review?: unknown; revise?: unknown; ciFix?: unknown };

/** What a repository's dispatch rules need beyond the compiled config: whether it is paused. */
export interface DispatchOptions {
  /** OWNER/REPO (any case) of repositories that stay configured but start nothing. */
  paused?: ReadonlySet<string>;
  /** The agent keys a job of this workflow can need (key-needs.ts workflowKeys). Absent: triggers record none. */
  keysFor?: (repo: Record<string, unknown>, workflow: Record<string, unknown>) => string[];
}

const lowerStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '').map((v) => v.toLowerCase()) : [];

/** From a compiled (validated) config: `repositories` and `dispatch.allowedActors`. */
export function dispatchRules(compiled: { repositories?: Record<string, unknown>; dispatch?: { allowedActors?: unknown } }, options: DispatchOptions = {}): DispatchRules {
  const paused = new Set([...(options.paused ?? [])].map((r) => r.toLowerCase()));
  const fallbackActors = lowerStrings(compiled.dispatch?.allowedActors);
  const repositories: DispatchRules['repositories'] = {};
  for (const [fullName, raw] of Object.entries(compiled.repositories ?? {})) {
    const repo = raw as Repository;
    if (typeof repo.id !== 'number') continue;
    const triggers: { label: string; actors: string[]; keys?: string[] }[] = [];
    for (const wf of Array.isArray(repo.workflows) ? (repo.workflows as Workflow[]) : []) {
      const label = wf.trigger?.label;
      if (typeof label !== 'string' || label === '') continue;
      // Each workflow's own keys: two workflows on one label, for different actors, each keep theirs.
      const keys = options.keysFor ? options.keysFor(repo as Record<string, unknown>, wf as Record<string, unknown>) : undefined;
      triggers.push({ label: label.toLowerCase(), actors: wf.allowedActors === undefined ? fallbackActors : lowerStrings(wf.allowedActors), ...(keys ? { keys } : {}) });
    }
    // One shared list (of actors, of keys) is stored once, not copied to each trigger.
    const same = (a: string[] | undefined, b: string[] | undefined) => a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
    const first = triggers[0]?.actors;
    const shared = first !== undefined && triggers.every((t) => same(t.actors, first));
    const firstKeys = triggers[0]?.keys;
    const sharedKeys = firstKeys !== undefined && triggers.every((t) => same(t.keys, firstKeys));
    const stored = triggers.map(({ actors, keys, ...t }) => ({ ...t, ...(shared ? {} : { actors }), ...(sharedKeys || keys === undefined ? {} : { keys }) }));
    // The review loop (the CLI's reviewSettings and reviseActive; Updraft Cloud always runs live
    // and always publishes): whether events on the repository's pull requests can lead to work.
    const review = repo.review === true || (typeof repo.review === 'object' && repo.review !== null && !Array.isArray(repo.review));
    const revise = repo.revise === true;
    // The CI step (the CLI's ciSettings): with review on, a finished check suite can lead to work.
    const ci = review && (repo.ciFix === true || (typeof repo.ciFix === 'object' && repo.ciFix !== null && !Array.isArray(repo.ciFix)));
    repositories[fullName.toLowerCase()] = {
      id: repo.id,
      ...(paused.has(fullName.toLowerCase()) ? { paused: true } : {}),
      ...(shared ? { actors: first } : {}),
      ...(sharedKeys ? { keys: firstKeys } : {}),
      ...(review ? { review: true as const } : {}),
      ...(revise ? { revise: true as const } : {}),
      ...(ci ? { ci: true as const } : {}),
      triggers: stored,
    };
  }
  return { repositories, loop: true };
}

/**
 * `keys`: the agent keys the job can need (those of every matching trigger the sender may
 * apply), or null when the version predates them and they must be read from its bundle.
 */
export type DispatchDecision = { start: true; repository: string; repositoryId: number; label: string; keys: string[] | null } | { start: false; reason: string; code: DispatchRefusalCode };

/** Why a delivery started nothing, as the console shows it (#71). */
export type DispatchRefusalCode = 'no_rules' | 'unknown_repo' | 'paused' | 'not_trigger' | 'actor_not_allowed';

/**
 * Whether an `issues.labeled` delivery starts a job under these rules. The repository must match
 * by name and id (a renamed or recreated repository is not the configured one).
 */
export function decideDispatch(
  rules: DispatchRules | undefined,
  event: { repositoryFullName: unknown; repositoryId: unknown; label: unknown; sender: unknown },
): DispatchDecision {
  if (!rules) return { start: false, reason: 'the active config has no dispatch rules (publish it again)', code: 'no_rules' };
  if (typeof event.repositoryFullName !== 'string' || typeof event.repositoryId !== 'number') return { start: false, reason: 'no repository in the event', code: 'unknown_repo' };
  const repository = event.repositoryFullName.toLowerCase();
  const repo = rules.repositories[repository];
  if (!repo || repo.id !== event.repositoryId) return { start: false, reason: 'the repository is not in the active config', code: 'unknown_repo' };
  if (repo.paused) return { start: false, reason: 'the repository is paused', code: 'paused' };
  if (typeof event.label !== 'string' || event.label === '') return { start: false, reason: 'no label in the event', code: 'not_trigger' };
  const label = event.label.toLowerCase();
  const matching = repo.triggers.filter((t) => t.label === label);
  if (matching.length === 0) return { start: false, reason: 'the label is not a trigger', code: 'not_trigger' };
  const sender = typeof event.sender === 'string' ? event.sender.toLowerCase() : '';
  const allowed = matching.filter((t) => (t.actors ?? repo.actors ?? []).includes(sender));
  if (allowed.length === 0) return { start: false, reason: 'the sender may not dispatch work', code: 'actor_not_allowed' };
  const keysOf = (t: { keys?: string[] }) => t.keys ?? repo.keys;
  const keys = allowed.every((t) => Array.isArray(keysOf(t))) ? [...new Set(allowed.flatMap((t) => keysOf(t)!))].sort() : null;
  return { start: true, repository: event.repositoryFullName, repositoryId: event.repositoryId, label: event.label, keys };
}

/**
 * Pull request events that can lead to work, as `updraft run-event` handles them (the self-hosted
 * launcher's filter, deploy/aws-microvm/launcher/lib/filter.mjs): a review that is not a comment
 * review (a "Request changes" starts a revision; an approval or a dismissal can cancel one), a
 * push (a new review), and a close (the pull request is no longer watched). Not `reopened`: a
 * closed pull request is no longer watched, for good.
 */
export const PULL_REQUEST_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  pull_request: ['synchronize', 'closed'],
  // The CI step (ciFix): checks finished on a pull request's head. One delivery per suite.
  check_suite: ['completed'],
};

/**
 * The pull request a delivery is about and its head branch: the payload's `pull_request`, or for
 * a check suite the first pull request it lists (those whose head is the suite's commit).
 */
export function pullRequestOfPayload(
  eventName: string,
  payload: { pull_request?: { number?: unknown; head?: { ref?: unknown } }; check_suite?: { head_branch?: unknown; pull_requests?: unknown } },
): { number: unknown; headRef: unknown } {
  if (eventName === 'check_suite') {
    const listed = Array.isArray(payload.check_suite?.pull_requests) ? (payload.check_suite.pull_requests as Array<{ number?: unknown; head?: { ref?: unknown } } | null>) : [];
    const first = listed.find((p) => typeof p?.number === 'number' && Number.isSafeInteger(p.number));
    return { number: first?.number, headRef: first?.head?.ref ?? payload.check_suite?.head_branch };
  }
  return { number: payload.pull_request?.number, headRef: payload.pull_request?.head?.ref };
}

/** Updraft's job branches are `updraft/issue-<n>-<job id>`: revisions and reviews only concern those. */
export const UPDRAFT_BRANCH_PREFIX = 'updraft/';

export type PullRequestRefusalCode = DispatchRefusalCode | 'event_not_accepted' | 'loop_off' | 'not_updraft_pr' | 'own_event' | 'comment_review';

export type PullRequestDecision =
  | {
      start: true;
      repository: string;
      repositoryId: number;
      pullRequest: number;
      /** A close: it ends the loop and runs no agent, so it needs no key. */
      closing: boolean;
      /**
       * Per trigger label (lower-case): the keys of its workflow, when the label names one set of
       * keys; null when workflows sharing it (for different actors) need different keys, or the
       * version recorded none. The launcher's fallback, when the job that opened the pull request
       * no longer says which keys it ran with.
       */
      keysByLabel: Record<string, string[] | null>;
    }
  | { start: false; reason: string; code: PullRequestRefusalCode };


/**
 * Whether a pull request delivery starts a job under these rules: the repository (name and id),
 * not paused, with its review loop on for what the event can lead to (a review: revisions; a
 * push: reviews; a close: either), on an Updraft branch, not the App's own doing (its reviewer's
 * comment reviews, its revision pushes: the run that made them handles what follows), and, for a
 * review or a push, by a login the repository allows. A close is anyone's: it ends the loop.
 *
 * As for issues, an optimisation and a guard on what is paid for, not the authority: run-event
 * reads the pull request on GitHub and the state database, and decides again.
 */
export function decidePullRequestDispatch(
  rules: DispatchRules | undefined,
  event: {
    eventName: string;
    action: unknown;
    repositoryFullName: unknown;
    repositoryId: unknown;
    sender: unknown;
    number: unknown;
    headRef: unknown;
    reviewState?: unknown;
  },
  options: { appBot?: string } = {},
): PullRequestDecision {
  const actions = PULL_REQUEST_ACTIONS[event.eventName];
  if (!actions || typeof event.action !== 'string' || !actions.includes(event.action)) {
    return { start: false, reason: `${event.eventName}.${typeof event.action === 'string' ? event.action : '?'} leads to no work`, code: 'event_not_accepted' };
  }
  if (!rules) return { start: false, reason: 'the active config has no dispatch rules (publish it again)', code: 'no_rules' };
  if (typeof event.repositoryFullName !== 'string' || typeof event.repositoryId !== 'number') return { start: false, reason: 'no repository in the event', code: 'unknown_repo' };
  if (typeof event.number !== 'number' || !Number.isSafeInteger(event.number)) return { start: false, reason: 'no pull request in the event', code: 'event_not_accepted' };
  const repository = event.repositoryFullName.toLowerCase();
  const repo = rules.repositories[repository];
  if (!repo || repo.id !== event.repositoryId) return { start: false, reason: 'the repository is not in the active config', code: 'unknown_repo' };
  if (repo.paused) return { start: false, reason: 'the repository is paused', code: 'paused' };
  if (!rules.loop) return { start: false, reason: 'the active config was published before pull request events started jobs: publish it again', code: 'loop_off' };
  const review = event.eventName === 'pull_request_review';
  const push = event.eventName === 'pull_request' && event.action === 'synchronize';
  const checks = event.eventName === 'check_suite';
  if (checks && !repo.ci) return { start: false, reason: 'ciFix is off for this repository', code: 'loop_off' };
  if (review && !repo.revise) return { start: false, reason: 'revisions are off for this repository', code: 'loop_off' };
  if (push && !repo.review) return { start: false, reason: 'review is off for this repository', code: 'loop_off' };
  if (!repo.review && !repo.revise) return { start: false, reason: 'review and revisions are off for this repository', code: 'loop_off' };
  if (typeof event.headRef !== 'string' || !event.headRef.startsWith(UPDRAFT_BRANCH_PREFIX)) {
    return { start: false, reason: 'the pull request is not on an Updraft branch', code: 'not_updraft_pr' };
  }
  const sender = typeof event.sender === 'string' ? event.sender.toLowerCase() : '';
  // A check suite's sender is whoever pushed, often the App itself; its checks are news all the same.
  if (!checks && options.appBot && sender === options.appBot.toLowerCase()) return { start: false, reason: "the App's own review or push: the run that made it handles what follows", code: 'own_event' };
  if (review && typeof event.reviewState === 'string' && event.reviewState.toLowerCase() === 'commented') {
    return { start: false, reason: 'a comment review starts nothing (only "Request changes" does)', code: 'comment_review' };
  }
  if (review || push) {
    const actors = new Set([...(repo.actors ?? []), ...repo.triggers.flatMap((t) => t.actors ?? [])]);
    if (!actors.has(sender)) return { start: false, reason: 'the sender may not dispatch work', code: 'actor_not_allowed' };
  }
  // The event names no label: the keys are those of the workflow that started the pull request,
  // which the launcher finds from the job that opened it. Never every workflow's: a Codex workflow
  // without its key must not hold up a Claude workflow's pull request.
  const keysByLabel: Record<string, string[] | null> = {};
  for (const t of repo.triggers) {
    const keys = t.keys ?? repo.keys;
    const before = keysByLabel[t.label];
    const sorted = keys === undefined ? null : [...keys].sort();
    const same = before !== undefined && before !== null && sorted !== null && before.length === sorted.length && before.every((k, i) => k === sorted[i]);
    // Two workflows on one label with different keys: the label does not say which one it was.
    keysByLabel[t.label] = before === undefined ? sorted : same ? before : null;
  }
  const closing = event.eventName === 'pull_request' && event.action === 'closed';
  return { start: true, repository: event.repositoryFullName, repositoryId: event.repositoryId, pullRequest: event.number, closing, keysByLabel };
}
