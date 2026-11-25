import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createDynamoWorkflowStore } from './store.js';
import type { Workflow, WorkflowEvent } from './workflow.js';

const W: Workflow = { workflowId: '99-i7', installationId: 55, repository: 'acme/web', repositoryId: 99, issue: 7, generation: 1, status: 'active', stage: 'implementing', createdAt: 'x', updatedAt: 'x', version: 1 };
const E: WorkflowEvent = { id: 'job_1:finished', at: 'x', kind: 'job_finished', generation: 1 };

/** A client whose transaction is cancelled with these reasons, one per item. */
const cancelling = (codes: (string | undefined)[]) =>
  ({
    send: async () => {
      throw new TransactionCanceledException({ message: 'cancelled', $metadata: {}, CancellationReasons: codes.map((Code) => (Code ? { Code } : { Code: 'None' })) });
    },
  }) as never;

describe('dynamo workflow store', () => {
  it('says replay when the event is recorded already, and writes nothing', async () => {
    const store = createDynamoWorkflowStore('t', cancelling([undefined, 'ConditionalCheckFailed']));
    expect(await store.saveWorkflow({ ...W, version: 2 }, W, E)).toBe('replay');
  });

  it('says conflict when only the record moved on', async () => {
    const store = createDynamoWorkflowStore('t', cancelling(['ConditionalCheckFailed', undefined]));
    expect(await store.saveWorkflow({ ...W, version: 2 }, W, E)).toBe('conflict');
  });

  it('says saved when the transaction goes through', async () => {
    const sent: unknown[] = [];
    const store = createDynamoWorkflowStore('t', { send: async (c: unknown) => void sent.push(c) } as never);
    expect(await store.saveWorkflow({ ...W, version: 2 }, W, E)).toBe('saved');
    expect(sent).toHaveLength(1);
  });
});
