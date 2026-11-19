#!/usr/bin/env node
// Release bookkeeping for the SPA bucket, in three steps that `make deploy-frontend` runs around
// the switch of index.html:
//
//   key=$(node scripts/spa-release.mjs record   --bucket B --dist app/dist [--region R])
//   ...upload index.html...
//   node scripts/spa-release.mjs activate --bucket B --key "$key" [--region R]
//   node scripts/spa-release.mjs prune    --bucket B --dist app/dist [--retention-days 7] [--region R]
//
// record    writes _releases/<UTC time>.json listing the hashed files under assets/ that this
//           build's index.html references, with "activated": false. It runs BEFORE index.html is
//           switched, so every release that ever goes live has a record, even if the deploy stops
//           right after the switch. Its failure stops the deploy before anything is live.
// activate  marks the record "activated": true once index.html is live. A record that was never
//           confirmed (the deploy stopped between the two) is treated as possibly live.
// prune     deletes old files from assets/. An index.html that is still in flight or cached keeps
//           asking for the files of the release it came from, so a release's files are kept for
//           the retention window counted from when the release was REPLACED, not uploaded:
//             - every release recorded inside the window is kept;
//             - so is the release that was live when the window began: the newest confirmed one
//               recorded before the window, and every unconfirmed record newer than it (any of
//               them may have been the live one);
//             - a file no record mentions (from before this bookkeeping, or a failed upload) is
//               kept unless its retirement is established: there is a confirmed release from
//               before the window, so every release live during the window is recorded, and the
//               file's own upload is older than the window too;
//             - if any record cannot be read or parsed, nothing is deleted at all.
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

/** The release time encoded in a record key, or NaN. */
export function releaseTime(key) {
  const m = /^_releases\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.json$/.exec(key);
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
}

/**
 * A record's body, or null when it is not one. Records written before `activated` existed were
 * written after their index.html went live, so a missing flag means confirmed.
 */
export function parseRecord(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  if (!Array.isArray(body.assets) || !body.assets.every((a) => typeof a === 'string')) return null;
  if (body.activated !== undefined && typeof body.activated !== 'boolean') return null;
  return { assets: body.assets, activated: body.activated !== false };
}

/**
 * What to delete.
 *   assets:        [{ key, lastModified (ms) }] under assets/
 *   releases:      [{ key, time (ms), assets: string[], activated: boolean }]
 *   currentAssets: the live release's files (never deleted, whatever the records say)
 */
export function planPrune({ assets, releases, currentAssets, now, retentionMs }) {
  const cutoff = now - retentionMs;
  const byNewest = releases.filter((r) => Number.isFinite(r.time)).sort((a, b) => b.time - a.time);

  const kept = byNewest.filter((r) => r.time >= cutoff);
  let confirmedBeforeWindow = false;
  for (const r of byNewest.filter((x) => x.time < cutoff)) {
    kept.push(r);
    if (r.activated) {
      confirmedBeforeWindow = true;
      break;
    }
  }
  const keptKeys = new Set(kept.map((r) => r.key));

  const keep = new Set(currentAssets);
  for (const r of kept) for (const a of r.assets) keep.add(a);
  const mentioned = new Set();
  for (const r of byNewest) for (const a of r.assets) mentioned.add(a);

  const deleteAssets = assets
    .filter(({ key, lastModified }) => {
      if (keep.has(key)) return false;
      if (mentioned.has(key)) return true; // only by records of releases retired before the window
      return confirmedBeforeWindow && lastModified < cutoff;
    })
    .map(({ key }) => key)
    .sort();
  const deleteReleases = byNewest
    .filter((r) => !keptKeys.has(r.key))
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

function putRecord(aws, bucket, key, body, regionArgs) {
  aws(['s3', 'cp', '-', `s3://${bucket}/${key}`, ...regionArgs, '--content-type', 'application/json', '--cache-control', 'no-store'],
    JSON.stringify(body));
}

const COMMANDS = ['record', 'activate', 'prune'];

/**
 * One command. Returns the record key for `record`, the plan for `prune` (null when it refused to
 * delete anything), nothing for `activate`. Throws on bad arguments or a failed AWS call.
 */
export function run({ args = process.argv.slice(2), aws = awsCli, now = Date.now(), log = (m) => console.error(m) } = {}) {
  const [command, ...rest] = args;
  if (!COMMANDS.includes(command)) throw new Error(`spa-release: the command must be one of ${COMMANDS.join(', ')}`);
  const { values } = parseArgs({
    args: rest,
    options: {
      bucket: { type: 'string' },
      dist: { type: 'string' },
      key: { type: 'string' },
      'retention-days': { type: 'string', default: '7' },
      region: { type: 'string' },
    },
  });
  if (!values.bucket) throw new Error('spa-release: --bucket is required');
  const bucket = values.bucket;
  const regionArgs = values.region ? ['--region', values.region] : [];

  if (command === 'record') {
    if (!values.dist) throw new Error('spa-release: --dist is required');
    const assets = distAssets(values.dist);
    const key = releaseKey(now);
    putRecord(aws, bucket, key, { releasedAt: new Date(now).toISOString(), activated: false, assets }, regionArgs);
    log(`spa-release: recorded ${key} (${assets.length} assets)`);
    return key;
  }

  if (command === 'activate') {
    if (!values.key || !Number.isFinite(releaseTime(values.key))) throw new Error('spa-release: --key must be a record key');
    const record = parseRecord(aws(['s3', 'cp', `s3://${bucket}/${values.key}`, '-', ...regionArgs]));
    if (!record) throw new Error(`spa-release: ${values.key} is not a release record`);
    putRecord(aws, bucket, values.key,
      { releasedAt: new Date(releaseTime(values.key)).toISOString(), activated: true, assets: record.assets }, regionArgs);
    log(`spa-release: ${values.key} is live`);
    return undefined;
  }

  // prune
  if (!values.dist) throw new Error('spa-release: --dist is required');
  const days = Number(values['retention-days']);
  if (!Number.isFinite(days) || days < 1) throw new Error('spa-release: --retention-days must be at least 1');
  const currentAssets = distAssets(values.dist);

  const releases = [];
  for (const { key } of listObjects(aws, bucket, RELEASE_PREFIX, regionArgs)) {
    const time = releaseTime(key);
    if (!Number.isFinite(time)) continue; // not ours
    let record;
    try {
      record = parseRecord(aws(['s3', 'cp', `s3://${bucket}/${key}`, '-', ...regionArgs]));
    } catch {
      record = null;
    }
    if (!record) {
      // Without every record the set of files a live or cached index.html may need is unknown.
      log(`spa-release: could not read ${key}; deleting nothing this time`);
      return null;
    }
    releases.push({ key, time, ...record });
  }
  const assets = listObjects(aws, bucket, ASSET_PREFIX, regionArgs);
  const plan = planPrune({ assets, releases, currentAssets, now, retentionMs: days * DAY_MS });

  for (const k of [...plan.deleteAssets, ...plan.deleteReleases]) {
    aws(['s3', 'rm', `s3://${bucket}/${k}`, ...regionArgs]);
  }
  log(
    `spa-release: kept ${assets.length - plan.deleteAssets.length} of ${assets.length} assets; ` +
      `pruned ${plan.deleteAssets.length} assets and ${plan.deleteReleases.length} release records (retention ${days} days)`,
  );
  return plan;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const out = run();
    // `record` prints its key on stdout for the Makefile; everything else logs to stderr.
    if (typeof out === 'string') console.log(out);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof Error && err.message.startsWith('spa-release:') ? 2 : 1);
  }
}
