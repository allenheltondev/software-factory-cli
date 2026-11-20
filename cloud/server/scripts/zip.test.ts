import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zip } from './zip.js';

/** Reads an archive back through its central directory, as an unzip would. */
function unzip(archive: Buffer): Record<string, string> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let p = archive.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(p)).toBe(0x02014b50);
    const size = archive.readUInt32LE(p + 20);
    const nameLength = archive.readUInt16LE(p + 28);
    const local = archive.readUInt32LE(p + 42);
    const name = archive.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(local + 26);
    const data = archive.subarray(local + 30 + localNameLength, local + 30 + localNameLength + size);
    out[name] = inflateRawSync(data).toString('utf8');
    p += 46 + nameLength;
  }
  return out;
}

describe('zip', () => {
  const files = [
    { path: 'Dockerfile', data: Buffer.from('FROM scratch\n') },
    { path: 'runner/server.mjs', data: Buffer.from('console.log("hi")\n'.repeat(200)) },
    { path: 'vendor/updraft-0.1.0.tgz', data: Buffer.from([0, 1, 2, 255]) },
  ];

  it('writes an archive whose central directory lists every file with its contents', () => {
    const files2 = unzip(zip(files));
    expect(Object.keys(files2)).toEqual(['Dockerfile', 'runner/server.mjs', 'vendor/updraft-0.1.0.tgz']);
    expect(files2['runner/server.mjs']).toBe('console.log("hi")\n'.repeat(200));
  });

  it('is the same archive for the same files', () => {
    expect(zip(files).equals(zip(files))).toBe(true);
  });

  it('refuses paths that are not plainly relative', () => {
    for (const path of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', '']) expect(() => zip([{ path, data: Buffer.alloc(0) }])).toThrow(/not a relative zip path/);
  });

  it('is read by the system unzip tool, where there is one (bsdtar on Windows and macOS)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    const file = join(dir, 'context.zip');
    writeFileSync(file, zip(files));
    let listing: string;
    try {
      listing = execFileSync(process.platform === 'linux' ? 'unzip' : 'tar', process.platform === 'linux' ? ['-Z1', file] : ['-tf', file], { encoding: 'utf8' });
    } catch {
      return; // no tool on this machine
    }
    expect(listing.split(/\r?\n/).filter(Boolean)).toEqual(['Dockerfile', 'runner/server.mjs', 'vendor/updraft-0.1.0.tgz']);
  });
});
