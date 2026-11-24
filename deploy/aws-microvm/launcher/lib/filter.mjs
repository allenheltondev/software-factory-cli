// Decides whether a verified webhook delivery is worth a microVM.
//
// This is an optimisation, not the authority. It only drops deliveries that cannot lead to
// work. Whether the label is a trigger, whether the actor is allowed, whether the issue was
// edited since, whether a pull request is one Updraft opened, whether a review asks for
// changes and by whom: all of that is decided by `updraft run-event` inside the microVM,
// against the GitHub API, the Updraft config and the shared state database.

/**
 * Events and actions `updraft run-event` handles. Which of these events a deployment accepts
 * is a setting (the AcceptedEvents template parameter); the default is `issues` only.
 */
export const SUPPORTED = Object.freeze({
  issues: Object.freeze(['labeled']),
  pull_request_review: Object.freeze(['submitted', 'edited', 'dismissed']),
  // Not `reopened`: a closed pull request is no longer watched, for good, so run-event would
  // start, find that out and exit. An action that is not listed starts no microVM.
  pull_request: Object.freeze(['synchronize', 'closed']),
  // The CI step (repositories.<repo>.ciFix): a check suite finished on a pull request's head. One
  // delivery per suite, not per check run, and a status event names no pull request at all.
  check_suite: Object.freeze(['completed']),
});

export const DEFAULT_ACCEPTED_EVENTS = Object.freeze(['issues']);
/** Updraft's job branches are `updraft/issue-<n>-<job id>`; revisions and reviews only concern those. */
export const DEFAULT_PR_BRANCH_PREFIX = 'updraft/';

/**
 * Parses the ACCEPTED_EVENTS setting: comma-separated event names, each one of SUPPORTED.
 * Empty means the default. Throws for a name run-event does not handle, so that a typo is a
 * loud misconfiguration and not a silently ignored event.
 */
export function parseAcceptedEvents(text) {
  const names = String(text ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) return [...DEFAULT_ACCEPTED_EVENTS];
  for (const name of names) {
    if (!Object.hasOwn(SUPPORTED, name)) {
      throw new Error(`ACCEPTED_EVENTS names ${printable(name)}; the events that can start a job are ${Object.keys(SUPPORTED).join(', ')}`);
    }
  }
  return [...new Set(names)];
}

/** Whether any delivery of this event can start a job; false means the body need not be read. */
export function canLaunch(eventName, acceptedEvents = DEFAULT_ACCEPTED_EVENTS) {
  return typeof eventName === 'string' && Object.hasOwn(SUPPORTED, eventName) && acceptedEvents.includes(eventName);
}

/**
 * @param {string | undefined} eventName the X-GitHub-Event header
 * @param {unknown} payload the parsed webhook body
 * @param {object} [options]
 * @param {string[]} [options.acceptedEvents] events this deployment acts on (default: issues)
 * @param {string[]} [options.triggerLabels] when not empty, only these label names launch a
 *   microVM for an issues event (compared case-insensitively, as GitHub treats label names)
 * @param {string} [options.prBranchPrefix] when not empty, pull request events launch only
 *   for pull requests whose head branch starts with it
 * @param {string[]} [options.ignoredSenders] logins whose pull request events never launch
 *   (the App's own `<slug>[bot]`: the run that pushed or reviewed already knows what it did)
 * @returns {{ launch: boolean, reason: string, pullRequest?: { repository: string, number: number } }}
 *   `pullRequest` is set for an accepted pull request event; the launcher coalesces on it
 */
export function decideEvent(eventName, payload, options = {}) {
  if (typeof eventName !== 'string' || eventName === '') return skip('no X-GitHub-Event header');
  if (eventName === 'ping') return skip('ping');
  if (!canLaunch(eventName, options.acceptedEvents ?? DEFAULT_ACCEPTED_EVENTS)) return skip(`event ${printable(eventName)} is not handled`);
  const actions = SUPPORTED[eventName];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return skip('payload is not a JSON object');
  }
  const action = payload.action;
  if (typeof action !== 'string' || !actions.includes(action)) {
    return skip(`action ${printable(action)} of ${eventName} is not handled`);
  }
  if (typeof payload.repository?.full_name !== 'string') return skip('payload has no repository.full_name');
  return eventName === 'issues' ? decideIssue(eventName, action, payload, options) : decidePullRequest(eventName, action, payload, options);
}

function decideIssue(eventName, action, payload, options) {
  if (!Number.isInteger(payload.issue?.number)) return skip('payload has no issue.number');
  const label = payload.label?.name;
  if (typeof label !== 'string' || label === '') return skip('payload has no label.name');
  const wanted = (options.triggerLabels ?? []).map((name) => name.toLowerCase());
  if (wanted.length > 0 && !wanted.includes(label.toLowerCase())) {
    return skip('label is not in TRIGGER_LABELS');
  }
  return { launch: true, reason: `${eventName}.${action}` };
}

/**
 * The pull request a delivery is about, and its head branch: the payload's pull_request, or for a
 * check suite the first pull request it lists (GitHub lists those whose head is the suite's commit).
 */
export function pullRequestOf(eventName, payload) {
  if (eventName === 'check_suite') {
    const listed = Array.isArray(payload.check_suite?.pull_requests) ? payload.check_suite.pull_requests : [];
    const first = listed.find((p) => Number.isInteger(p?.number));
    return { number: first?.number, branch: first?.head?.ref ?? payload.check_suite?.head_branch };
  }
  return { number: payload.pull_request?.number, branch: payload.pull_request?.head?.ref };
}

function decidePullRequest(eventName, action, payload, options) {
  const { number, branch } = pullRequestOf(eventName, payload);
  if (!Number.isInteger(number)) return skip(eventName === 'check_suite' ? 'the check suite is not about a pull request' : 'payload has no pull_request.number');
  // Revisions and reviews are only ever made to pull requests Updraft opened, and those are
  // on its job branches. A pull request on any other branch cannot lead to work.
  const prefix = options.prBranchPrefix ?? DEFAULT_PR_BRANCH_PREFIX;
  if (prefix !== '' && (typeof branch !== 'string' || !branch.startsWith(prefix))) {
    return skip('the pull request is not on an Updraft job branch');
  }
  const sender = payload.sender?.login;
  const ignored = (options.ignoredSenders ?? []).map((login) => login.toLowerCase());
  // A check suite's sender is whoever pushed the commit, often the App itself: its checks are
  // still news to the run that pushed, which has ended by the time they finish.
  if (eventName !== 'check_suite' && typeof sender === 'string' && ignored.includes(sender.toLowerCase())) {
    return skip('the sender is in IGNORED_SENDERS');
  }
  if (eventName === 'pull_request_review') {
    if (!Number.isInteger(payload.review?.id)) return skip('payload has no review.id');
    // A "Comment" review starts nothing in Updraft (only "Request changes" does; an approval
    // or a dismissal can cancel a pending revision). Updraft's own reviewer posts comment
    // reviews, so this is also what keeps a run from waking a second microVM for itself.
    if (typeof payload.review.state === 'string' && payload.review.state.toLowerCase() === 'commented') {
      return skip('a comment review starts nothing');
    }
  }
  return {
    launch: true,
    reason: `${eventName}.${action}`,
    pullRequest: { repository: payload.repository.full_name.toLowerCase(), number },
  };
}

function skip(reason) {
  return { launch: false, reason };
}

// Header and payload values end up in a response body and a log line; keep them short and tame.
function printable(value) {
  if (typeof value !== 'string') return '(none)';
  return JSON.stringify(value.slice(0, 40).replace(/[^\w.-]/g, '?'));
}
