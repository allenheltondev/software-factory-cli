// Human steering through GitHub mentions (#135): the grammar, the command catalog and the
// authorization policy, shared by the local poller (src/poller/controls.ts) and Updraft Cloud's
// webhook (cloud/server/src/control/mentions.ts), so both read a comment the same way and allow
// the same people the same things (docs/controls.md).
//
// A comment is untrusted text. This module only decides whether it is a command, which one, and
// whether its author may give it; nothing in the text widens what a command can do. Free text
// after a command (steering) is passed on only as fenced, untrusted input to an agent.
//
// Pure: no I/O.

/** The commands, in the order help lists them. */
export const CONTROL_COMMANDS = ['pause', 'resume', 'stop', 'cancel', 'review', 'steer', 'escalate', 'help'] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

/**
 * Commands that end work someone may be relying on. They are only ever recognized from their own
 * word (never inferred from natural language) and need more than write access (controlPolicy).
 */
export const DESTRUCTIVE_COMMANDS: ReadonlySet<ControlCommand> = new Set(['stop', 'cancel']);

/** The most steering text a command keeps (the rest is cut, and the reply says so). */
export const MAX_CONTROL_TEXT = 2000;

/** The hidden marker every Updraft control reply carries: comments with it are never commands. */
export const CONTROL_REPLY_MARKER = 'updraft-control';

/** A job id named after `stop`, for an ambiguous target: Cloud's `job_…`, the CLI's ids. */
const JOB_ID = /^(job_[A-Za-z0-9_-]{6,64}|[a-z]+_[A-Za-z0-9]{6,40})$/;

export type ParsedControl =
  /** No line of the comment addresses the handle: not for us. */
  | { kind: 'none' }
  /** A recognized command. `text`: what follows it (may be empty), never trusted. */
  | { kind: 'command'; command: ControlCommand; text: string; truncated: boolean; target: string | null }
  /** The handle was addressed, but not with one recognized command: answer with help. */
  | { kind: 'unrecognized'; reason: 'bare_mention' | 'unknown_command' | 'several_commands'; word: string | null };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The lines of a comment that may carry a command: everything outside fenced or indented code,
 * quotations (`>`), and HTML comments, with inline code removed. Returns [lineIndex, text] pairs
 * against the comment's own lines, so what follows a command can be taken from the original.
 */
