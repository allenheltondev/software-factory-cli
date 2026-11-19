import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { distAssets, parseRecord, planPrune, releaseKey, releaseTime, run } from './spa-release.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 30);
const RETENTION = 7 * DAY;
const at = (daysAgo) => NOW - daysAgo * DAY;
const rel = (daysAgo, assets, activated = true) => ({ key: releaseKey(at(daysAgo)), time: at(daysAgo), assets, activated });
const obj = (key, uploadedDaysAgo) => ({ key, lastModified: at(uploadedDaysAgo) });
const plan = (input) => planPrune({ now: NOW, retentionMs: RETENTION, ...input });

test('release keys round-trip their time', () => {
  const t = Date.UTC(2026, 10, 19, 15, 35, 0, 123);
  assert.equal(releaseKey(t), '_releases/20261119T153500123Z.json');
  assert.equal(releaseTime(releaseKey(t)), t);
  assert.ok(Number.isNaN(releaseTime('_releases/notes.txt')));
});

test('parseRecord: records without the flag were written after going live', () => {
  assert.deepEqual(parseRecord('{"assets":["assets/a.js"]}'), { assets: ['assets/a.js'], activated: true });
  assert.deepEqual(parseRecord('{"assets":[],"activated":false}'), { assets: [], activated: false });
  for (const bad of ['', 'not json', 'null', '{"assets":"x"}', '{"assets":[1]}', '{"assets":[],"activated":"yes"}']) {
    assert.equal(parseRecord(bad), null, bad);
  }
});

test('an old upload that was live until today survives today\'s deploy', () => {
  assert.deepEqual(
    plan({
      assets: [obj('assets/a.js', 30), obj('assets/b.js', 0)],
      releases: [rel(30, ['assets/a.js']), rel(0, ['assets/b.js'])],
      currentAssets: ['assets/b.js'],
    }),
    { deleteAssets: [], deleteReleases: [] },
  );
});

test('a release replaced more than the window ago is pruned with its record', () => {
  // A (40 days ago) was replaced by B (20 days ago), B by C (today). B was live when the window
  // began, so B stays; A goes.
  const a = rel(40, ['assets/a.js', 'assets/shared.css']);
  assert.deepEqual(
    plan({
      assets: [obj('assets/a.js', 40), obj('assets/shared.css', 40), obj('assets/b.js', 20), obj('assets/c.js', 0)],
      releases: [a, rel(20, ['assets/b.js', 'assets/shared.css']), rel(0, ['assets/c.js', 'assets/shared.css'])],
      currentAssets: ['assets/c.js', 'assets/shared.css'],
    }),
    { deleteAssets: ['assets/a.js'], deleteReleases: [a.key] },
  );
});

test('an unconfirmed record before the window keeps the confirmed release before it too', () => {
  // P went live 30 days ago. A deploy 20 days ago recorded R but may have stopped before or after
  // switching index.html. Either could have been live when the window began: keep both.
  const p = rel(30, ['assets/p.js']);
  const r = rel(20, ['assets/r.js'], false);
  const old = rel(40, ['assets/old.js']);
  assert.deepEqual(
    plan({
      assets: [obj('assets/old.js', 40), obj('assets/p.js', 30), obj('assets/r.js', 20), obj('assets/q.js', 0)],
      releases: [old, p, r, rel(0, ['assets/q.js'])],
      currentAssets: ['assets/q.js'],
    }),
    { deleteAssets: ['assets/old.js'], deleteReleases: [old.key] },
  );
});

test('the live release is never pruned, even if no record mentions it', () => {
  assert.deepEqual(
    plan({ assets: [obj('assets/live.js', 90)], releases: [rel(30, ['assets/x.js'])], currentAssets: ['assets/live.js'] }).deleteAssets,
    [],
  );
});

