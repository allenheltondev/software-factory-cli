import {
  AccessDeniedException,
  ConflictException,
  DeleteMicrovmImageVersionCommand,
  ListMicrovmImageVersionsCommand,
  type LambdaMicrovmsClient,
  type MicrovmImageVersionSummary,
} from '@aws-sdk/client-lambda-microvms';
import { describe, expect, it, vi } from 'vitest';
import { pruneImageVersions, versionsToDelete } from './job-image-prune.js';

const ARN = 'arn:aws:lambda:us-east-1:111122223333:microvm-image:updraft-cloud-job';
/** Version `n` was created `n` minutes after the epoch, so a bigger number is newer. */
const version = (n: number, state = 'SUCCESSFUL'): MicrovmImageVersionSummary =>
  ({ imageVersion: String(n), state, createdAt: new Date(n * 60_000) }) as MicrovmImageVersionSummary;
const range = (to: number) => Array.from({ length: to }, (_, i) => version(i + 1));
const denied = () => new AccessDeniedException({ message: 'no', $metadata: {} });

describe('which versions go', () => {
  it('keeps the newest few and deletes the rest, oldest first', () => {
    expect(versionsToDelete(range(8), 5, [])).toEqual(['1', '2', '3']);
  });

  it('never deletes a protected version, however old', () => {
    expect(versionsToDelete(range(8), 5, ['1', undefined, '2']).sort()).toEqual(['3']);
  });

  it('leaves versions still building, and ones already going away, alone', () => {
    const versions = [...range(6), version(0, 'IN_PROGRESS'), version(-1, 'DELETING'), version(-2, 'DELETED')];
    expect(versionsToDelete(versions, 3, [])).toEqual(expect.arrayContaining(['1', '2', '3']));
    expect(versionsToDelete(versions, 3, [])).not.toContain('0');
    expect(versionsToDelete(versions, 3, [])).not.toContain('-1');
  });

  it('deletes failed versions beyond the newest few too', () => {
    expect(versionsToDelete([version(1, 'FAILED'), version(2), version(3)], 2, [])).toEqual(['1']);
  });

  it('deletes nothing when there are no more than the number to keep', () => {
    expect(versionsToDelete(range(5), 5, [])).toEqual([]);
  });
});

function fakeClient(pages: MicrovmImageVersionSummary[][], onDelete: (v: string) => unknown = () => ({})) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ListMicrovmImageVersionsCommand) {
      const index = command.input.nextToken ? Number(command.input.nextToken) : 0;
      return { items: pages[index], nextToken: index + 1 < pages.length ? String(index + 1) : undefined };
    }
    if (command instanceof DeleteMicrovmImageVersionCommand) return onDelete(command.input.imageVersion!);
    throw new Error('unexpected command');
  });
  return { client: { send } as unknown as LambdaMicrovmsClient, send };
}
const deletedVersions = (send: ReturnType<typeof fakeClient>['send']) =>
  send.mock.calls.filter(([c]) => c instanceof DeleteMicrovmImageVersionCommand).map(([c]) => (c as DeleteMicrovmImageVersionCommand).input.imageVersion);

describe('pruning an image', () => {
  it('reads every page of versions and deletes the old ones', async () => {
    const { client, send } = fakeClient([range(4), range(8).slice(4)]);
    const result = await pruneImageVersions(client, ARN, { keep: 5, protect: ['2'], log: () => undefined });
    expect(result).toEqual({ deleted: ['1', '3'], skipped: [] });
    expect(deletedVersions(send)).toEqual(['1', '3']);
  });

  it('keeps a version that is in use and carries on with the rest', async () => {
    const log = vi.fn();
    const { client } = fakeClient([range(8)], (v) => {
      if (v === '1') throw new ConflictException({ message: 'version 1 is in use', $metadata: {} });
      return {};
    });
    const result = await pruneImageVersions(client, ARN, { keep: 5, log });
    expect(result).toEqual({ deleted: ['2', '3'], skipped: ['1'] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('version 1 is in use'));
  });

  it('carries on without pruning when the role may not list versions', async () => {
    const send = vi.fn().mockRejectedValue(denied());
    const log = vi.fn();
    expect(await pruneImageVersions({ send } as unknown as LambdaMicrovmsClient, ARN, { log })).toEqual({ deleted: [], skipped: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('lambda:ListMicrovmImageVersions'));
  });

  it('stops at the first delete the role may not make', async () => {
    const log = vi.fn();
    const { client, send } = fakeClient([range(8)], () => {
      throw denied();
    });
    const result = await pruneImageVersions(client, ARN, { keep: 5, log });
    expect(result.deleted).toEqual([]);
    expect(deletedVersions(send)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('lambda:DeleteMicrovmImageVersion'));
  });

  it('fails on an error it does not know', async () => {
    const send = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(pruneImageVersions({ send } as unknown as LambdaMicrovmsClient, ARN)).rejects.toThrow('boom');
  });
});