export function commandableLines(body: string): Array<[number, string]> {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: Array<[number, string]> = [];
  let fence: string | null = null;
  let inHtmlComment = false;
  let previousBlank = true;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${escapeRegExp(fence)}[\`~]*\\s*$`).test(line)) fence = null;
      previousBlank = false;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = opening[1]!;
      previousBlank = false;
      continue;
    }
    // HTML comments, possibly spanning lines: their text is never a command.
    let visible = '';
    let rest = line;
    while (rest.length) {
      if (inHtmlComment) {
        const end = rest.indexOf('-->');
        if (end < 0) { rest = ''; break; }
        inHtmlComment = false;
        rest = rest.slice(end + 3);
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) { visible += rest; break; }
        visible += rest.slice(0, start);
        inHtmlComment = true;
        rest = rest.slice(start + 4);
      }
    }
    line = visible;
    const blank = line.trim() === '';
    // Indented code (four spaces or a tab after a blank line) and quotations.
    const indented = previousBlank && /^( {4}|\t)/.test(line);
    previousBlank = blank;
    if (blank || indented || /^ {0,3}>/.test(line)) continue;
    // Inline code spans (`...`, ``...``) are code, not prose.
    out.push([i, line.replace(/(`+)[\s\S]*?\1/g, ' ')]);
  }
  return out;
}

/**
 * Read a comment for a command to one of `handles` (logins without the `@`; an App's slug and its
 * `<slug>[bot]` login are both fine). A command is a line that starts with the mention (after at
 * most three spaces), followed by the command word: `@updraft resume`, `@updraft steer: keep the
 * API`. A mention inside a sentence, a quotation or code is not a command, and neither is an
 * edited or quoted copy of one (callers ignore edits). More than one command line is ambiguous.
 */
export function parseControlComment(body: string, handles: readonly string[]): ParsedControl {
  const names = [...new Set(handles.filter((h) => h).flatMap((h) => {
    const bare = h.replace(/^@/, '');
    return bare.endsWith('[bot]') ? [bare, bare.slice(0, -5)] : [bare];
  }))];
  if (!names.length) return { kind: 'none' };
  const mention = new RegExp(`^ {0,3}@(${names.map(escapeRegExp).join('|')})(?=$|[\\s,:;.!?—–-])(.*)$`, 'i');
  const raw = body.replace(/\r\n?/g, '\n').split('\n');
  const hits = commandableLines(body).flatMap(([index, line]) => {
    const m = mention.exec(line);
    return m ? [{ index, after: m[2]! }] : [];
  });
  if (!hits.length) return { kind: 'none' };
  const words = hits.map((h) => /^[\s,:;.!?—–-]*([A-Za-z]+)/.exec(h.after)?.[1]?.toLowerCase() ?? null);
  const recognized = words.filter((w): w is ControlCommand => w !== null && (CONTROL_COMMANDS as readonly string[]).includes(w));
  if (recognized.length > 1) return { kind: 'unrecognized', reason: 'several_commands', word: null };
  const at = words.findIndex((w) => w !== null && (CONTROL_COMMANDS as readonly string[]).includes(w));
  if (at < 0) {
    const word = words.find((w) => w !== null) ?? null;
    return { kind: 'unrecognized', reason: word === null ? 'bare_mention' : 'unknown_command', word };
  }
  const command = recognized[0]!;
  const hit = hits[at]!;
  // What follows the command word: the rest of its line, then the comment's later lines.
  const sameLine = hit.after.replace(/^[\s,:;.!?—–-]*[A-Za-z]+/, '').replace(/^[\s,:;.!?—–-]+/, '');
  const text = [sameLine, ...raw.slice(hit.index + 1)].join('\n').trim();
  const firstToken = /^(\S+)/.exec(sameLine)?.[1] ?? '';
  const target = command === 'stop' && JOB_ID.test(firstToken) ? firstToken : null;
  const truncated = text.length > MAX_CONTROL_TEXT;
  return { kind: 'command', command, text: truncated ? text.slice(0, MAX_CONTROL_TEXT) : text, truncated, target };
}

/** A repository permission as GitHub reports it (`GET /repos/{o}/{r}/collaborators/{u}/permission`). */
export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';
const RANK: Record<RepoPermission, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

/** Normalize GitHub's answer: `role_name` when present (it knows maintain/triage), else `permission`. */
export function repoPermissionOf(answer: { permission?: unknown; role_name?: unknown } | null | undefined): RepoPermission | null {
  for (const v of [answer?.role_name, answer?.permission]) {
    if (typeof v === 'string' && Object.hasOwn(RANK, v.toLowerCase())) return v.toLowerCase() as RepoPermission;
  }
  return null;
}

/** Who wrote a comment, as the event or the API reports them. */
export interface ControlActor {
  login: string | null;
  /** GitHub's user type: `Bot` for Apps and their tokens. */
  type?: string | null;
}

/** Whether a comment is automation: a bot, the worker itself, or one of Updraft's own posts. */
export function isAutomatedComment(actor: ControlActor, body: string, ownLogins: readonly string[]): boolean {
  const login = actor.login?.toLowerCase() ?? '';
  if (!login) return true;
  if (actor.type?.toLowerCase() === 'bot' || login.endsWith('[bot]')) return true;
  if (ownLogins.some((o) => o.toLowerCase() === login || `${o.toLowerCase()}[bot]` === login)) return true;
  // Updraft's own comments (and the worker's, under a person's gh account) carry hidden markers.
  return /<!--\s*updraft[-\w]*/i.test(body);
}

export type ControlDecision =
  | { allowed: true }
  /** `ignore`: say nothing (automation; avoids loops). `refuse`: one polite reply, no state. */
  | { allowed: false; respond: 'ignore' | 'refuse'; reason: 'automated' | 'not_allowed' | 'permission_unknown' | 'needs_write' | 'needs_maintain' };

/**
 * May `actor` give `command`? The same rules on every path (local poller, Cloud webhook):
 *
 * - automation (bots, the worker, Updraft's own replies) is ignored, never answered;
 * - the actor must be one the configuration allows to dispatch work in this repository
 *   (`allowedActors`, compared case-insensitively), and GitHub must say they have at least
 *   write access to it now: a stale allowlist entry alone authorizes nothing;
 * - `stop` and `cancel` (destructive) need maintain or admin, the GitHub counterpart of Cloud's
 *   owner-only stop; so does resuming work such a command (or the console) stopped
 *   (`elevated`: the caller knows what the resume would lift).
 *
 * An unknown permission (the lookup failed) refuses: fail closed.
 */
export function controlPolicy(o: {
  command: ControlCommand;
  actor: ControlActor;
  body: string;
  ownLogins: readonly string[];
  allowedActors: readonly string[];
  permission: RepoPermission | null;
  elevated?: boolean;
}): ControlDecision {
  if (isAutomatedComment(o.actor, o.body, o.ownLogins)) return { allowed: false, respond: 'ignore', reason: 'automated' };
  const login = o.actor.login!.toLowerCase();
  if (!o.allowedActors.some((a) => a.toLowerCase() === login)) return { allowed: false, respond: 'refuse', reason: 'not_allowed' };
  if (o.command === 'help') return { allowed: true };
  if (o.permission === null) return { allowed: false, respond: 'refuse', reason: 'permission_unknown' };
  if (RANK[o.permission] < RANK.write) return { allowed: false, respond: 'refuse', reason: 'needs_write' };
  if ((DESTRUCTIVE_COMMANDS.has(o.command) || o.elevated) && RANK[o.permission] < RANK.maintain) return { allowed: false, respond: 'refuse', reason: 'needs_maintain' };
  return { allowed: true };
}

/** What a refusal says. Never anything about the workflow's state: the asker may not see it. */
export function refusalMessage(reason: Exclude<ControlDecision, { allowed: true }>['reason'], command: ControlCommand): string {
  switch (reason) {
    case 'needs_maintain':
      return `\`${command}\` needs maintain or admin access to this repository, so nothing was done.`;
    case 'needs_write':
      return 'Updraft commands need write access to this repository, so nothing was done.';
    case 'permission_unknown':
      return 'Updraft could not confirm your access to this repository just now, so nothing was done. Try again shortly.';
    default:
      return 'You are not allowed to direct Updraft in this repository, so nothing was done. A maintainer can add you to the allowed actors.';
  }
}

/** The help text, with the handle people actually mention. */
export function controlHelp(handle: string, opts: { unsupported?: readonly ControlCommand[] } = {}): string {
  const h = `@${handle.replace(/^@/, '').replace(/\[bot\]$/, '')}`;
  const lines: Array<[ControlCommand, string]> = [
    ['pause', 'stop starting new steps for this issue and its pull request; a step already running finishes'],
    ['resume', 'lift a pause and continue from where it stopped (the latest head of an existing pull request)'],
    ['stop', 'stop the active job now and pause (maintain or admin; name the job when there are several)'],
    ['cancel', 'stop active and queued work and pause; commits and pull requests are kept (maintain or admin)'],
    ['review', 'review the pull request’s current head again'],
    ['steer', 'give instructions for the next coding run on the pull request, e.g. `steer keep the existing API`'],
    ['escalate', 'ask for a more capable tier on the next run, within the configured policy'],
    ['help', 'show this list'],
  ];
  const unsupported = new Set(opts.unsupported ?? []);
  return [
    `Commands start a line with \`${h}\`, outside quotes and code:`,
    '',
    ...lines.map(([c, what]) => `- \`${h} ${c}\`: ${what}${unsupported.has(c) ? ' (not available here yet)' : ''}`),
    '',
    'Only people allowed to dispatch work here, with write access, can use them.',
  ].join('\n');
}

/** A control reply: the hidden marker (so it is never read as a command, and found again), then the message. */
export function controlReply(commentId: number | string, message: string): string {
  return `<!-- ${CONTROL_REPLY_MARKER}:${commentId} -->\n${message}`;
}

