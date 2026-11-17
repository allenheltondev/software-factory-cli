import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathEntries, which } from './which.js';

describe('which (injected filesystem)', () => {
  it('tries PATHEXT extensions in order on Windows, with a case-insensitive Path variable', () => {
    const files = new Set(['C:\\tools\\gh.exe', 'C:\\npm\\claude.cmd', 'C:\\npm\\claude.ps1']);
    const opts = {
      platform: 'win32' as const,
      env: { Path: 'C:\\missing;"C:\\npm";C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isExecutable: (p: string) => files.has(p),
    };
    expect(which('gh', opts)).toBe('C:\\tools\\gh.exe');
    expect(which('claude', opts)).toBe('C:\\npm\\claude.cmd');
    expect(which('gh.exe', opts)).toBe('C:\\tools\\gh.exe');
    expect(which('nope', opts)).toBeNull();
    expect(which('C:\\tools\\gh', opts)).toBe('C:\\tools\\gh.exe');
  });

  it('uses PATH as-is on POSIX', () => {
    const opts = {
      platform: 'linux' as const,
      env: { PATH: '/usr/local/bin::/usr/bin' },
      isExecutable: (p: string) => p === '/usr/bin/git',
    };
    expect(which('git', opts)).toBe('/usr/bin/git');
    expect(which('/usr/bin/git', opts)).toBe('/usr/bin/git');
    expect(which('gh', opts)).toBeNull();
    expect(which('', opts)).toBeNull();
    expect(pathEntries(opts)).toEqual(['/usr/local/bin', '/usr/bin']);
  });
});

describe('which (real filesystem)', () => {
  it('finds a file in a temp PATH directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'which-'));
    mkdirSync(join(dir, 'sub'));
    const isWin = process.platform === 'win32';
    const file = join(dir, isWin ? 'fake-tool.cmd' : 'fake-tool');
    writeFileSync(file, isWin ? '@echo off\r\n' : '#!/bin/sh\n');
    if (!isWin) chmodSync(file, 0o755);
    const env = { PATH: [join(dir, 'sub'), dir].join(isWin ? ';' : ':'), PATHEXT: '.EXE;.CMD' };
    expect(which('fake-tool', { env })).toBe(file);
    expect(which('sub', { env })).toBeNull(); // directories are not executables
    if (!isWin) {
      chmodSync(file, 0o644);
      expect(which('fake-tool', { env })).toBeNull();
    }
  });
});
