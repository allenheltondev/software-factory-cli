// The live status comment's format (docs/assignment-comments.md, "One status comment"), shared by
// its two writers: Updraft Cloud's admission queue (cloud/server/src/jobs/queue.ts), which posts it
// when work has to wait for capacity, and the runner (`updraft run-event`, or a standalone worker),
// which posts it at assignment if nothing did and edits it as the run moves on.
//
// GitHub has no compare-and-set for comments, so the protocol is read, decide, write:
//   - one hidden marker carries the comment's key (the job that started it), the stage it shows
//     and, once one is opened, the pull request: `<!-- updraft-status: key=K stage=N pr=P -->`;
//   - every writer lists the issue's comments and finds the comment by that marker before every
//     write, so a lost response or a redelivered event edits the comment again instead of posting
//     a second one;
//   - stages only move forward across writers: a Cloud stage (below RUNNER_STAGE) never replaces a
//     runner stage, so a late queue edit cannot overwrite what the run already said; a runner's
//     assignment or publication never replaces a later stage; nothing replaces a final stage
//     except another final one.
// This file is pure (no I/O) so both packages use the very same rules.

/** Stages as ordinals. Below RUNNER_STAGE: written by the Cloud queue; from it on: by the runner. */
export const STATUS_STAGE = {
  /** Waiting for capacity (Cloud). */
  queued: 10,
  /** Admitted, waiting for the connected Claude subscription (Cloud). */
  waiting: 15,
  /** The queued work never started: canceled, refused or expired (Cloud). */
  ended: 25,
  /** A worker claimed the run (runner). */
  assigned: 30,
  /** Its pull request is open (runner). */
  published: 40,
  /** The review loop is at work on a head: reviewing, revising, fixing checks (runner). */
  loop: 50,
  /** The review loop rests on a head until a person acts: ready to merge by hand, changes up to a person (runner). */
  person: 60,
  /** Merged, or closed for good (runner). */
  final: 90,
} as const;

export const RUNNER_STAGE = STATUS_STAGE.assigned;
export const FINAL_STAGE = STATUS_STAGE.final;

export interface StatusMark {
  /** The job the comment belongs to: the Cloud job id, or the local job id for a standalone worker. */
  key: string;
  stage: number;
  /** The pull request it reports on, once one is open. */
  pr?: number;
  /** The review loop's stages: the head commit (7 to 40 hex) the stage is about. */
  sha?: string;
}

const KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const MARKER = /<!-- updraft-status: key=([A-Za-z0-9_.-]{1,128}) stage=(\d{1,3})(?: pr=(\d{1,10}))?(?: sha=([0-9a-f]{7,40}))? -->/;
const SHA = /^[0-9a-f]{7,40}$/;
/** What every status comment contains, whatever its key: for a search. */
export const STATUS_MARKER_PREFIX = '<!-- updraft-status: ';

export function statusMarker(m: StatusMark): string {
  if (!KEY.test(m.key)) throw new Error(`not a status comment key: ${JSON.stringify(m.key)}`);
  const pr = m.pr !== undefined && Number.isSafeInteger(m.pr) && m.pr > 0 ? ` pr=${m.pr}` : '';
  const sha = m.sha !== undefined && SHA.test(m.sha) ? ` sha=${m.sha}` : '';
  return `<!-- updraft-status: key=${m.key} stage=${Math.max(0, Math.min(999, Math.trunc(m.stage)))}${pr}${sha} -->`;
}

/** The marker of a status comment, or null for any other comment. */
export function parseStatusMarker(body: string): StatusMark | null {
  const m = MARKER.exec(body);
  if (!m) return null;
  return { key: m[1]!, stage: Number(m[2]), ...(m[3] ? { pr: Number(m[3]) } : {}), ...(m[4] ? { sha: m[4] } : {}) };
}

/** Two head SHAs name the same commit (one may be a prefix of the other). */
const sameHead = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * Whether a comment at `current` may be rewritten to show `stage`. A review-loop stage (loop or
 * person) names its head (`sha`) and says whether that head is still the pull request's newest
 * (`latest`, as the writer's records have it): a late write about an older head never replaces
 * what was said about a newer one, and on one head a resting stage (a person has to act) is not
 * replaced by a late "at work" one.
 */
export function mayReplace(current: StatusMark | null, stage: number, next: { sha?: string; latest?: boolean } = {}): boolean {
  if (!current) return true;
  // The Cloud queue only ever writes over what it wrote itself.
  if (stage < RUNNER_STAGE) return current.stage < RUNNER_STAGE;
  // Merged (or closed) is the last word.
  if (current.stage >= FINAL_STAGE) return stage >= FINAL_STAGE;
  if (stage >= FINAL_STAGE) return true;
  // Assignment and publication happen once, in order: never written over a later stage.
  if (stage < STATUS_STAGE.loop) return current.stage <= stage;
  // The review loop, about one head at a time.
  if (current.stage >= STATUS_STAGE.loop && current.sha && next.sha) {
    if (sameHead(current.sha, next.sha)) return stage >= current.stage;
    return next.latest === true;
  }
  return true;
}

export const DETAILS_OPEN = '<!-- updraft-status-details -->';
export const DETAILS_CLOSE = '<!-- /updraft-status-details -->';

/** The part of a status comment that later stages keep as it is (the assignment table), or null. */
export function statusDetails(body: string): string | null {
  const start = body.indexOf(DETAILS_OPEN);
  const end = body.indexOf(DETAILS_CLOSE);
  if (start < 0 || end < start) return null;
  return body.slice(start + DETAILS_OPEN.length, end).trim() || null;
}

const LINK_LINE = /^\[View (?:this )?(?:work|run|job|workflow) in Updraft\]\(https?:\/\/[^\s)]+\)$/m;

/** The console link line of a status comment, kept by a writer that has no link of its own. */
export function statusLink(body: string): string | null {
  return LINK_LINE.exec(body)?.[0] ?? null;
}

/**
 * A status comment. `title` is the stage in a few words, `text` one or two sentences. `details`
 * (the assignment table) and the link line are kept by later stages.
 */
export function renderStatusComment(o: { title: string; text: string; details?: string | null; link?: string | null; mark: StatusMark }): string {
  return [
    `**Updraft · ${o.title}**`,
    '',
    o.text,
    ...(o.details ? ['', DETAILS_OPEN, o.details, DETAILS_CLOSE] : []),
    ...(o.link ? ['', o.link] : []),
    '',
    statusMarker(o.mark),
  ].join('\n');
}

/** A link line to the console, for renderStatusComment's `link`. */
export function statusLinkLine(url: string, what: 'work' | 'workflow' | 'job' = 'work'): string {
  return `[View ${what === 'work' ? 'this work' : `this ${what}`} in Updraft](${url})`;
}
