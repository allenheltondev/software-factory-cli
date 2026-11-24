import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
// The CLI's own report (`updraft stats --json`), computed from the tenant's shared state database
// exactly as the CLI computes it: one definition of every number, wherever it is read.
import { METRICS_SCHEMA_VERSION, openDatabaseReadOnly, SCHEMA_VERSION, schemaVersion } from '../../../../src/db/database.js';
import { computeStats, type StatsReport } from '../../../../src/db/stats.js';
import type { Store } from '../store/store.js';

/**
 * A tenant's insights in the console: what the factory did over a window, across its
 * repositories, from the facts every job records in the tenant's shared state database
 * (`tenants/<id>/state/state.db`, which the runners merge into and checkpoint every few seconds
 * while a job runs). How many issues were worked and per repository, what review caught (verdicts
 * and findings), how many rounds a pull request took, and how each model did at coding and at
 * reviewing. The meaning of every number is the CLI's (docs/stats.md).
 *
 * Read only, members only. The report holds ids, counts, durations, repository, agent and model
 * names and fixed codes; never issue, review or findings text, logins or logs.
 */

/** A conditional read of the state object: `unchanged` when its ETag is still `etag`; null when there is none. */
export type StateReader = (
  key: string,
  etag?: string,
) => Promise<{ unchanged: true } | { unchanged?: false; body: Uint8Array; etag: string; lastModified?: string } | null>;

/** The windows the console offers. */
export const STATS_WINDOWS: Record<string, number | null> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  all: null,
};
export const DEFAULT_STATS_WINDOW = '30d';
/** The runner refuses a larger snapshot; so does this. */
const MAX_STATE_BYTES = 256 * 1024 * 1024;
/**
 * Snapshot bytes kept on disk between requests, over every tenant: well inside Lambda's default
 * 512 MB of /tmp, with room for one more download being written.
 */
export const CACHE_BYTES = 192 * 1024 * 1024;

/** A snapshot, with the -wal and -shm files SQLite makes beside it when it opens one. */
async function removeSnapshot(path: string): Promise<void> {
  await Promise.all(['', '-wal', '-shm', '.part'].map((suffix) => rm(`${path}${suffix}`, { force: true })));
}

interface LocalState {
  etag: string;
  path: string;
  bytes: number;
  /** Larger than the budget: deleted once its report is made. */
  transient: boolean;
  lastModified?: string;
}

/** Reports kept per process, newest last. */
const REPORT_CACHE = 64;
/** A report is reused for this long for the same state object (its "now" moves on). */
const REPORT_TTL_MS = 15_000;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface Insights {
  window: string;
  /** False: no job has saved state yet, so every number is zero. */
  hasState: boolean;
  /** When the shared state was last written (S3's Last-Modified). */
  stateUpdatedAt?: string;
  report: StatsReport;
}

