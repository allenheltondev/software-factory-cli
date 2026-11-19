import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Every AWS client tenant-admin uses, built from one resolved region (--region, else the SDK's
 * own resolution). Nothing in the command constructs a client any other way, so stack discovery,
 * the table, the bucket, the App settings and the key secrets are always in the same region.
 */
export function createAdminClients(region: string | undefined) {
  const opts = region ? { region } : {};
  return {
    cloudFormation: new CloudFormationClient(opts),
    s3: new S3Client(opts),
    secrets: new SecretsManagerClient(opts),
    ssm: new SSMClient(opts),
    dynamo: DynamoDBDocumentClient.from(new DynamoDBClient(opts)),
  };
}

export type AdminClients = ReturnType<typeof createAdminClients>;
