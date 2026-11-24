import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { loopOf, routingOf, stepsOf, telemetryOf } from './jobs/lifecycle.js';

interface Attribute {
  S?: string;
  N?: string;
  BOOL?: boolean;
  M?: Record<string, Attribute>;
  L?: Attribute[];
}
interface StreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, Attribute>; OldImage?: Record<string, Attribute> };
}

function value(raw: Attribute | undefined): unknown {
  if (!raw) return undefined;
  if (raw.S !== undefined) return raw.S;
  if (raw.N !== undefined) return Number(raw.N);
  if (raw.BOOL !== undefined) return raw.BOOL;
  if (raw.M) return Object.fromEntries(Object.entries(raw.M).map(([key, field]) => [key, value(field)]));
  if (raw.L) return raw.L.map(value);
}

export async function enrichFinishedJobs(records: StreamRecord[], stack: string, optedIn: (tenantId: string) => Promise<boolean>) {
  const results = [];
  for (const record of records) {
    const row = record.dynamodb?.NewImage;
    const previousStatus = record.dynamodb?.OldImage?.status?.S;
    if (record.eventName !== 'MODIFY' || !row || row.status?.S !== 'finished' ||
        !previousStatus || previousStatus === 'finished') continue;
    const tenant = /^TENANT#([1-9]\d*)$/.exec(row.pk?.S ?? '')?.[1];
    const jobId = row.jobId?.S;
    const createdAt = row.createdAt?.S;
    const finishedAt = row.finishedAt?.S;
    const repository = row.repository?.S;
    if (!tenant || !jobId || !createdAt || !finishedAt || !repository ||
        row.sk?.S !== `JOB#${createdAt}#${jobId}` || !(await optedIn(tenant))) continue;
    const detail = row.detail?.M ?? {};
    const steps = stepsOf(value(detail.steps));
    const telemetry = telemetryOf(value(detail.telemetry))?.totals;
    results.push({
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
      benchmark: null,
    });
  }
  return results;
}

export const EVENT_SOURCE = 'updraft.cloud';
export const EVENT_DETAIL_TYPE = 'Job Finished';
/** PutEvents takes at most 10 entries per call. */
const PUT_BATCH = 10;

type Detail = Awaited<ReturnType<typeof enrichFinishedJobs>>[number];
type Put = (entries: { Source: string; DetailType: string; Detail: string }[]) => Promise<{ FailedEntryCount?: number }>;

/**
 * Put each detail on the account's default bus. Any failed entry throws, so the stream trigger
 * retries the batch (and, after its retries, sends it to the dead-letter queue): consumers
 * deduplicate on stack, tenantId and jobId, so an event delivered twice is harmless, and one
 * never delivered is not.
 */
export async function publishFinishedJobs(details: Detail[], put: Put): Promise<number> {
  for (let i = 0; i < details.length; i += PUT_BATCH) {
    const entries = details.slice(i, i + PUT_BATCH).map((detail) => ({
      Source: EVENT_SOURCE,
      DetailType: EVENT_DETAIL_TYPE,
      Detail: JSON.stringify(detail),
    }));
    const { FailedEntryCount } = await put(entries);
    if (FailedEntryCount) throw new Error(`PutEvents rejected ${FailedEntryCount} of ${entries.length} Job Finished event(s)`);
  }
  return details.length;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const events = new EventBridgeClient({});

const optedIn = async (tenantId: string) => {
  const { Item } = await db.send(new GetCommand({
    TableName: process.env.TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: 'META' },
    ProjectionExpression: 'publishJobFinishedEvents, disabledReason',
    ConsistentRead: true,
  }));
  return Item?.publishJobFinishedEvents === true && Item.disabledReason !== 'uninstalled';
};

/** The table stream's trigger (template.yaml JobFinishedPublisherFunction): no EventBusName is the default bus. */
export const handler = async (event: { Records?: StreamRecord[] }) => {
  const details = await enrichFinishedJobs(event.Records ?? [], process.env.STACK_NAME!, optedIn);
  const published = await publishFinishedJobs(details, (Entries) => events.send(new PutEventsCommand({ Entries })));
  return { published };
};
