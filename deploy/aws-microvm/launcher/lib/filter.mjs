// Decides whether a verified webhook delivery is worth a microVM.
//
// This is an optimisation, not the authority. It only drops deliveries that cannot lead to
// work. Whether the label is a trigger, whether the actor is allowed, whether the issue was
// edited since: all of that is decided by `updraft run-event` inside the microVM, against the
// GitHub API and the Updraft config.

/** Events and actions that can start a job. Extend this when run-event handles more. */
export const ACCEPTED = Object.freeze({ issues: Object.freeze(['labeled']) });

/** Whether any delivery of this event can start a job; false means the body need not be read. */
export function canLaunch(eventName) {
  return typeof eventName === 'string' && Object.hasOwn(ACCEPTED, eventName);
}

/**
 * @param {string | undefined} eventName the X-GitHub-Event header
 * @param {unknown} payload the parsed webhook body
 * @param {{ triggerLabels?: string[] }} [options] when triggerLabels is not empty, only these
 *   label names launch a microVM (compared case-insensitively, as GitHub treats label names)
 * @returns {{ launch: boolean, reason: string }}
 */
export function decideEvent(eventName, payload, options = {}) {
  if (typeof eventName !== 'string' || eventName === '') return skip('no X-GitHub-Event header');
  if (eventName === 'ping') return skip('ping');
  if (!canLaunch(eventName)) return skip(`event ${printable(eventName)} is not handled`);
  const actions = ACCEPTED[eventName];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return skip('payload is not a JSON object');
  }
  const action = payload.action;
  if (typeof action !== 'string' || !actions.includes(action)) {
    return skip(`action ${printable(action)} of ${eventName} is not handled`);
  }
  if (typeof payload.repository?.full_name !== 'string') return skip('payload has no repository.full_name');
  if (!Number.isInteger(payload.issue?.number)) return skip('payload has no issue.number');
  const label = payload.label?.name;
  if (typeof label !== 'string' || label === '') return skip('payload has no label.name');
  const wanted = (options.triggerLabels ?? []).map((name) => name.toLowerCase());
  if (wanted.length > 0 && !wanted.includes(label.toLowerCase())) {
    return skip('label is not in TRIGGER_LABELS');
  }
  return { launch: true, reason: `${eventName}.${action}` };
}

function skip(reason) {
  return { launch: false, reason };
}

// Header and payload values end up in a response body and a log line; keep them short and tame.
function printable(value) {
  if (typeof value !== 'string') return '(none)';
  return JSON.stringify(value.slice(0, 40).replace(/[^\w.-]/g, '?'));
}
