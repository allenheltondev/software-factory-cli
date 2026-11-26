import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { EVENT_DETAIL_TYPE, EVENT_SOURCE, PUT_BATCH, jobFinishedDetail, type Attribute } from './jobs/job-finished-event.js';

export { EVENT_DETAIL_TYPE, EVENT_SOURCE };

interface StreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, Attribute>; OldImage?: Record<string, Attribute> };
}

export async function enrichFinishedJobs(records: StreamRecord[], stack: string, optedIn: (tenantId: string) => Promise<boolean>) {
  const results = [];
  for (const record of records) {
    const row = record.dynamodb?.NewImage;
    const previousStatus = record.dynamodb?.OldImage?.status?.S;
    if (record.eventName !== 'MODIFY' || !row || row.status?.S !== 'finished' ||
        !previousStatus || previousStatus === 'finished') continue;
    // The summary's mapping is shared with the admin replay (admin/job-finished-replay.ts).
    const detail = jobFinishedDetail(row, stack);
    if (!detail || !(await optedIn(detail.tenantId))) continue;
    results.push(detail);
  }
  return results;
}

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
