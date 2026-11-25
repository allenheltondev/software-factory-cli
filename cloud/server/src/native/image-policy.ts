import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

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

export function createImagePolicies(table: string, latest: string, db = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
  return async (imageVersion: string): Promise<ImagePolicy> => {
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
}
