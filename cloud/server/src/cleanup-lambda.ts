import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException } from '@aws-sdk/client-lambda-microvms';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createReconciler } from './jobs/reconcile.js';
import { createDynamoStore } from './store/dynamo.js';
import { runCleanup } from './tenants/cleanup.js';
import { createDynamoRoutineRuleStore, routineSecretName } from './routines/rules.js';
import { expireResults } from './tenants/results-retention.js';

/**
 * CleanupFunction (dist/cleanup.mjs), on two schedules:
 *   daily                 the uninstall cleanup: deletes the S3 prefix and key secrets of every
 *                         uninstalled tenant past its deadline (tenants/cleanup.ts), then every
 *                         tenant's results past ResultRetentionDays (tenants/results-retention.ts)
 *   `{ task: 'reconcile' }`  every five minutes: frees the quota capacity of jobs whose microVM
 *                         Lambda shows terminated (jobs/reconcile.ts)
 */

const bucket = process.env.TENANT_BUCKET ?? '';
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const store = createDynamoStore(process.env.TABLE_NAME ?? '');
const microvms = new LambdaMicrovmsClient({});

const reconcile = createReconciler({
  store,
  async microvmState(microvmId) {
    try {
      return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))).state ?? 'UNKNOWN';
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  },
});

export async function handler(event?: { task?: unknown }): Promise<unknown> {
  if (event?.task === 'reconcile') {
    const report = await reconcile();
    // The next run (five minutes on) retries what failed; fail this one so alarms see it.
    if (report.failed > 0) throw new Error(`reconciliation failed for ${report.failed} job(s)`);
    return report;
  }
  // Both run whatever the other did; a failure of either fails the run (retried, alarmed) at the end.
  let report: Awaited<ReturnType<typeof cleanupTenants>> | undefined;
  let cleanupError: unknown;
  try {
    report = await cleanupTenants();
  } catch (err) {
    cleanupError = err;
  }
  // Results past ResultRetentionDays, for every tenant (tenants/results-retention.ts).
  const results = await expireResults({
    store,
    async listDated(prefix) {
      const out: { key: string; lastModified: number }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
        for (const o of page.Contents ?? []) if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified.getTime() });
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },
    async deleteObjects(keys) {
      const out = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      if (out.Errors?.length) throw new Error(`could not delete ${out.Errors.length} object(s)`);
    },
    retentionDays: Math.max(1, Number(process.env.RESULT_RETENTION_DAYS ?? 30) || 30),
  });
  if (cleanupError) throw cleanupError;
  if (results.failed.length) throw new Error(`expiring results failed for ${results.failed.join(', ')}`);
  return { ...report, results: results.deleted };
}

async function cleanupTenants(): Promise<{ cleaned: number[]; failed: number }> {
  const report = await runCleanup({
    store,
    async listObjects(prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
        for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return keys;
    },
    async deleteObjects(keys) {
      const out = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      if (out.Errors?.length) throw new Error(`could not delete ${out.Errors.length} object(s), e.g. ${out.Errors[0]?.Key}: ${out.Errors[0]?.Code}`);
    },
    routineSecretNames: async (id) => (await createDynamoRoutineRuleStore(process.env.TABLE_NAME ?? '').list(id)).map((r) => routineSecretName(id, r.id)),
    secrets: {
      async remove(name) {
        try {
          await secrets.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
        } catch (err) {
          if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
        }
      },
    },
  });
  // A failed tenant is retried by the next run; fail this one so the schedule's retry and alarms see it.
  if (report.failed.length) throw new Error(`cleanup failed for ${report.failed.map((f) => f.installationId).join(', ')}`);
  return { cleaned: report.cleaned, failed: 0 };
}
