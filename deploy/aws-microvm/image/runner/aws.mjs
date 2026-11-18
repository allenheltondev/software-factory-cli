// The AWS calls the job makes, with the microVM's execution role. Credentials come from the
// SDK's default provider chain (the documentation describes them as provided through IMDSv2);
// the region comes from the run-hook payload, so nothing depends on AWS_REGION being set.
import { DeleteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export function createAwsDeps(region) {
  const s3 = new S3Client({ region });
  const secrets = new SecretsManagerClient({ region });
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
    async getSecret(secretId) {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
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
