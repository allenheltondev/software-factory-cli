import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { distAssets, planPrune, releaseKey, releaseTime, run } from './spa-release.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 30);
const RETENTION = 7 * DAY;
const at = (daysAgo) => NOW - daysAgo * DAY;
const rel = (daysAgo, assets) => ({ key: releaseKey(at(daysAgo)), time: at(daysAgo), assets });
const obj = (key, uploadedDaysAgo) => ({ key, lastModified: at(uploadedDaysAgo) });

test('release keys round-trip their time', () => {
  const t = Date.UTC(2026, 10, 19, 15, 35, 0, 123);
  assert.equal(releaseKey(t), '_releases/20261119T153500123Z.json');
  assert.equal(releaseTime(releaseKey(t)), t);
  assert.ok(Number.isNaN(releaseTime('_releases/notes.txt')));
});

test('an old upload that was live until today survives today\'s deploy', () => {
  // Release A went out 30 days ago and stayed live until release B, today.
  const plan = planPrune({
    assets: [obj('assets/a.js', 30), obj('assets/b.js', 0)],
    releases: [rel(30, ['assets/a.js']), rel(0, ['assets/b.js'])],
    currentAssets: ['assets/b.js'],
    now: NOW,
    retentionMs: RETENTION,
  });
  assert.deepEqual(plan, { deleteAssets: [], deleteReleases: [] });
});

test('a release replaced more than the window ago is pruned with its record', () => {
  // A (40 days ago) was replaced by B (20 days ago), B by C (today). B was live when the window
  // began, so B stays; A goes.
  const a = rel(40, ['assets/a.js', 'assets/shared.css']);
  const plan = planPrune({
    assets: [obj('assets/a.js', 40), obj('assets/shared.css', 40), obj('assets/b.js', 20), obj('assets/c.js', 0)],
    releases: [a, rel(20, ['assets/b.js', 'assets/shared.css']), rel(0, ['assets/c.js', 'assets/shared.css'])],
    currentAssets: ['assets/c.js', 'assets/shared.css'],
    now: NOW,
    retentionMs: RETENTION,
  });
  assert.deepEqual(plan, { deleteAssets: ['assets/a.js'], deleteReleases: [a.key] });
});

test('the live release is never pruned, even if no record mentions it', () => {
  const plan = planPrune({
    assets: [obj('assets/live.js', 90)],
    releases: [],
    currentAssets: ['assets/live.js'],
    now: NOW,
    retentionMs: RETENTION,
  });
  assert.deepEqual(plan.deleteAssets, []);
});

test('assets from before the bookkeeping existed age out by upload time', () => {
  const plan = planPrune({
    assets: [obj('assets/legacy-old.js', 10), obj('assets/legacy-recent.js', 2), obj('assets/now.js', 0)],
    releases: [rel(0, ['assets/now.js'])],
    currentAssets: ['assets/now.js'],
    now: NOW,
    retentionMs: RETENTION,
  });
  assert.deepEqual(plan.deleteAssets, ['assets/legacy-old.js']);
});

test('distAssets lists the build\'s files as bucket keys', () => {
  const dist = mkdtempSync(join(tmpdir(), 'spa-dist-'));
  mkdirSync(join(dist, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '');
  writeFileSync(join(dist, 'assets', 'index-abc.js'), '');
  writeFileSync(join(dist, 'assets', 'fonts', 'f-1.woff2'), '');
  assert.deepEqual(distAssets(dist), ['assets/fonts/f-1.woff2', 'assets/index-abc.js']);
});

/** An in-memory bucket behind the handful of AWS CLI calls spa-release makes. */
function fakeAws(clock) {
  const objects = new Map();
  const keyOf = (uri) => uri.replace(/^s3:\/\/[^/]+\//, '');
  const aws = (args, input) => {
    const [svc, cmd] = args;
    if (svc === 's3' && cmd === 'cp' && args[2] === '-') {
      objects.set(keyOf(args[3]), { body: input, lastModified: clock.now });
      return '';
    }
    if (svc === 's3' && cmd === 'cp' && args[3] === '-') return objects.get(keyOf(args[2])).body;
    if (svc === 's3' && cmd === 'rm') {
      objects.delete(keyOf(args[2]));
      return '';
    }
    if (svc === 's3api' && cmd === 'list-objects-v2') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const rows = [...objects].filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, lastModified: new Date(o.lastModified).toISOString().replace('.000Z', '+00:00') }));
      return `${JSON.stringify(rows.length ? rows : null)}\n`; // the CLI prints null for no Contents
    }
    throw new Error(`unexpected aws ${args.join(' ')}`);
  };
  const upload = (key) => objects.set(key, { body: '', lastModified: clock.now });
  return { aws, objects, upload };
}

function build(files) {
  const dist = mkdtempSync(join(tmpdir(), 'spa-dist-'));
  mkdirSync(join(dist, 'assets'));
  for (const f of files) writeFileSync(join(dist, 'assets', f), '');
  return dist;
}

test('run: records each release and prunes only releases replaced long ago', () => {
  const clock = { now: at(30) };
  const s3 = fakeAws(clock);
  const deploy = (files) => {
    for (const f of files) s3.upload(`assets/${f}`);
    return run({ args: ['--bucket', 'b', '--dist', build(files), '--retention-days', '7'], aws: s3.aws, now: clock.now, log: () => {} });
  };

  // Before any bookkeeping: a legacy file from an older deploy.
  s3.upload('assets/legacy.js');
  deploy(['a.js']); // release A, 30 days ago
  clock.now = at(0);
  deploy(['b.js']); // release B replaces A today: A's files must survive
  assert.ok(s3.objects.has('assets/a.js'));
  assert.ok(!s3.objects.has('assets/legacy.js'), 'unrecorded and uploaded 30 days ago');

  clock.now = NOW + 10 * DAY;
  const plan = deploy(['c.js']); // C replaces B; A was replaced 10 days ago, past the window
  assert.deepEqual(plan.deleteAssets, ['assets/a.js']);
  assert.ok(s3.objects.has('assets/b.js'), 'B was live when the window began');
  assert.ok(s3.objects.has('assets/c.js'));
  assert.equal([...s3.objects.keys()].filter((k) => k.startsWith('_releases/')).length, 2);
});

test('run: refuses a retention under a day and missing arguments', () => {
  assert.throws(() => run({ args: ['--bucket', 'b'], aws: () => '' }), /--dist are required/);
  assert.throws(() => run({ args: ['--bucket', 'b', '--dist', 'x', '--retention-days', '0'], aws: () => '' }), /at least 1/);
});
