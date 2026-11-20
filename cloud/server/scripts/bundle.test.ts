import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The Lambda bundles load as ES modules, which have no require(); a CommonJS dependency that
// require()s a Node built-in at load time (yaml does) crashes the function before it answers
// anything. That only shows in a real ES module process, so the bundle runs in one here.
describe('the Lambda bundles', () => {
  it('load as ES modules, and the API answers /api/health', () => {
    execFileSync(process.execPath, [join(root, 'scripts', 'bundle.mjs')], { cwd: root, stdio: 'ignore' });
    const script = `
      const { handler } = await import('./dist/index.mjs');
      const res = await handler({ httpMethod: 'GET', path: '/api/health', resource: '/api/health', headers: {}, multiValueHeaders: {},
        queryStringParameters: null, multiValueQueryStringParameters: null, body: null, isBase64Encoded: false,
        requestContext: { stage: 'v1', path: '/api/health', httpMethod: 'GET', identity: {} } }, {});
      for (const f of ['webhook', 'broker', 'cleanup']) await import('./dist/' + f + '.mjs');
      process.stdout.write(JSON.stringify({ status: res.statusCode, body: res.body }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(JSON.parse(out)).toEqual({ status: 200, body: '{"ok":true}' });
  }, 60_000);
});
