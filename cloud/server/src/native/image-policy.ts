import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/** Exact image approvals, never a version ordering. This control plane implements protocol 1. */
export const WORKER_PROTOCOL = 'tenant-browser-1';
export interface ImagePolicy {
  imageVersion: string;
  revision: number;
  state: 'approved' | 'draining' | 'revoked' | 'unknown';
  protocol: string;
  reason: string;
}
export const imagePolicyKey = (imageVersion: string) => ({ pk: `NATIVE_IMAGE#${imageVersion}`, sk: 'POLICY' });
export type ImageDecision = 'approved' | 'image-draining' | 'image-revoked' | 'image-unapproved' | 'protocol-incompatible';
export function imageDecision(policy: ImagePolicy, workerVersion = WORKER_PROTOCOL): ImageDecision {
  if (policy.state === 'revoked') return 'image-revoked';
  if (policy.state === 'unknown') return 'image-unapproved';
  if (policy.protocol !== WORKER_PROTOCOL || workerVersion !== policy.protocol) return 'protocol-incompatible';
  return policy.state === 'draining' ? 'image-draining' : 'approved';
}

/** Reads one image's policy; `durable` writes down a bootstrap approval (see below). */
export type ImagePolicyReader = ((imageVersion: string) => Promise<ImagePolicy>) & {
  durable?(policy: ImagePolicy): Promise<ImagePolicy>;
};
export const BOOTSTRAP_REASON = 'Launched as the latest verified image';

export function createImagePolicies(table: string, latest: string, db = DynamoDBDocumentClient.from(new DynamoDBClient({}))): ImagePolicyReader {
  const read = async (imageVersion: string): Promise<ImagePolicy> => {
    const { Item } = await db.send(new GetCommand({ TableName: table, Key: imagePolicyKey(imageVersion), ConsistentRead: true }));
    if (!Item) return { imageVersion, revision: 0, state: imageVersion === latest ? 'approved' : 'unknown',
      protocol: WORKER_PROTOCOL, reason: imageVersion === latest ? 'Latest verified image' : 'Image has no compatibility approval' };
    if (Item.imageVersion !== imageVersion || !Number.isSafeInteger(Item.revision) || Number(Item.revision) < 1 ||
      !['approved', 'draining', 'revoked'].includes(String(Item.state)) || typeof Item.protocol !== 'string' || typeof Item.reason !== 'string') {
      return { imageVersion, revision: 0, state: 'unknown', protocol: '', reason: 'Invalid image compatibility policy' };
    }
    return { imageVersion, revision: Number(Item.revision), state: Item.state as 'approved' | 'draining' | 'revoked',
      protocol: Item.protocol, reason: Item.reason };
  };
  /**
   * A session launched on the bootstrap approval (the deployed latest image, which has no record
   * yet) keeps that approval through later rollouts only if it is written down: once `latest`
   * moves on, an unrecorded image reads as unapproved (#176). So a launch records exactly the
   * decision it already made and nothing more: only the current latest, only when no record
   * exists. A concurrent drain or revocation always wins, and is what this then returns. Any
   * other policy is returned unchanged.
   */
  const durable = async (policy: ImagePolicy): Promise<ImagePolicy> => {
    if (!latest || policy.revision !== 0 || policy.state !== 'approved' || policy.imageVersion !== latest) return policy;
    const recorded: ImagePolicy = { imageVersion: latest, revision: 1, state: 'approved', protocol: WORKER_PROTOCOL, reason: BOOTSTRAP_REASON };
    try {
      await db.send(new PutCommand({ TableName: table, Item: { ...imagePolicyKey(latest), ...recorded }, ConditionExpression: 'attribute_not_exists(pk)' }));
      return recorded;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      return read(latest);
    }
  };
  return Object.assign(read, { durable });
}
