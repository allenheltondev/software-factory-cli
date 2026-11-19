import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createDynamoStore } from './store/dynamo.js';
import { runCleanup } from './tenants/cleanup.js';

/**
 * The daily uninstall cleanup (dist/cleanup.mjs, CleanupFunction on a schedule): deletes the S3
 * prefix and key secrets of every uninstalled tenant past its deadline (tenants/cleanup.ts).
 */

const bucket = process.env.TENANT_BUCKET ?? '';
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const store = createDynamoStore(process.env.TABLE_NAME ?? '');

export async function handler(): Promise<{ cleaned: number[]; failed: number }> {
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
