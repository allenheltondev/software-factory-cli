import { describe, expect, it } from 'vitest';
import { buildContext, CLOUD_BUILD_ENV, IMAGE_DIR } from './job-image-context.js';

describe('the job image build context', () => {
  const entries = buildContext(IMAGE_DIR, { name: 'allenheltondev-updraft-0.1.0.tgz', data: Buffer.from('tarball') });
  const paths = entries.map((e) => e.path);

  it('is the image directory as the self-hosted build uses it, with this repository\'s CLI in vendor/', () => {
    for (const path of ['Dockerfile', 'build.env', 'runner/server.mjs', 'runner/job.mjs', 'runner/broker.mjs', 'runner/package.json', 'runner/package-lock.json', 'sandbox/updraft-sandbox.mjs']) {
      expect(paths).toContain(path);
    }
    expect(paths.filter((p) => p.startsWith('vendor/') && p.endsWith('.tgz'))).toEqual(['vendor/allenheltondev-updraft-0.1.0.tgz']);
    expect(paths.some((p) => p.startsWith('runner/node_modules/'))).toBe(false);
    for (const path of paths) expect(path).not.toMatch(/\\/);
  });

  it('has LF line endings whatever the checkout has (a Linux shell sources build.env)', () => {
    for (const entry of entries) expect(entry.data.includes('\r\n'), entry.path).toBe(false);
  });

  it('appends the hosted settings to build.env, so they win over its defaults', () => {
    const env = entries.find((e) => e.path === 'build.env')!.data.toString('utf8');
    expect(env.endsWith(CLOUD_BUILD_ENV)).toBe(true);
    expect(env).toContain('AGENT_PACKAGES="@anthropic-ai/claude-code @openai/codex"');
  });
});
