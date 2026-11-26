import { loopOf, routingOf, stepsOf, telemetryOf } from './lifecycle.js';
import { benchmarkIdentityOf } from '../benchmarks/config.js';

/**
 * Job Finished events (v1, cloud/README.md): what a finished tenant job summary is sent as.
 * Pure, and free of AWS clients, so the stream publisher (job-finished-lambda.ts) and the admin
 * replay (admin/job-finished-replay.ts) build the very same detail from the same summary.
 */

export const EVENT_SOURCE = 'updraft.cloud';
export const EVENT_DETAIL_TYPE = 'Job Finished';
/** PutEvents takes at most 10 entries per call. */
export const PUT_BATCH = 10;

/** A summary item in DynamoDB's own format: a stream image, or an item a low-level Query returns. */
export interface Attribute {
  S?: string;
  N?: string;
  BOOL?: boolean;
  M?: Record<string, Attribute>;
  L?: Attribute[];
}
export type SummaryItem = Record<string, Attribute>;

export function value(raw: Attribute | undefined): unknown {
  if (!raw) return undefined;
  if (raw.S !== undefined) return raw.S;
  if (raw.N !== undefined) return Number(raw.N);
  if (raw.BOOL !== undefined) return raw.BOOL;
  if (raw.M) return Object.fromEntries(Object.entries(raw.M).map(([key, field]) => [key, value(field)]));
  if (raw.L) return raw.L.map(value);
}

/**
 * The event detail of one finished `TENANT#<id>` / `JOB#<createdAt>#<jobId>` summary, or
 * undefined for anything else (not finished, not a job summary, or missing what the event needs).
 * Who has opted in is not decided here.
 */
export function jobFinishedDetail(row: SummaryItem, stack: string) {
  if (row.status?.S !== 'finished') return undefined;
  const tenant = /^TENANT#([1-9]\d*)$/.exec(row.pk?.S ?? '')?.[1];
  const jobId = row.jobId?.S;
  const createdAt = row.createdAt?.S;
  const finishedAt = row.finishedAt?.S;
  const repository = row.repository?.S;
  if (!tenant || !jobId || !createdAt || !finishedAt || !repository || row.sk?.S !== `JOB#${createdAt}#${jobId}`) return undefined;
  const detail = row.detail?.M ?? {};
  const steps = stepsOf(value(detail.steps));
  const telemetry = telemetryOf(value(detail.telemetry))?.totals;
  return {
    schemaVersion: 1,
    stack,
    tenantId: tenant,
    jobId,
    kind: steps?.[0]?.kind ?? (row.issue?.N && !row.pullRequest?.N ? 'implement' : undefined),
    repository,
    issue: value(row.issue),
    pullRequest: value(row.pullRequest),
    createdAt,
    finishedAt,
    durationSeconds: value(row.durationSeconds),
    configVersion: value(row.configVersion),
    status: 'finished',
    outcome: row.outcome?.S,
    updraftOutcome: detail.updraftOutcome?.S,
    verificationPassed: detail.verificationPassed?.BOOL,
    pr: detail.prUrl?.S || detail.prNumber?.N ? { url: detail.prUrl?.S, number: value(detail.prNumber) } : undefined,
    loop: loopOf(value(detail.loop)),
    steps,
    routing: routingOf(value(detail.routing)),
    telemetry: telemetry && {
      inputTokens: telemetry.inputTokens, outputTokens: telemetry.outputTokens, costUsd: telemetry.costUsd,
      toolCalls: telemetry.toolCalls, toolErrors: telemetry.toolErrors, durationMs: telemetry.durationMs,
    },
    retriedAs: row.retriedAs?.S ?? null,
    benchmark: benchmarkIdentityOf(value(row.benchmark)) ?? null,
  };
}

export type JobFinishedDetail = NonNullable<ReturnType<typeof jobFinishedDetail>>;
