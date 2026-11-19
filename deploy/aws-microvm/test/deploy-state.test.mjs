// `deploy.sh state unsaved` and `state recover`, run for real with stand-ins on PATH: `aws`
// (fake-aws.mjs, a directory in place of the bucket) and the `updraft` the merge is made
// with (a script that records how it was called). What is tested is the script's own
// decisions: which backups it lists as complete, what it verifies before it merges, when it
// passes --base and when it refuses. The real AWS CLI and the real merge are not involved
// (src/db/merge.test.ts covers the merge; README.md, "What is not verified", the CLI).
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNSAVED_MANIFEST_VERSION, unsavedKeys } from '../image/runner/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.join(HERE, '..', 'deploy.sh');
const FAKE_AWS = path.join(HERE, 'fake-aws.mjs');
const BUCKET = 'fleet-bucket';
const STATE_KEY = 'state/state.db';

// A shell script, a shell on PATH and executable stand-ins: POSIX hosts only, like the
// runner suites. (`bash` missing on such a host skips the suite rather than failing it.)
const onLinuxLikeHost = process.platform !== 'win32';
const hasBash = onLinuxLikeHost && spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;

/** Bytes that pass for a SQLite database as far as the script looks: the header, and something after it. */
const sqlite = (text) => Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from(text)]);
const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');

