import type { Job } from '../store/store.js';

export type WorkflowSubject = Pick<Job, 'installationId' | 'repositoryId' | 'issue' | 'pullRequest' | 'workflowIssue' | 'resumeOf'>;

export const workflowSubjects = (job: Pick<Job, 'issue' | 'pullRequest' | 'workflowIssue'>, prNumber?: number) =>
  [...new Set([job.issue, job.pullRequest, job.workflowIssue, prNumber].filter((n): n is number => n !== undefined))];

/** Included in the SAME transaction as launch, start or native assignment. Reads made
 * for routing/help are hints; these conditions serialize admission against a stop. */
export function workflowAdmissionChecks(table: string, job: WorkflowSubject) {
  return workflowSubjects(job).map((subject) => ({ ConditionCheck: {
    TableName: table,
    Key: { pk: `TENANT#${job.installationId}`, sk: `PAUSE#${job.repositoryId}#${subject}` },
    ConditionExpression: job.resumeOf ? 'attribute_not_exists(pk) OR jobId = :parent' : 'attribute_not_exists(pk)',
    ...(job.resumeOf ? { ExpressionAttributeValues: { ':parent': job.resumeOf } } : {}),
  } }));
}

export class WorkflowPausedError extends Error {
  constructor() { super('Workflow was paused before admission'); this.name = 'WorkflowPausedError'; }
}
