#!/usr/bin/env node
// Anonymous post-deploy checks against a deployed Updraft Cloud. No AWS credentials and no account:
// everything here is what a signed-out browser (or GitHub) can see.
//
//   node scripts/smoke.mjs --url https://updraft.readysetcloud.io
//
// Exits 1 listing every failed check.

import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, retries: { type: 'string', default: '6' } } });
if (!values.url) {
  console.error('smoke: --url is required');
  process.exit(2);
}
const base = values.url.replace(/\/+$/, '');
const retries = Number(values.retries);

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', text };
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const checks = [
  ['the SPA is served at /', async () => {
    const r = await get('/');
    return r.status === 200 && r.type.includes('text/html') && r.text.includes('id="root"');
  }],
  ['client-side routes fall back to index.html', async () => {
    const r = await get('/some/deep/route');
    return r.status === 200 && r.text.includes('id="root"');
  }],
  ['/auth-config.json names a region and an app client', async () => {
    const r = await get('/auth-config.json');
    const body = json(r.text);
    return r.status === 200 && typeof body?.region === 'string' && typeof body?.clientId === 'string' && body.clientId !== '';
  }],
  ['/api/health answers through CloudFront', async () => {
    const r = await get('/api/health');
    return r.status === 200 && json(r.text)?.ok === true;
  }],
  ['/api/v1 refuses a request without a token (JSON, not index.html)', async () => {
    const r = await get('/api/v1/me');
    return r.status === 401 && json(r.text)?.error === 'unauthorized';
  }],
  ['/api/v1 refuses a forged token', async () => {
    const r = await get('/api/v1/me', { authorization: 'Bearer not-a-real-token' });
    return r.status === 401 && !r.text.includes('id="root"');
  }],
];

// A fresh distribution or invalidation can take a minute to settle; retry the whole set a few times.
let failed = [];
for (let attempt = 1; attempt <= retries; attempt++) {
  failed = [];
  for (const [name, check] of checks) {
    let ok = false;
    try {
      ok = await check();
    } catch (err) {
      console.error(`  ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!ok) failed.push(name);
  }
  if (failed.length === 0) break;
  if (attempt < retries) {
    console.log(`smoke: attempt ${attempt} failed (${failed.length}); retrying in 10s`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

for (const [name] of checks) console.log(`${failed.includes(name) ? 'FAIL' : 'ok  '} ${name}`);
if (failed.length) process.exit(1);
console.log(`smoke: ${base} passed`);