describe.runIf(hasBash)('deploy.sh state unsaved / state recover', () => {
  let root;
  let env;
  let mergeLog;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-deploy-test-'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AWS}" "$@"\n`, { mode: 0o755 });
    // `updraft state merge`: says what it was asked, writes the merged file, reports a change.
    mergeLog = path.join(root, 'merge-calls.jsonl');
    fs.writeFileSync(
      path.join(bin, 'updraft'),
      `#!/bin/sh
case "$*" in *--help*) echo "  --base <file>"; exit 0 ;; esac
"${process.execPath}" -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${mergeLog}" "$@"
into=""; prev=""
for a in "$@"; do [ "$prev" = "--into" ] && into="$a"; prev="$a"; done
printf 'merged' > "$into"
echo '{"ok":true,"changed":true}'
`,
      { mode: 0o755 },
    );
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      AWS_REGION: 'eu-test-1',
      FAKE_AWS_ROOT: path.join(root, 's3'),
      FAKE_AWS_BUCKET: BUCKET,
      FAKE_AWS_LOG: path.join(root, 'aws-calls.jsonl'),
      STATE_KEY,
    };
    delete env.UPDRAFT_BIN;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const object = (key) => path.join(root, 's3', BUCKET, ...key.split('/'));
  const put = (key, body) => {
    fs.mkdirSync(path.dirname(object(key)), { recursive: true });
    fs.writeFileSync(object(key), body);
  };
  /** A backup as the runner writes it (saveUnsaved); `omit` leaves objects out, `manifest` changes what it says. */
  function backup(delivery, attempt, { base = sqlite('base'), changed = sqlite('changed'), omit = [], manifest = (m) => m } = {}) {
    const keys = unsavedKeys(STATE_KEY, delivery, attempt);
    if (base && !omit.includes('base')) put(keys.baseKey, base);
    if (!omit.includes('changed')) put(keys.key, changed);
    const m = manifest({
      version: UNSAVED_MANIFEST_VERSION,
      deliveryId: delivery,
      attemptId: attempt,
      createdAt: '2026-01-02T03:04:05.000Z',
      schemaVersion: 16,
      startedEmpty: !base,
      changed: { key: keys.key, bytes: changed.length, sha256: sha256(changed) },
      base: base ? { key: keys.baseKey, bytes: base.length, sha256: sha256(base), schemaVersion: 16 } : null,
    });
    if (!omit.includes('manifest')) put(keys.manifestKey, JSON.stringify(m));
    return keys;
  }
  const deploy = (...args) => {
    const r = spawnSync('bash', [DEPLOY, 'state', ...args], { env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const merges = () => (fs.existsSync(mergeLog) ? fs.readFileSync(mergeLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  /** Nothing was merged and nothing reached the shared database. */
  const refused = (r, message) => {
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(message);
    expect(r.err).toContain('nothing was merged');
    expect(merges()).toEqual([]);
    expect(fs.existsSync(object(STATE_KEY))).toBe(false);
  };

  it('parses', () => {
    execFileSync('bash', ['-n', DEPLOY]);
  });

  it('lists complete and incomplete backups apart', () => {
    backup('d-complete', 'a-1');
    backup('d-empty', 'a-1', { base: null });
    backup('d-partial', 'a-1', { omit: ['manifest'] });
    backup('d-partial', 'a-2', { omit: ['manifest', 'changed'] });
    put('state/unsaved/d-old.db', sqlite('old layout'));
    const r = deploy('unsaved');
    expect(r.code).toBe(0);
    const [complete, incomplete] = r.out.split('    incomplete');
    expect(complete).toContain('delivery d-complete  attempt a-1');
    expect(complete).toContain('delivery d-empty  attempt a-1');
    expect(complete).not.toContain('d-partial');
    expect(incomplete).toContain('delivery d-partial  attempt a-1  has: base.db changed.db');
    expect(incomplete).toContain('delivery d-partial  attempt a-2  has: base.db');
    expect(incomplete).toContain('d-old.db  (old layout, no manifest)');
    expect(incomplete).not.toContain('d-complete');

    fs.rmSync(path.join(root, 's3'), { recursive: true });
    expect(deploy('unsaved').out).toContain('none: no job has failed to save its state');
  });

  it('merges a complete backup against the base its manifest names, after checking both files', () => {
    backup('d-1', 'a-1');
    const r = deploy('recover', 'd-1');
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain('merged delivery d-1 (attempt a-1)');
    const [merge] = merges();
    expect(merge.slice(0, 3)).toEqual(['state', 'merge', '--changed']);
    expect(merge).toContain('--base');
    expect(merge).not.toContain('--live');
    // Uploaded with a condition: here, that no object exists yet.
    expect(fs.readFileSync(object(STATE_KEY), 'utf8')).toBe('merged');
    const calls = fs.readFileSync(env.FAKE_AWS_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.find((c) => c[1] === 'put-object')).toEqual(expect.arrayContaining(['--if-none-match', '*']));
    // The manifest is read before anything else of the backup.
    const copies = calls.filter((c) => c[1] === 'cp').map((c) => c[2].split('/').pop());
    expect(copies).toEqual(['manifest.json', 'changed.db', 'base.db']);
  });

  it('merges without a base only when the manifest says the job started from an empty state', () => {
    backup('d-1', 'a-1', { base: null });
    const r = deploy('recover', 'd-1');
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain('started from an empty state');
    expect(merges()[0]).not.toContain('--base');

    // The same without that statement is not "started empty": it is a manifest that cannot be used.
    fs.rmSync(object(STATE_KEY));
    fs.rmSync(mergeLog);
    backup('d-2', 'a-1', { base: null, manifest: (m) => ({ ...m, startedEmpty: false }) });
    refused(deploy('recover', 'd-2'), 'names no base snapshot and does not say that the job started from an empty state');
    backup('d-3', 'a-1', {
      base: null,
      manifest: (m) => {
        delete m.startedEmpty;
        return m;
      },
    });
    refused(deploy('recover', 'd-3'), 'does not say whether the job started from an empty state');
  });

  it('refuses a backup without a manifest, whatever else is there', () => {
    backup('d-1', 'a-1', { omit: ['manifest'] });
    refused(deploy('recover', 'd-1'), 'only incomplete backups');
    refused(deploy('recover', 'd-1', 'a-1'), 'no complete backup for attempt a-1');
    put('state/unsaved/d-old.db', sqlite('old'));
    put('state/unsaved/d-old.base.db', sqlite('old base'));
    refused(deploy('recover', 'd-old'), 'earlier version of the runner');
    expect(deploy('recover', 'd-none').err).toContain('no unsaved backup for delivery d-none');
  });

  it('refuses when the base the manifest names is missing, and never falls back to a merge without it', () => {
    backup('d-1', 'a-1', { omit: ['base'] });
    const r = deploy('recover', 'd-1');
    refused(r, 'base.db, and it could not be downloaded');
    expect(r.err).toContain('could write over what other runs did since');
  });

  it('refuses a base or a changed database that is not the file the manifest describes', () => {
    backup('d-size', 'a-1', { manifest: (m) => ({ ...m, base: { ...m.base, bytes: m.base.bytes + 1 } }) });
    refused(deploy('recover', 'd-size'), 'base.db is 20 bytes; the manifest says 21');
    backup('d-sum', 'a-1', { manifest: (m) => ({ ...m, base: { ...m.base, sha256: sha256('another file') } }) });
    refused(deploy('recover', 'd-sum'), 'the SHA-256 of base.db is');
    backup('d-changed', 'a-1', { manifest: (m) => ({ ...m, changed: { ...m.changed, sha256: sha256('another file') } }) });
    refused(deploy('recover', 'd-changed'), 'the SHA-256 of changed.db is');
    backup('d-missing', 'a-1', { omit: ['changed'] });
    refused(deploy('recover', 'd-missing'), 'changed.db, and it could not be downloaded');
  });

  it('refuses a manifest that is for another delivery or attempt, or names keys outside its own backup', () => {
    backup('d-1', 'a-1', { manifest: (m) => ({ ...m, deliveryId: 'd-other' }) });
    refused(deploy('recover', 'd-1'), 'the manifest is for delivery "d-other"');
    backup('d-2', 'a-1', { manifest: (m) => ({ ...m, base: { ...m.base, key: 'state/unsaved/d-1/a-1/base.db' } }) });
    refused(deploy('recover', 'd-2'), "the manifest's base key is");
    backup('d-3', 'a-1', { manifest: (m) => ({ ...m, version: 2 }) });
    refused(deploy('recover', 'd-3'), 'this command reads version 1');
  });

  it('asks which attempt when a delivery has several complete backups, and keeps them apart', () => {
    backup('d-1', 'a-1', { changed: sqlite('first attempt') });
    backup('d-1', 'a-2', { changed: sqlite('second attempt') });
    const r = deploy('recover', 'd-1');
    refused({ ...r, err: `${r.err} nothing was merged` }, 'several complete backups; name one');
    expect(r.err).toContain('a-1 a-2');
    expect(deploy('recover', 'd-1', 'a-2')).toMatchObject({ code: 0 });
    expect(merges()).toHaveLength(1);
  });

  it('merges again into the newer object when another write got there first', () => {
    backup('d-1', 'a-1');
    put(STATE_KEY, sqlite('shared v1'));
    // The first download sees v1; before the upload, somebody else writes v2.
    const aws = path.join(root, 'bin', 'aws');
    const marker = path.join(root, 'raced');
    fs.writeFileSync(
      aws,
      `#!/bin/sh\nif [ "$2" = "put-object" ] && [ ! -e "${marker}" ]; then : > "${marker}"; printf 'SQLite format 3\\000shared v2' > "${object(STATE_KEY)}"; fi\nexec "${process.execPath}" "${FAKE_AWS}" "$@"\n`,
      { mode: 0o755 },
    );
    const r = deploy('recover', 'd-1');
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain('a job wrote the shared database first');
    expect(merges()).toHaveLength(2);
    expect(fs.readFileSync(object(STATE_KEY), 'utf8')).toBe('merged');
  });
});
