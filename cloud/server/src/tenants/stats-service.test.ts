import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHistory } from '../../../../test/factory-history.js';
import { openDatabase } from '../../../../src/db/database.js';
import { createApp } from '../app.js';
import type { Caller } from '../caller.js';
import { FlowError } from '../flows/github.js';
import { createS3StateReader } from './s3-logs.js';
import { createStatsService, stateKeyOf, type StateReader } from './stats-service.js';

const caller = { sub: 'u1' } as Caller;
const END = Date.parse('2026-11-18T12:00:00.000Z');

/** A real shared state database, as the runners leave it: the CLI's fixture history, in one file. */
function stateBytes(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'updraft-state-'));
  const file = join(dir, 'state.db');
  const db = openDatabase(file);
  buildHistory(END, db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return readFileSync(file);
}

function setup(objects: Record<string, { body: Uint8Array; etag: string }> = {}) {
  const reads: Array<{ key: string; etag?: string }> = [];
  const readState: StateReader = async (key, etag) => {
    reads.push({ key, ...(etag ? { etag } : {}) });
    const o = objects[key];
    if (!o) return null;
    if (etag === o.etag) return { unchanged: true };
    return { body: o.body, etag: o.etag, lastModified: '2026-11-18T11:59:00.000Z' };
  };
  const member = async (_c: Caller, id: number) => {
    if (id !== 55) throw new FlowError('not_authorized', 403, 'You are not a member of that installation');
    return {} as never;
  };
  const clock = { now: END };
  const service = createStatsService({ github: { member }, readState, cacheDir: mkdtempSync(join(tmpdir(), 'updraft-cache-')), now: () => clock.now, log: () => {} });
  return { service, reads, clock, objects };
}

describe('insights', () => {
  it('reports the CLI stats of the shared state: per repository, review findings, rounds', async () => {
    const { service } = setup({ [stateKeyOf(55)]: { body: stateBytes(), etag: '"v1"' } });
    const out = await service.insights(caller, 55, {});
    expect(out).toMatchObject({ window: '30d', hasState: true, stateUpdatedAt: '2026-11-18T11:59:00.000Z' });
    const s = out.report.overall;
    expect(s.work.finished.succeeded).toMatchObject({ implement: 3, revision: 2, review: 4 });
    expect(s.review.findings).toMatchObject({ total: 3 });
    expect(s.review.changesRequestedRounds.reviewer).toBe(2);
    expect(s.backAndForth.prs).toBe(3);
    expect(out.report.byRepo.map((r) => r.repo)).toEqual(expect.arrayContaining(['octo/widgets']));
    expect(s.daily.length).toBeGreaterThan(0);
  });

  it('narrows to a window and a repository, and ignores values it does not offer', async () => {
    const { service } = setup({ [stateKeyOf(55)]: { body: stateBytes(), etag: '"v1"' } });
    const day = await service.insights(caller, 55, { window: '24h', repo: 'octo/widgets' });
    expect(day.window).toBe('24h');
    expect(day.report.repo).toBe('octo/widgets');
    const odd = await service.insights(caller, 55, { window: '5y', repo: '../../etc' });
    expect(odd.window).toBe('30d');
    expect(odd.report.repo).toBeNull();
  });

  it('reads the object again only when it changed, and answers zeros before any job saved state', async () => {
    const { service, reads, clock, objects } = setup();
    const none = await service.insights(caller, 55, {});
    expect(none).toMatchObject({ hasState: false, report: { database: false, overall: { outcomes: { prsOpened: 0 } } } });

    objects[stateKeyOf(55)] = { body: stateBytes(), etag: '"v1"' };
    clock.now += 60_000;
    await service.insights(caller, 55, {});
    clock.now += 60_000;
    await service.insights(caller, 55, {});
    expect(reads.map((r) => r.etag)).toEqual([undefined, undefined, '"v1"']);
  });

  it('is for members only', async () => {
    const { service, reads } = setup();
    await expect(service.insights(caller, 56, {})).rejects.toMatchObject({ status: 403 });
    expect(reads).toEqual([]);
  });

  it('is served at /api/v1/installations/:id/insights, never cached', async () => {
    const { service } = setup({ [stateKeyOf(55)]: { body: stateBytes(), etag: '"v1"' } });
    const app = createApp({ resolveCaller: () => caller, stats: service });
    const res = await app.request('/api/v1/installations/55/insights?window=7d');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { window: string }).window).toBe('7d');
    expect((await app.request('/api/v1/installations/x/insights')).status).toBe(404);
  });
});

