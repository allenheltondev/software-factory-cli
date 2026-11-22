/**
 * The lifecycle of a job as its runner reports it at the finish: where the review loop left the
 * pull request, and each step the run took (the event's own job, then the reviewer runs and
 * revisions that followed). Shown in the console; checked here (the broker, and again when read
 * back) so it can only ever hold short codes, counts and booleans.
 */

import { CONVERSATION_LINK_PLACEHOLDERS, linkTemplateProblem, TRACE_LINK_PLACEHOLDERS } from '../tenants/otlp-destination.js';

export const STEP_KINDS = ['implement', 'revision', 'review'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The review loop's stages (`updraft status`; docs/run-event.md, `loop.stage`). */
export const LOOP_STAGES = ['awaiting-review', 'reviewing', 'changes-requested', 'revising', 'ready-to-merge', 'merging', 'merged', 'needs-human', 'closed'] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];

export interface JobLoop {
  /** Revision rounds so far, of maxRevisions. */
  rounds: number;
  maxRevisions?: number;
  /** Reviewer verdicts recorded. */
  reviews: number;
  verdict?: 'ready-to-merge' | 'changes-requested';
  stage?: LoopStage;
  merged?: boolean;
}

export interface JobStep {
  kind: StepKind;
  /** The agent profile that ran it, as the tenant's config names it. */
  agent?: string;
  /** How the step ended (succeeded, failed, canceled, superseded, ...). */
  outcome?: string;
  verificationPassed?: boolean;
  /** published, skipped, failed: its pull request, push or review posting. */
  publication?: string;
}

/** The most steps a job keeps: a loop with maxRevisions 10 is 21. */
export const MAX_STEPS = 24;
const CODE = /^[a-z][a-z_-]{0,39}$/;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : undefined);

export function loopOf(raw: unknown): JobLoop | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const l = raw as Record<string, unknown>;
  const rounds = count(l.rounds, 1000);
  const reviews = count(l.reviews, 1000);
  if (rounds === undefined || reviews === undefined) return undefined;
  const out: JobLoop = { rounds, reviews };
  const max = count(l.maxRevisions, 1000);
  if (max !== undefined) out.maxRevisions = max;
  if (l.verdict === 'ready-to-merge' || l.verdict === 'changes-requested') out.verdict = l.verdict;
  if ((LOOP_STAGES as readonly unknown[]).includes(l.stage)) out.stage = l.stage as LoopStage;
  if (typeof l.merged === 'boolean') out.merged = l.merged;
  return out;
}

export function stepsOf(raw: unknown): JobStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: JobStep[] = [];
  for (const s of raw.slice(0, MAX_STEPS)) {
    if (typeof s !== 'object' || s === null) continue;
    const r = s as Record<string, unknown>;
    if (!(STEP_KINDS as readonly unknown[]).includes(r.kind)) continue;
    const step: JobStep = { kind: r.kind as StepKind };
    if (typeof r.agent === 'string' && AGENT.test(r.agent)) step.agent = r.agent;
    if (typeof r.outcome === 'string' && CODE.test(r.outcome)) step.outcome = r.outcome;
    if (typeof r.verificationPassed === 'boolean') step.verificationPassed = r.verificationPassed;
    if (typeof r.publication === 'string' && CODE.test(r.publication)) step.publication = r.publication;
    out.push(step);
  }
  return out.length ? out : undefined;
}

/** What a job's runner sent to the tenant's telemetry: the trace, for a link, and how many spans got there. */
export interface JobTelemetryReport {
  traceId: string;
  spans: number;
  exported: number;
  failed: number;
  /** When the trace started (ISO), for the link's time range. */
  startedAt?: string;
  /** A short code (HTTP 401, timeout, ...). */
  lastError?: string;
  /** The job's root span (invoke_workflow updraft): a custom destination's trace link opens at it. */
  rootSpanId?: string;
  /** The conversation the job's spans were sent in: `owner/repo#issue`, `delivery/<id>`, or a run's own id. */
  conversationId?: string;
  /** Spans worth a link of their own (the runner's telemetry.mjs), in the order they started. */
  marks?: TelemetryMark[];
  /** Read for the console only: there was no destination, nothing was sent, and no link can open it. */
  local?: true;
  /** What the job's runs added up to. */
  totals?: TelemetryTotals;
  /** Where the runner sent the spans: its destination kind and host. */
  sentTo?: { provider: 'honeycomb' | 'cloudwatch' | 'otlp'; host: string };
  /**
   * What links to the trace are built from: the installation's destination when the job finished,
   * kept only when it is where the runner says it sent. Set by the broker, never by the runner.
   */
  destination?: LinkDestination;
}

