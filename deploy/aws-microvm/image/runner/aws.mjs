// The AWS calls the job makes, with the microVM's execution role. Credentials come from the
// SDK's default provider chain (the documentation describes them as provided through IMDSv2);
// the region comes from the run-hook payload, so nothing depends on AWS_REGION being set.
import { DeleteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * @param {string} region
 * @param {{ credentials?: () => Promise<object> }} [options] for a version 2 job (Updraft Cloud):
 *   S3 and Secrets Manager use the job broker's tenant-scoped credentials instead of the
 *   execution role, which cannot reach any tenant's data itself. TerminateMicrovm keeps the role.
 */
export function createAwsDeps(region, options = {}) {
  const scoped = options.credentials ? { credentials: options.credentials } : {};
  const s3 = new S3Client({ region, ...scoped });
  const secrets = new SecretsManagerClient({ region, ...scoped });
  const microvms = new LambdaMicrovmsClient({ region });
  const dynamodb = new DynamoDBClient({ region });

  return {
    async s3Get(bucket, key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async s3List(bucket, prefix) {
      const objects = [];
      let token;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const item of page.Contents ?? []) objects.push({ key: item.Key, size: item.Size ?? 0 });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async s3Put(bucket, key, body, contentType = 'application/json') {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    /**
     * The object and its ETag, or undefined when there is none. Existence is asked with a
     * list request, not inferred from GetObject's error: without s3:ListBucket a GetObject
     * of a missing key is answered 403, not 404, and whether a ListBucket permission limited
     * to a prefix counts for that is not documented. The role may list this prefix.
     */
    async s3GetIfExists(bucket, key, { signal } = {}) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 10 }), { abortSignal: signal });
      if (!(page.Contents ?? []).some((item) => item.Key === key)) return undefined;
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
        return { body: Buffer.from(await response.Body.transformToByteArray()), etag: response.ETag };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return undefined;
        throw error;
      }
    },
    /** The object's ETag, or undefined when there is none. A list request, for the same reason as above. */
    async s3Etag(bucket, key) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 10 }));
      return (page.Contents ?? []).find((item) => item.Key === key)?.ETag;
    },
    /**
     * A conditional write (PutObject's IfMatch / IfNoneMatch, the If-Match and If-None-Match
     * headers). S3 answers 412 Precondition Failed when the object is no longer the one named
     * by the ETag (or exists, for If-None-Match: *), 409 ConditionalRequestConflict when
     * another write to the key was in flight, and 404 to an If-Match when the object is gone.
     * All three mean "somebody else was first": `written: false`, and the caller starts over.
     */
    async s3PutIf(bucket, key, body, { ifMatch, ifNoneMatch }, { signal } = {}) {
      if ((ifMatch === undefined) === (ifNoneMatch === undefined)) throw new Error('exactly one of ifMatch and ifNoneMatch is required');
      try {
        const response = await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'application/vnd.sqlite3',
            ...(ifMatch === undefined ? { IfNoneMatch: ifNoneMatch } : { IfMatch: ifMatch }),
          }),
          { abortSignal: signal },
        );
        return { written: true, etag: response.ETag };
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status === 412 || status === 409 || (status === 404 && ifMatch !== undefined) || error?.name === 'PreconditionFailed' || error?.name === 'ConditionalRequestConflict') {
          return { written: false, status };
        }
        throw error;
      }
    },
    /** The secret's current value, or exactly `versionId` when one is given. */
    async getSecret(secretId, versionId) {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId, ...(versionId ? { VersionId: versionId } : {}) }));
      return response.SecretString ?? '';
    },
    async releaseDelivery(table, deliveryId) {
      await dynamodb.send(new DeleteItemCommand({ TableName: table, Key: { deliveryId: { S: deliveryId } } }));
    },
    async terminate(microvmId) {
      await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    },
  };
}