describe('the snapshot cache', () => {
  function many(bytes: Uint8Array, cacheBytes: number) {
    const etags = new Map<number, string>();
    const readState: StateReader = async (key, etag) => {
      const id = Number(/tenants\/(\d+)\//.exec(key)![1]);
      const current = etags.get(id) ?? '"v1"';
      if (etag === current) return { unchanged: true };
      return { body: bytes, etag: current };
    };
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'updraft-cache-')), 'state');
    const service = createStatsService({ github: { member: async () => ({}) as never }, readState, cacheDir, cacheBytes, now: () => END, log: () => {} });
    return { service, cacheDir, etags, files: () => readdirSync(cacheDir) };
  }

  it('keeps snapshots of many tenants within the byte budget, least recently used out first', async () => {
    const bytes = stateBytes();
    const { service, files } = many(bytes, bytes.byteLength * 3);
    for (let id = 1; id <= 70; id++) await service.insights(caller, id, {});
    expect(files()).toHaveLength(3);
    expect(files().map((f) => f.split('-')[0]).sort()).toEqual(['68', '69', '70']);
  });

  it('removes a tenant\'s previous snapshot before writing its new one', async () => {
    const bytes = stateBytes();
    const { service, files, etags } = many(bytes, bytes.byteLength);
    await service.insights(caller, 1, {});
    etags.set(1, '"v2"');
    await service.insights(caller, 1, { window: '7d' });
    expect(files()).toHaveLength(1);
  });

  it('reads a snapshot larger than the budget once, and does not keep it', async () => {
    const bytes = stateBytes();
    const { service, files } = many(bytes, bytes.byteLength - 1);
    const out = await service.insights(caller, 1, {});
    expect(out.hasState).toBe(true);
    expect(out.report.overall.work.finished.total.total).toBeGreaterThan(0);
    expect(files()).toEqual([]);
  });

  it('leaves no snapshot over the budget behind when its report comes from the cache', async () => {
    const bytes = stateBytes();
    const { service, files } = many(bytes, bytes.byteLength - 1);
    for (let i = 0; i < 4; i++) {
      expect((await service.insights(caller, 1, {})).hasState).toBe(true);
      expect(files()).toEqual([]);
    }
  });

  it('removes a snapshot that cannot be opened, over the budget or within it', async () => {
    const junk = new Uint8Array(8192).fill(7);
    for (const cacheBytes of [100, 1 << 20]) {
      const { service, files } = many(junk, cacheBytes);
      await expect(service.insights(caller, 1, {})).rejects.toThrow();
      expect(files()).toEqual([]);
    }
  });

  it('takes an inherited name for a window as an unsupported one', async () => {
    const bytes = stateBytes();
    const { service } = many(bytes, bytes.byteLength * 2);
    for (const window of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect((await service.insights(caller, 1, { window })).window).toBe('30d');
    }
  });
});

describe('the S3 state reader', () => {
  it('asks with If-None-Match, and reads 304 as unchanged and 403 as no state', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let answer: unknown = { Body: { transformToByteArray: async () => new Uint8Array([1, 2]) }, ETag: '"e"', LastModified: new Date(END) };
    const s3 = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        sent.push(cmd.input);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const read = createS3StateReader(s3 as never, 'b');
    expect(await read('k')).toEqual({ body: new Uint8Array([1, 2]), etag: '"e"', lastModified: '2026-11-18T12:00:00.000Z' });
    answer = Object.assign(new Error('nm'), { name: 'NotModified', $metadata: { httpStatusCode: 304 } });
    expect(await read('k', '"e"')).toEqual({ unchanged: true });
    expect(sent[1]).toMatchObject({ Bucket: 'b', Key: 'k', IfNoneMatch: '"e"' });
    answer = Object.assign(new Error('denied'), { name: 'AccessDenied' });
    expect(await read('k')).toBeNull();
  });
});