/** Where a job sends its agent telemetry (the runner's telemetry.mjs): what its descriptor holds. */
export interface JobTelemetryDescriptor {
  /** honeycomb (the default, for runners from before custom destinations), cloudwatch or otlp. */
  provider?: 'honeycomb' | 'cloudwatch' | 'otlp';
  region: 'us' | 'eu';
  /** cloudwatch and otlp: where to send, and the header the key goes in, as saved with the key's version. */
  endpoint?: string;
  header?: string;
  /** The key's secret, which the job's credentials can read (it is under the agent-keys prefix). */
  secret: string;
  serviceName: string;
  captureContent: boolean;
  /** The secret's version that holds the key the settings were checked with; the runner reads exactly it. */
  secretVersion?: string;
}

/**
 * What a job's first `start` handed it for telemetry, kept with the job so every later `start` or
 * `credentials` answer is the same: the descriptor (none: telemetry was off), and the link
 * settings of that destination, what its trace is linked from.
 */
export interface JobTelemetrySnapshot {
  descriptor?: JobTelemetryDescriptor;
  links?: LinkDestination;
}

export function jobTelemetrySnapshotOf(raw: unknown): JobTelemetrySnapshot | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: JobTelemetrySnapshot = {};
  const d = r.descriptor as Record<string, unknown> | undefined;
  if (d && typeof d === 'object' && typeof d.secret === 'string' && typeof d.serviceName === 'string') {
    out.descriptor = {
      ...(typeof d.provider === 'string' && (PROVIDERS as readonly string[]).includes(d.provider) && d.provider !== 'honeycomb' ? { provider: d.provider as 'cloudwatch' | 'otlp' } : {}),
      region: d.region === 'eu' ? 'eu' : 'us',
      ...(typeof d.endpoint === 'string' ? { endpoint: d.endpoint } : {}),
      ...(typeof d.header === 'string' ? { header: d.header } : {}),
      secret: d.secret,
      serviceName: d.serviceName,
      captureContent: d.captureContent === true,
      ...(typeof d.secretVersion === 'string' ? { secretVersion: d.secretVersion } : {}),
    };
  }
  const links = destinationOf(r.links);
  if (links) out.links = links;
  return out;
}

/** A destination's link settings, as they were for one job: never a key, never a secret. */
export interface LinkDestination {
  provider: 'honeycomb' | 'cloudwatch' | 'otlp';
  region: 'us' | 'eu';
  serviceName: string;
  team?: { name: string; slug: string };
  environment?: { name: string; slug: string };
  aws?: { region: string };
  links?: { trace?: string; conversation?: string };
  /** A custom destination's host, for its name in the console. */
  host?: string;
}

const PROVIDERS = ['honeycomb', 'cloudwatch', 'otlp'] as const;
const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const SLUG = /^[A-Za-z0-9_.-]{1,128}$/;

function sentToOf(raw: unknown): JobTelemetryReport['sentTo'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !(PROVIDERS as readonly string[]).includes(r.provider) || typeof r.host !== 'string' || !HOST.test(r.host)) return undefined;
  return { provider: r.provider as LinkDestination['provider'], host: r.host };
}

/** A destination snapshot as stored, with every field checked again. */
export function destinationOf(raw: unknown): LinkDestination | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !(PROVIDERS as readonly string[]).includes(r.provider)) return undefined;
  if (typeof r.serviceName !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.serviceName)) return undefined;
  const named = (v: unknown) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return typeof o.slug === 'string' && SLUG.test(o.slug) ? { name: String(o.name ?? o.slug).slice(0, 128), slug: o.slug } : undefined;
  };
  const out: LinkDestination = { provider: r.provider as LinkDestination['provider'], region: r.region === 'eu' ? 'eu' : 'us', serviceName: r.serviceName };
  const team = named(r.team);
  if (team) out.team = team;
  const environment = named(r.environment);
  if (environment) out.environment = environment;
  const aws = r.aws as Record<string, unknown> | undefined;
  if (aws && typeof aws.region === 'string' && /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/.test(aws.region)) out.aws = { region: aws.region };
  const links = r.links as Record<string, unknown> | undefined;
  if (links && typeof links === 'object') {
    const kept: { trace?: string; conversation?: string } = {};
    if (typeof links.trace === 'string' && !linkTemplateProblem(links.trace, TRACE_LINK_PLACEHOLDERS, 'trace_id')) kept.trace = links.trace;
    if (typeof links.conversation === 'string' && !linkTemplateProblem(links.conversation, CONVERSATION_LINK_PLACEHOLDERS, 'conversation')) kept.conversation = links.conversation;
    if (kept.trace || kept.conversation) out.links = kept;
  }
  if (typeof r.host === 'string' && HOST.test(r.host)) out.host = r.host;
  return out;
}

export interface TelemetryTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** What the agent CLIs reported it cost, when any did. */
  costUsd?: number;
  toolCalls: number;
  toolErrors: number;
  thrashing: boolean;
  durationMs: number;
}

export const TELEMETRY_MARK_KINDS = ['agent', 'test_failed', 'test_green', 'verify_failed', 'step_failed'] as const;
export type TelemetryMarkKind = (typeof TELEMETRY_MARK_KINDS)[number];

