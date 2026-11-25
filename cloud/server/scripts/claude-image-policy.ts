// Operator policy: --state approved|draining|revoked --image VERSION --reason TEXT
// CI: --seed IMAGE (repeatable) records verified images only if no policy exists.
import { parseArgs } from 'node:util';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createImagePolicies, imageDecision, imagePolicyKey, WORKER_PROTOCOL, type ImagePolicy } from '../src/native/image-policy.js';
import { createAdminClients } from './admin-clients.js';

/** Never let a routine rollout undo a drain, revocation, or compatibility decision. */
export async function writePolicy(db: DynamoDBDocumentClient, table: string, image: string,
  state: 'approved' | 'draining' | 'revoked', reason: string, seed = false, protocol = WORKER_PROTOCOL) {
  if (!/^[\w.-]{1,64}$/.test(image) || !reason.trim() || reason.length > 200 || !/^[\w.-]{1,64}$/.test(protocol)) throw new Error('Invalid image policy');
  const Key = imagePolicyKey(image);
  const { Item } = await db.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }));
  if (seed && Item) return Item as ImagePolicy;
  const revision = Number(Item?.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid policy revision');
  const policy: ImagePolicy = { imageVersion: image, state, reason, protocol, revision: revision + 1 };
  try {
    await db.send(new PutCommand({ TableName: table, Item: { ...Key, ...policy },
      ConditionExpression: Item ? 'revision = :revision' : 'attribute_not_exists(pk)',
      ...(Item ? { ExpressionAttributeValues: { ':revision': revision } } : {}) }));
  } catch (error) {
    if (seed && error instanceof ConditionalCheckFailedException) return;
    throw error;
  }
  return policy;
}

async function main() {
  const { values } = parseArgs({ options: { stack: { type: 'string', default: 'updraft-cloud' }, region: { type: 'string' },
    'require-approved': { type: 'string' }, image: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' }, protocol: { type: 'string' }, seed: { type: 'string', multiple: true } } });
  const clients = createAdminClients(values.region);
  const stack = (await clients.cloudFormation.send(new DescribeStacksCommand({ StackName: values.stack }))).Stacks?.[0];
  const table = stack?.Outputs?.find((o) => o.OutputKey === 'TableName')?.OutputValue;
  if (!table) throw new Error('Stack table not found');
  for (const image of values.seed ?? []) {
    if (image && image !== 'None') await writePolicy(clients.dynamo, table, image, 'approved', 'Verified protocol-1 rollout', true);
  }
  if (values['require-approved']) {
    const policy = await createImagePolicies(table, '', clients.dynamo)(values['require-approved']);
    if (imageDecision(policy) !== 'approved') throw new Error(`Selected image is blocked: ${policy.reason}`);
  }
  if (values.image) {
    if (!['approved', 'draining', 'revoked'].includes(values.state ?? '') || !values.reason) throw new Error('--image requires --state and --reason');
    console.log(JSON.stringify(await writePolicy(clients.dynamo, table, values.image, values.state as 'approved' | 'draining' | 'revoked', values.reason, false, values.protocol)));
  } else if (!values.seed?.length && !values['require-approved']) throw new Error('Specify --seed or --image');
}
if (process.argv[1]?.endsWith('claude-image-policy.ts')) main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