test('untracked files stay until a confirmed release from before the window proves them retired', () => {
  const assets = [obj('assets/legacy.js', 60), obj('assets/now.js', 0)];
  // Bookkeeping only began inside the window: legacy.js may belong to the release live at its start.
  assert.deepEqual(plan({ assets, releases: [rel(2, ['assets/now.js'])], currentAssets: ['assets/now.js'] }).deleteAssets, []);
  // Only an unconfirmed record before the window: still not established.
  assert.deepEqual(
    plan({ assets, releases: [rel(20, [], false), rel(0, ['assets/now.js'])], currentAssets: ['assets/now.js'] }).deleteAssets,
    [],
  );
  // A confirmed release has been recorded since before the window began: legacy.js was not live in it.
  assert.deepEqual(
    plan({ assets, releases: [rel(20, ['assets/mid.js']), rel(0, ['assets/now.js'])], currentAssets: ['assets/now.js'] }).deleteAssets,
    ['assets/legacy.js'],
  );
  // ...but not a file uploaded inside the window (a failed deploy's upload, say).
  assert.deepEqual(
    plan({ assets: [obj('assets/recent.js', 2)], releases: [rel(20, []), rel(0, [])], currentAssets: [] }).deleteAssets,
    [],
  );
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
  const failGet = new Set();
  const keyOf = (uri) => uri.replace(/^s3:\/\/[^/]+\//, '');
  const aws = (args, input) => {
    const [svc, cmd] = args;
    if (svc === 's3' && cmd === 'cp' && args[2] === '-') {
      objects.set(keyOf(args[3]), { body: input, lastModified: clock.now });
      return '';
    }
    if (svc === 's3' && cmd === 'cp' && args[3] === '-') {
      const key = keyOf(args[2]);
      if (failGet.has(key) || !objects.has(key)) throw new Error(`GetObject failed for ${key}`);
      return objects.get(key).body;
    }
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
  return { aws, objects, failGet, upload };
}

function build(files) {
  const dist = mkdtempSync(join(tmpdir(), 'spa-dist-'));
  mkdirSync(join(dist, 'assets'));
  for (const f of files) writeFileSync(join(dist, 'assets', f), '');
  return dist;
}

/** The deploy-frontend order: upload assets, record, (switch index.html), activate, prune. */
function deployer(s3, clock) {
  const call = (args) => run({ args, aws: s3.aws, now: clock.now, log: () => {} });
  return {
    call,
    deploy(files, { stopAfterRecord = false } = {}) {
      const dist = build(files);
      for (const f of files) s3.upload(`assets/${f}`);
      const key = call(['record', '--bucket', 'b', '--dist', dist]);
      if (stopAfterRecord) return { key };
      call(['activate', '--bucket', 'b', '--key', key]);
      return { key, plan: call(['prune', '--bucket', 'b', '--dist', dist, '--retention-days', '7']) };
    },
  };
}

test('run: records before the switch, then prunes only releases replaced long ago', () => {
  const clock = { now: at(30) };
  const s3 = fakeAws(clock);
  const { deploy } = deployer(s3, clock);

  deploy(['a.js']); // release A, 30 days ago
  clock.now = at(0);
  deploy(['b.js']); // B replaces A today: A's files must survive
  assert.ok(s3.objects.has('assets/a.js'));

  clock.now = NOW + 10 * DAY;
  const { plan: p } = deploy(['c.js']); // C replaces B; A was replaced 10 days ago, past the window
  assert.deepEqual(p.deleteAssets, ['assets/a.js']);
  assert.ok(s3.objects.has('assets/b.js'), 'B was live when the window began');
  assert.ok(s3.objects.has('assets/c.js'));
  const records = [...s3.objects].filter(([k]) => k.startsWith('_releases/'));
  assert.equal(records.length, 2);
  assert.ok(records.every(([, o]) => JSON.parse(o.body).activated === true));
});

test('run: an unreadable record stops pruning entirely (the review\'s reproduction)', () => {
  // A 30-day-old release is replaced today, and reading its record fails.
  const clock = { now: at(30) };
  const s3 = fakeAws(clock);
  const { deploy } = deployer(s3, clock);
  const { key: a } = deploy(['a.js']);
  s3.failGet.add(a);
  clock.now = at(0);
  const { plan: p } = deploy(['b.js']);
  assert.equal(p, null);
  assert.ok(s3.objects.has('assets/a.js'));
  assert.ok(s3.objects.has(a));

  // A record that reads but is not one is treated the same way.
  s3.failGet.delete(a);
  s3.objects.set(a, { body: '{"assets": "oops"}', lastModified: at(30) });
  clock.now = NOW + 10 * DAY;
  assert.equal(deploy(['c.js']).plan, null);
  assert.ok(s3.objects.has('assets/a.js'));
});

test('run: a deploy that stopped after recording leaves its predecessor protected', () => {
  const clock = { now: at(30) };
  const s3 = fakeAws(clock);
  const { deploy } = deployer(s3, clock);
  deploy(['p.js']); // P, live
  clock.now = at(20);
  deploy(['r.js'], { stopAfterRecord: true }); // R recorded; index.html may or may not have switched
  clock.now = at(0);
  deploy(['q.js']);
  assert.ok(s3.objects.has('assets/p.js'), 'P may have been live until today');
  assert.ok(s3.objects.has('assets/r.js'), 'R may have been live until today');
});

test('run: activate refuses a key that is not a record, and arguments are checked', () => {
  const clock = { now: NOW };
  const s3 = fakeAws(clock);
  const { call } = deployer(s3, clock);
  assert.throws(() => call(['activate', '--bucket', 'b', '--key', 'index.html']), /must be a record key/);
  assert.throws(() => call(['activate', '--bucket', 'b', '--key', releaseKey(NOW)]), /GetObject failed/);
  assert.throws(() => call(['publish', '--bucket', 'b']), /must be one of/);
  assert.throws(() => call(['record', '--dist', 'x']), /--bucket is required/);
  assert.throws(() => call(['prune', '--bucket', 'b', '--dist', 'x', '--retention-days', '0']), /at least 1/);
});