/** One span of a job's trace worth opening the trace at. */
export interface TelemetryMark {
  kind: TelemetryMarkKind;
  spanId: string;
  /** The run it is in: implement, review, revision. */
  run?: string;
  /** agent: the profile that ran. */
  agent?: string;
  /** agent: the run did not succeed. */
  failed?: boolean;
  /** agent: it went in circles (repeated commands, one file over and over, errors in a row). */
  thrashing?: boolean;
  /** agent of a review: its verdict (approved, changes-requested, ...). */
  verdict?: string;
  /** step_failed: which step (publish, prepare, runner_restore_state, ...). */
  step?: string;
  /** When the span started, from the job's start, and how long it took. */
  offsetMs?: number;
  durationMs?: number;
  /** false: the destination did not accept its span, so nothing links to it (it is still a moment of the job). */
  sent?: boolean;
}

const MAX_MARKS = 32;
/** `owner/repo#issue`; `delivery/<id>` for a job that ran no agent; a run's own id (its job's) for a run of no issue. */
const CONVERSATION_ID = /^(?:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]{0,9}|delivery\/[A-Za-z0-9_.-]{1,128}|[A-Za-z0-9_.-]{1,128})$/;

function markOf(raw: unknown): TelemetryMark | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.kind !== 'string' || !(TELEMETRY_MARK_KINDS as readonly string[]).includes(m.kind)) return undefined;
  if (typeof m.spanId !== 'string' || !/^[0-9a-f]{16}$/.test(m.spanId)) return undefined;
  const out: TelemetryMark = { kind: m.kind as TelemetryMarkKind, spanId: m.spanId };
  const word = (v: unknown, max: number) => (typeof v === 'string' && new RegExp(`^[a-z][a-z0-9_-]{0,${max - 1}}$`).test(v) ? v : undefined);
  const run = word(m.run, 24);
  if (run) out.run = run;
  if (typeof m.agent === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(m.agent)) out.agent = m.agent;
  if (m.failed === true) out.failed = true;
  if (m.thrashing === true) out.thrashing = true;
  const verdict = word(m.verdict, 32);
  if (verdict) out.verdict = verdict;
  const step = word(m.step, 48);
  if (step) out.step = step;
  const offsetMs = count(m.offsetMs, DAY_MS);
  if (offsetMs !== undefined) out.offsetMs = offsetMs;
  const durationMs = count(m.durationMs, DAY_MS);
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (typeof m.sent === 'boolean') out.sent = m.sent;
  return out;
}

const DAY_MS = 24 * 3600 * 1000;

function totalsOf(raw: unknown): TelemetryTotals | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const n = (v: unknown, max: number) => count(v, max) ?? 0;
  const out: TelemetryTotals = {
    runs: n(t.runs, 1000),
    inputTokens: n(t.inputTokens, 1e12),
    outputTokens: n(t.outputTokens, 1e12),
    toolCalls: n(t.toolCalls, 10_000_000),
    toolErrors: n(t.toolErrors, 10_000_000),
    thrashing: t.thrashing === true,
    durationMs: n(t.durationMs, DAY_MS),
  };
  if (typeof t.costUsd === 'number' && Number.isFinite(t.costUsd) && t.costUsd >= 0 && t.costUsd < 1e6) out.costUsd = Math.round(t.costUsd * 10_000) / 10_000;
  return out;
}

export function telemetryOf(raw: unknown): JobTelemetryReport | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.traceId !== 'string' || !/^[0-9a-f]{32}$/.test(t.traceId)) return undefined;
  const n = (v: unknown) => count(v, 10_000_000) ?? 0;
  const out: JobTelemetryReport = { traceId: t.traceId, spans: n(t.spans), exported: n(t.exported), failed: n(t.failed) };
  if (typeof t.startedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(t.startedAt)) out.startedAt = t.startedAt;
  if (typeof t.lastError === 'string' && /^[A-Za-z0-9 ._-]{1,40}$/.test(t.lastError)) out.lastError = t.lastError;
  if (typeof t.conversationId === 'string' && CONVERSATION_ID.test(t.conversationId)) out.conversationId = t.conversationId;
  if (Array.isArray(t.marks)) {
    const marks = t.marks.slice(0, MAX_MARKS).map(markOf).filter((m): m is TelemetryMark => m !== undefined);
    if (marks.length) out.marks = marks;
  }
  if (t.local === true) out.local = true;
  if (typeof t.rootSpanId === 'string' && /^[0-9a-f]{16}$/.test(t.rootSpanId)) out.rootSpanId = t.rootSpanId;
  const sentTo = sentToOf(t.sentTo);
  if (sentTo) out.sentTo = sentTo;
  const destination = destinationOf(t.destination);
  if (destination) out.destination = destination;
  const totals = totalsOf(t.totals);
  if (totals) out.totals = totals;
  return out;
}
