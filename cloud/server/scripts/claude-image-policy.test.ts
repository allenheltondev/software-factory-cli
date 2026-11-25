import { describe, expect, it, vi } from 'vitest';
import { GetCommand, type PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { writePolicy } from './claude-image-policy.js';

describe('rolling image deployment approvals', () => {
  it('never reapproves revoked or draining images during routine deployment or rollback', async () => {
    for (const state of ['draining', 'revoked']) {
      const send = vi.fn().mockResolvedValue({ Item: { imageVersion: '18.0', revision: 4, state, protocol: 'tenant-browser-1', reason: 'Security update' } });
      await writePolicy({ send } as unknown as DynamoDBDocumentClient, 'table', '18.0', 'approved', 'Rollout', true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toBeInstanceOf(GetCommand);
    }
  });
  it('records a verified image without overwriting a concurrent policy update', async () => {
    const send = vi.fn().mockResolvedValue({});
    await writePolicy({ send } as unknown as DynamoDBDocumentClient, 'table', '21.0', 'approved', 'Verified rollout', true);
    const put = send.mock.calls[1]![0] as PutCommand;
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(put.input.Item).toMatchObject({ imageVersion: '21.0', revision: 1, state: 'approved', protocol: 'tenant-browser-1' });
  });
  it('requires an explicit revision-checked operator decision to revoke or approve', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: { revision: 4 } }).mockResolvedValueOnce({});
    await writePolicy({ send } as unknown as DynamoDBDocumentClient, 'table', '18.0', 'revoked', 'Critical fix');
    const put = send.mock.calls[1]![0] as PutCommand;
    expect(put.input.ConditionExpression).toBe('revision = :revision');
    expect(put.input.Item).toMatchObject({ revision: 5, state: 'revoked', reason: 'Critical fix' });
    expect(put.input.ExpressionAttributeValues).toEqual({ ':revision': 4 });
  });
});
