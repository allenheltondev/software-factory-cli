// Lambda entry point: wires the AWS SDK to the logic in lib/launch.mjs. Nothing else lives
// here, so everything that can be tested without AWS is tested (see ../test).
//
// The SDK clients come from this function's own node_modules (`sam build` installs
// package.json), not from the Lambda runtime: the runtime's bundled SDK is not guaranteed to
// include a client as new as @aws-sdk/client-lambda-microvms.
import { DeleteItemCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { handleWebhook, loadConfig } from './lib/launch.mjs';

// GitHub gives a webhook 10 seconds. One retry at most, so a failure is reported in time.
const clientOptions = { maxAttempts: 2 };
const microvms = new LambdaMicrovmsClient(clientOptions);
const s3 = new S3Client(clientOptions);
const secrets = new SecretsManagerClient(clientOptions);
const dynamodb = new DynamoDBClient(clientOptions);

// The webhook secret is cached per execution environment, briefly, so that a rotated secret
// is picked up without a deployment.
const SECRET_TTL_MS = 5 * 60 * 1000;
let cachedSecret;
let cachedAt = 0;

async function getWebhookSecret(secretArn) {
  if (cachedSecret !== undefined && Date.now() - cachedAt < SECRET_TTL_MS) return cachedSecret;
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  cachedSecret = response.SecretString ?? '';
  cachedAt = Date.now();
  return cachedSecret;
}

function log(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === 'error') console.error(line);
  else console.log(line);
}

export async function handler(event) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    log({ level: 'error', message: `launcher misconfigured: ${error.message}` });
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'launcher misconfigured' }),
    };
  }
  return handleWebhook(event, {
    config,
    log,
    getWebhookSecret: () => getWebhookSecret(config.webhookSecretArn),
    putObject: async (bucket, key, body) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
    },
    runMicrovm: (input) => microvms.send(new RunMicrovmCommand(input)),
    // DynamoDB deletes expired items lazily, so "expired" is part of the condition. The key
    // is a delivery id or a pull request's coalescing lease ("pr#<owner/repo>#<number>").
    claimDelivery: async (deliveryId, nowSeconds, expiresSeconds) => {
      try {
        await dynamodb.send(
          new PutItemCommand({
            TableName: config.dedupeTable,
            Item: { deliveryId: { S: deliveryId }, expiresAt: { N: String(expiresSeconds) }, claimedAt: { N: String(nowSeconds) } },
            ConditionExpression: 'attribute_not_exists(deliveryId) OR expiresAt < :now',
            ExpressionAttributeValues: { ':now': { N: String(nowSeconds) } },
          }),
        );
        return true;
      } catch (error) {
        if (error?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    releaseDelivery: async (deliveryId) => {
      await dynamodb.send(new DeleteItemCommand({ TableName: config.dedupeTable, Key: { deliveryId: { S: deliveryId } } }));
    },
  });
}
