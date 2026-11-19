#!/usr/bin/env node
// Release bookkeeping for the SPA bucket, run by `make deploy-frontend` after the new index.html is
// live:
//
//   node scripts/spa-release.mjs --bucket <AppBucket> --dist app/dist [--retention-days 7] [--region us-east-1]
//
// 1. Records this release: _releases/<UTC time>.json lists the hashed files under assets/ that the
//    new index.html references (everything in app/dist/assets).
// 2. Prunes old assets. An index.html that is still in flight or cached somewhere keeps asking for
//    the files of the release it came from, so a release's files are kept for the retention window
//    counted from the moment the release was REPLACED, not from when its files were uploaded:
//      - every release recorded inside the window is kept,
//      - so is the newest release recorded before the window (it was live when the window began),
//      - an asset no recorded release mentions (from before this bookkeeping existed) is kept
//        until its own upload is older than the window,
//      - everything else under assets/ is deleted, and so are the manifests of dropped releases.
//
// Uses the AWS CLI (already on the deploy runner, with the deploy role's credentials).

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ASSET_PREFIX = 'assets/';
export const RELEASE_PREFIX = '_releases/';
const DAY_MS = 24 * 60 * 60 * 1000;

/** `_releases/20261119T153500123Z.json` for a time; sortable, no characters S3 or URLs mind. */
export function releaseKey(now) {
  return `${RELEASE_PREFIX}${new Date(now).toISOString().replace(/[-:.]/g, '')}.json`;
}

/** The release time encoded in a manifest key, or NaN. */
export function releaseTime(key) {
  const m = /^_releases\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.json$/.exec(key);
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

/**
 * What to delete.
 *   assets:        [{ key, lastModified (ms) }] under assets/
 *   releases:      [{ key, time (ms), assets: string[] }], the current release included
 *   currentAssets: the live release's files (never deleted, whatever the manifests say)
 */
export function planPrune({ assets, releases, currentAssets, now, retentionMs }) {
  const cutoff = now - retentionMs;
  const byNewest = releases.filter((r) => Number.isFinite(r.time)).sort((a, b) => b.time - a.time);
  const inWindow = byNewest.filter((r) => r.time >= cutoff);
  const liveAtCutoff = byNewest.find((r) => r.time < cutoff);
  const kept = liveAtCutoff ? [...inWindow, liveAtCutoff] : inWindow;
  const keptKeys = new Set(kept.map((r) => r.key));

  const keep = new Set(currentAssets);
  for (const r of kept) for (const a of r.assets) keep.add(a);
  const mentioned = new Set();
  for (const r of byNewest) for (const a of r.assets) mentioned.add(a);

  const deleteAssets = assets
    .filter(({ key, lastModified }) => !keep.has(key) && (mentioned.has(key) || lastModified < cutoff))
    .map(({ key }) => key)
    .sort();
  const deleteReleases = releases
    .filter((r) => !keptKeys.has(r.key) && Number.isFinite(r.time))
    .map((r) => r.key)
    .sort();
  return { deleteAssets, deleteReleases };
}

/** Every file under <dist>/assets, as bucket keys. */
export function distAssets(dist) {
  const root = join(dist, 'assets');
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${ASSET_PREFIX}${relative(root, full).split(sep).join('/')}`);
    }
  };
  walk(root);
  return out.sort();
}

/** Runs the AWS CLI and returns its stdout. Tests pass their own. */
export function awsCli(args, input) {
  return execFileSync('aws', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
}

function listObjects(aws, bucket, prefix, regionArgs) {
  const out = aws([
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, ...regionArgs,
    '--query', 'Contents[].{key: Key, lastModified: LastModified}', '--output', 'json',
  ]);
  const rows = JSON.parse(out || 'null') ?? [];
  return rows.map((r) => ({ key: r.key, lastModified: Date.parse(r.lastModified) }));
}

export function run({ args = process.argv.slice(2), aws = awsCli, now = Date.now(), log = console.log } = {}) {
  const { values } = parseArgs({
    args,
    options: {
      bucket: { type: 'string' },
      dist: { type: 'string' },
      'retention-days': { type: 'string', default: '7' },
      region: { type: 'string' },
    },
  });
  if (!values.bucket || !values.dist) throw new Error('spa-release: --bucket and --dist are required');
  const days = Number(values['retention-days']);
  if (!Number.isFinite(days) || days < 1) throw new Error('spa-release: --retention-days must be at least 1');
  const regionArgs = values.region ? ['--region', values.region] : [];
  const bucket = values.bucket;

  // 1. Record this release.
  const currentAssets = distAssets(values.dist);
  const key = releaseKey(now);
  aws(['s3', 'cp', '-', `s3://${bucket}/${key}`, ...regionArgs, '--content-type', 'application/json', '--cache-control', 'no-store'],
    JSON.stringify({ releasedAt: new Date(now).toISOString(), assets: currentAssets }));
  log(`spa-release: recorded ${key} (${currentAssets.length} assets)`);

  // 2. Prune.
  const releases = listObjects(aws, bucket, RELEASE_PREFIX, regionArgs).map(({ key: k }) => {
    let assets = [];
    try {
      assets = JSON.parse(aws(['s3', 'cp', `s3://${bucket}/${k}`, '-', ...regionArgs])).assets ?? [];
    } catch {
      // An unreadable manifest protects nothing; its assets fall back to the upload-age rule.
    }
    return { key: k, time: releaseTime(k), assets };
  });
  const assets = listObjects(aws, bucket, ASSET_PREFIX, regionArgs);
  const plan = planPrune({ assets, releases, currentAssets, now, retentionMs: days * DAY_MS });

  for (const k of [...plan.deleteAssets, ...plan.deleteReleases]) {
    aws(['s3', 'rm', `s3://${bucket}/${k}`, ...regionArgs]);
  }
  log(
    `spa-release: kept ${assets.length - plan.deleteAssets.length} of ${assets.length} assets; ` +
      `pruned ${plan.deleteAssets.length} assets and ${plan.deleteReleases.length} release records older than ${days} days`,
  );
  return plan;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof Error && err.message.startsWith('spa-release:') ? 2 : 1);
  }
}