export interface StatsServiceDeps {
  github: Pick<GitHubFlows, 'member'>;
  readState?: StateReader;
  store?: Pick<Store, 'listJobStepModels'>;
  /** Where downloaded databases are kept (Lambda's /tmp). */
  cacheDir: string;
  /** The most bytes of snapshots kept between requests, over every tenant. */
  cacheBytes?: number;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export const stateKeyOf = (installationId: number) => `tenants/${installationId}/state/state.db`;

export function createStatsService({ github, readState, store, cacheDir, cacheBytes = CACHE_BYTES, now = Date.now, log = (e) => console.log(JSON.stringify(e)) }: StatsServiceDeps) {
  /**
   * Downloaded snapshots, least recently used first, within `cacheBytes` in all: Lambda's /tmp is
   * shared by every tenant a warm environment serves. A snapshot larger than the budget is read
   * once and deleted as soon as its report is made.
   */
  const files = new Map<number, LocalState>();
  const reports = new Map<string, { at: number; insights: Insights }>();
  let seq = 0;
  let prepared = false;
  const held = () => [...files.values()].reduce((n, f) => n + f.bytes, 0);

  async function forget(installationId: number): Promise<void> {
    const f = files.get(installationId);
    if (!f) return;
    files.delete(installationId);
    await removeSnapshot(f.path);
  }

  async function localState(installationId: number): Promise<LocalState | null> {
    if (!readState) return null;
    if (!prepared) {
      // Whatever an earlier process in this environment left behind is not on the books.
      await rm(cacheDir, { recursive: true, force: true });
      await mkdir(cacheDir, { recursive: true });
      prepared = true;
    }
    const known = files.get(installationId);
    const out = await readState(stateKeyOf(installationId), known?.etag);
    if (!out) {
      await forget(installationId);
      return null;
    }
    if (out.unchanged && known) {
      // Most recently used now.
      files.delete(installationId);
      files.set(installationId, known);
      return known;
    }
    if (out.unchanged) return null;
    if (out.body.byteLength > MAX_STATE_BYTES) throw new FlowError('state_too_large', 502, 'The state database is too large to read here');
    // Room first: the tenant's previous snapshot, then the least recently used others.
    await forget(installationId);
    const bytes = out.body.byteLength;
    const transient = bytes > cacheBytes;
    for (const id of [...files.keys()]) {
      if (held() + (transient ? 0 : bytes) <= cacheBytes) break;
      await forget(id);
    }
    const path = join(cacheDir, `${installationId}-${process.pid}-${++seq}.db`);
    try {
      await writeFile(`${path}.part`, out.body);
      await rename(`${path}.part`, path);
    } catch (err) {
      await rm(`${path}.part`, { force: true });
      throw err;
    }
    const state: LocalState = { etag: out.etag, path, bytes, transient, ...(out.lastModified ? { lastModified: out.lastModified } : {}) };
    if (!transient) files.set(installationId, state);
    return state;
  }

  return {
    async insights(caller: Caller, installationId: number, query: { window?: string; repo?: string } = {}): Promise<Insights> {
      await github.member(caller, installationId);
      const window = query.window && Object.hasOwn(STATS_WINDOWS, query.window) ? query.window : DEFAULT_STATS_WINDOW;
      const repo = query.repo && REPO.test(query.repo) ? query.repo : null;
      const at = now();
      const back = STATS_WINDOWS[window]!;
      const range = { since: back === null ? null : at - back, now: at, label: window, repo };

      const state = await localState(installationId);
      // From here every way out (a cached report, a database that will not open, a newer
      // schema, a report) passes the cleanup: a snapshot over the budget is never left behind.
      let insights: Insights;
      let cacheKey: string;
      try {
        cacheKey = `${installationId}|${state?.etag ?? '-'}|${window}|${repo ?? ''}`;
        const cached = reports.get(cacheKey);
        if (cached && at - cached.at < REPORT_TTL_MS) return cached.insights;
        if (!state) {
          insights = { window, hasState: false, report: computeStats(null, range) };
        } else {
          let db: ReturnType<typeof openDatabaseReadOnly> | undefined;
          let version: number;
          try {
            db = openDatabaseReadOnly(state.path);
            // SQLite opens any file; the first read is where a file that is no database fails.
            version = schemaVersion(db);
          } catch (err) {
            // Not a database we can read: do not keep it for the next request either.
            db?.close();
            await forget(installationId);
            throw err;
          }
          try {
            if (version > SCHEMA_VERSION) {
              log({ installationId, warning: `the state database is at schema v${version}, newer than the API reads (v${SCHEMA_VERSION})` });
              throw new FlowError('state_newer', 503, 'The state was written by a newer Updraft than this console reads yet; try again after the next deploy');
            }
            // A database from before stats were recorded has no facts to report.
            const stepModels = new Map((await store?.listJobStepModels(installationId) ?? [])
              .flatMap((step) => step.runId && step.model ? [[step.runId, { ...step, model: step.model }] as const] : []));
            insights = {
              window,
              hasState: true,
              ...(state.lastModified ? { stateUpdatedAt: state.lastModified } : {}),
              report: computeStats(version < METRICS_SCHEMA_VERSION ? null : db, { ...range, stepModels }),
            };
          } finally {
            db.close();
          }
        }
      } finally {
        if (state?.transient) await removeSnapshot(state.path);
        // Read only, so SQLite's -wal and -shm beside a kept one hold nothing worth keeping.
        else if (state) await Promise.all(['-wal', '-shm'].map((suffix) => rm(`${state.path}${suffix}`, { force: true })));
      }
      reports.delete(cacheKey);
      reports.set(cacheKey, { at, insights });
      while (reports.size > REPORT_CACHE) reports.delete(reports.keys().next().value!);
      return insights;
    },
  };
}

export type StatsService = ReturnType<typeof createStatsService>;
