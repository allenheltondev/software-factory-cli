import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitFixture, type GitFixture } from '../../test/git-fixtures.js';
import { baseCheckRoot, prepareBaseCheckout, removeTree } from './base-check.js';

const fixtures: GitFixture[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('baseCheckRoot', () => {
  it('is always one new directory below <dataDir>/base-checks, whatever the run id', () => {
    const dataDir = join('/state', 'updraft');
    const parent = join(dataDir, 'base-checks');
    expect(baseCheckRoot(dataDir, 'run_0mwwx2yle39db6069')).toBe(join(parent, 'run_0mwwx2yle39db6069'));
    for (const id of ['', '.', '..', '...', '../..', '/', '-x', '.hidden', 'a/../..']) {
      const root = baseCheckRoot(dataDir, id);
      expect(dirname(root), JSON.stringify(id)).toBe(parent);
      expect(root, JSON.stringify(id)).not.toBe(parent);
      expect(['.', '..', ''], JSON.stringify(id)).not.toContain(root.slice(parent.length + 1));
    }
  });
});

describe('prepareBaseCheckout and removeTree', { timeout: 60_000 }, () => {
  it('writes the commit\'s files without git metadata and leaves the clone as it was', async () => {
    const f = createGitFixture('octo/widgets');
    fixtures.push(f);
    const sha = f.git(f.clone, 'rev-parse', 'HEAD');
    const status = f.git(f.clone, 'status', '--porcelain');
    const root = baseCheckRoot(join(f.root, 'state'), 'run_1');
    const b = await prepareBaseCheckout({ checkoutPath: f.clone, sha, root });
    expect(b).toEqual({ root, baseDir: join(root, 'base'), scratchDir: join(root, 'scratch'), sha });
    expect(existsSync(join(b.baseDir, 'README.md'))).toBe(true);
    expect(existsSync(join(b.baseDir, '.git'))).toBe(false);
    expect(existsSync(join(root, 'index'))).toBe(false);
    expect(f.git(f.clone, 'status', '--porcelain')).toBe(status);
    await expect(prepareBaseCheckout({ checkoutPath: f.clone, sha: 'HEAD', root })).rejects.toThrow(/not a full commit id/);
  });

  it.skipIf(process.platform === 'win32')('removes what an agent left, locked directories included, without following links', () => {
    const root = mkdtempSync(join(tmpdir(), 'updraft base-check '));
    dirs.push(root);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'keep');
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'locked', 'deep'), { recursive: true });
    writeFileSync(join(tree, 'locked', 'deep', 'file'), 'x');
    symlinkSync(outside, join(tree, 'link'));
    chmodSync(join(tree, 'locked', 'deep'), 0o000);
    chmodSync(join(tree, 'locked'), 0o500);
    expect(removeTree(tree)).toBeNull();
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
  });
});
