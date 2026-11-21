import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
// The CLI's own report (`updraft stats --json`), computed from the tenant's shared state database
// exactly as the CLI computes it: one definition of every number, wherever it is read.
import { METRICS_SCHEMA_VERSION, openDatabaseReadOnly, SCHEMA_VERSION, schemaVersion } from '../../../../src/db/database.js';
import { computeStats, type StatsReport } from '../../../../src/db/stats.js';

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
  /** Where downloaded databases are kept (Lambda's /tmp). */
  cacheDir: string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export const stateKeyOf = (installationId: number) => `tenants/${installationId}/state/state.db`;

export function createStatsService({ github, readState, cacheDir, now = Date.now, log = (e) => console.log(JSON.stringify(e)) }: StatsServiceDeps) {
  /** The newest download of each tenant's state, as a file in cacheDir. */
  const files = new Map<number, { etag: string; path: string; lastModified?: string }>();
  const reports = new Map<string, { at: number; insights: Insights }>();
  let seq = 0;

  async function localState(installationId: number): Promise<{ etag: string; path: string; lastModified?: string } | null> {
    if (!readState) return null;
    const held = files.get(installationId);
    const out = await readState(stateKeyOf(installationId), held?.etag);
    if (!out) {
      if (held) {
        files.delete(installationId);
        await rm(held.path, { force: true });
      }
      return null;
    }
    if (out.unchanged) return held ?? null;
    if (out.body.byteLength > MAX_STATE_BYTES) throw new FlowError('state_too_large', 502, 'The state database is too large to read here');
    await mkdir(cacheDir, { recursive: true });
    // A file per download: a report being computed from the previous one keeps its file.
    const path = join(cacheDir, `${installationId}-${process.pid}-${++seq}.db`);
    await writeFile(`${path}.part`, out.body);
    await rename(`${path}.part`, path);
    files.set(installationId, { etag: out.etag, path, ...(out.lastModified ? { lastModified: out.lastModified } : {}) });
    if (held) await rm(held.path, { force: true });
    return files.get(installationId)!;
  }

  return {
    async insights(caller: Caller, installationId: number, query: { window?: string; repo?: string } = {}): Promise<Insights> {
      await github.member(caller, installationId);
      const window = query.window && query.window in STATS_WINDOWS ? query.window : DEFAULT_STATS_WINDOW;
      const repo = query.repo && REPO.test(query.repo) ? query.repo : null;
      const at = now();
      const back = STATS_WINDOWS[window]!;
      const range = { since: back === null ? null : at - back, now: at, label: window, repo };

      const state = await localState(installationId);
      const cacheKey = `${installationId}|${state?.etag ?? '-'}|${window}|${repo ?? ''}`;
      const cached = reports.get(cacheKey);
      if (cached && at - cached.at < REPORT_TTL_MS) return cached.insights;

      let insights: Insights;
      if (!state) {
        insights = { window, hasState: false, report: computeStats(null, range) };
      } else {
        const db = openDatabaseReadOnly(state.path);
        try {
          const version = schemaVersion(db);
          if (version > SCHEMA_VERSION) {
            log({ installationId, warning: `the state database is at schema v${version}, newer than the API reads (v${SCHEMA_VERSION})` });
            throw new FlowError('state_newer', 503, 'The state was written by a newer Updraft than this console reads yet; try again after the next deploy');
          }
          // A database from before stats were recorded has no facts to report.
          insights = {
            window,
            hasState: true,
            ...(state.lastModified ? { stateUpdatedAt: state.lastModified } : {}),
            report: computeStats(version < METRICS_SCHEMA_VERSION ? null : db, range),
          };
        } finally {
          db.close();
        }
      }
      reports.delete(cacheKey);
      reports.set(cacheKey, { at, insights });
      while (reports.size > REPORT_CACHE) reports.delete(reports.keys().next().value!);
      return insights;
    },
  };
}

export type StatsService = ReturnType<typeof createStatsService>;
