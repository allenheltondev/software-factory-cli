import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
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

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = (records: StreamRecord[]) => enrichFinishedJobs(records, process.env.STACK_NAME!, async (tenantId) => {
  const { Item } = await db.send(new GetCommand({
    TableName: process.env.TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: 'META' },
    ProjectionExpression: 'publishJobFinishedEvents, disabledReason',
    ConsistentRead: true,
  }));
  return Item?.publishJobFinishedEvents === true && Item.disabledReason !== 'uninstalled';
});
