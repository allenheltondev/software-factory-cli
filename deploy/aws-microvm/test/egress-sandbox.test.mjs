// Registry egress (#147) through the real sandbox runtime: bubblewrap with --network none, the
// proxy's socket directory bound in by the native worker's own wrapper (withEgress), and the
// shim in front of the command. Needs Linux, bwrap and network namespaces; skipped elsewhere.
// Name resolution and the upstream connection are stood in for (this host's own egress is not
// the thing under test); what is real is the boundary: the command has no route but the proxy.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainerRunArgs } from '../../../src/worker/container.ts';
import { buildAllowlist, createEgressProxy } from '../image/sandbox/egress-proxy.mjs';
import { parseRunArgs } from '../image/sandbox/updraft-sandbox.mjs';
import { EGRESS_SOCKET, IMAGE, withEgress } from '../native-worker/policy.mjs';
import { installRuntime, networkNamespaceAvailability } from './sandbox-host.mjs';

const availability = networkNamespaceAvailability();
const SHIM = fileURLToPath(new URL('../image/sandbox/egress-shim.mjs', import.meta.url));

let root;
let runtime;
let upstream;
let proxy;
let egressDir;
let worktree;
const connects = [];

beforeAll(async () => {
  if (!availability.usable) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-egress-sandbox-'));
  runtime = installRuntime(path.join(root, 'runtime'), { image: IMAGE, readOnlyBinds: [path.dirname(SHIM)] });
  worktree = path.join(root, 'job');
  fs.mkdirSync(worktree);
  egressDir = path.join(root, 'egress');
  fs.mkdirSync(egressDir);
  upstream = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  proxy = createEgressProxy({ rules: buildAllowlist() }, {
    resolve: async (host) => (host === 'registry.npmjs.org' ? [{ address: '104.16.0.35', family: 4 }] : Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))),
    connect: (target) => { connects.push(target); return net.connect(upstream.address().port, '127.0.0.1'); },
  });
  await new Promise((r) => proxy.server.listen(path.join(egressDir, EGRESS_SOCKET), r));
});

/** Async on purpose: the proxy and the stand-in registry live in this process. */
function runtimeRun(args) {
  return new Promise((resolve) => {
    const child = spawn(runtime.path, ['run', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

afterAll(async () => {
  if (!availability.usable) return;
  await proxy.close();
  await new Promise((r) => upstream.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

/** What runs inside: the proxy route, a direct route to the host's loopback, and DNS. */
const PROBE = `
const net = require('net'), dns = require('dns');
const url = new URL(process.env.HTTPS_PROXY);
const viaProxy = (target) => new Promise((resolve) => {
  const s = net.connect(Number(url.port), url.hostname, () => s.write('CONNECT ' + target + ' HTTP/1.1\\r\\n\\r\\n'));
  let data = '';
  s.on('data', (d) => { data += d; if (data.startsWith('HTTP/1.1 200') && !data.includes('echo:')) s.write('hi'); if (data.includes('echo:hi')) s.end(); });
  s.on('close', () => resolve(data.split('\\r\\n')[0] + (data.includes('echo:hi') ? ' tunneled' : '')));
  s.on('error', (e) => resolve('error ' + e.code));
});
const direct = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve('connected'); });
  s.on('error', (e) => resolve(e.code));
});
(async () => {
  const out = {
    allowed: await viaProxy('registry.npmjs.org:443'),
    denied: await viaProxy('example.com:443'),
    directHostLoopback: await direct(Number(process.argv[1])),
    dns: await new Promise((r) => dns.lookup('registry.npmjs.org', (e) => r(e ? e.code : 'resolved'))),
    interfaces: Object.values(require('os').networkInterfaces()).flat().filter((a) => !a.internal).length,
  };
  console.log(JSON.stringify(out));
})();`;

describe.skipIf(!availability.usable)(`registry egress in the sandbox${availability.usable ? '' : ` (skipped: ${availability.reason})`}`, () => {
  it('reaches allowed registries only through the proxy, with no other network', async () => {
    const base = buildContainerRunArgs({ file: process.execPath, args: ['-e', PROBE, String(upstream.address().port)] }, {
      image: IMAGE, name: `egress-${process.pid}`, mounts: [{ path: worktree, readOnly: false }], workdir: worktree,
      user: `${process.getuid()}:${process.getgid()}`, network: 'none', runLabel: 'test',
    });
    const runArgs = base.slice(1); // after "run"
    const run = parseRunArgs(runArgs);
    const args = withEgress(runArgs, run, run.command, { dir: egressDir, shim: SHIM, node: process.execPath });
    expect(args).toContain('none');
    const result = await runtimeRun(args);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    expect(out).toEqual({
      allowed: 'HTTP/1.1 200 Connection Established tunneled',
      denied: 'HTTP/1.1 403 Forbidden',
      directHostLoopback: 'ECONNREFUSED',
      dns: expect.stringMatching(/^E/),
      interfaces: 0,
    });
    expect(result.stderr).toContain('updraft-egress: refused CONNECT example.com:443 (not-allowed)');
    expect(connects).toEqual([{ address: '104.16.0.35', port: 443, family: 4 }]);
  });

  it('leaves the network off without egress', async () => {
    const base = buildContainerRunArgs({ file: '/bin/sh', args: ['-c', 'echo "proxy=${HTTPS_PROXY:-none}"'] }, {
      image: IMAGE, name: `noegress-${process.pid}`, mounts: [{ path: worktree, readOnly: false }], workdir: worktree,
      user: `${process.getuid()}:${process.getgid()}`, network: 'none', runLabel: 'test',
    });
    const runArgs = base.slice(1);
    const args = withEgress(runArgs, parseRunArgs(runArgs), parseRunArgs(runArgs).command, undefined);
    expect(args).toEqual(runArgs);
    const result = await runtimeRun(args);
    expect(result.stdout.trim()).toBe('proxy=none');
  });
});
