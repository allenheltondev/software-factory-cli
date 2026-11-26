import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContext, CLOUD_BUILD_ENV, IMAGE_DIR, NATIVE_BUILD_ENV, NATIVE_CLAUDE_VERSION, NATIVE_CODEX_VERSION, repoRoot } from './job-image-context.js';

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
    expect(env).toContain('KIRO_INSTALL_COMMAND="sh /opt/updraft/install-kiro-rpm.sh"');
    expect(paths).toContain('install-kiro-rpm.sh');
  });

  it('leaves the ARM64 Kiro installer off for self-hosted images', () => {
    const defaults = readFileSync(join(IMAGE_DIR, 'build.env'), 'utf8');
    expect(defaults.match(/^KIRO_INSTALL_COMMAND=.*$/gm)).toEqual(['KIRO_INSTALL_COMMAND=""']);
  });
});

describe('the subscription worker image context (--native-claude, #125)', () => {
  const entries = buildContext(IMAGE_DIR, { name: 'allenheltondev-updraft-0.1.0.tgz', data: Buffer.from('tarball') }, NATIVE_BUILD_ENV);
  const env = entries.find((e) => e.path === 'build.env')!.data.toString('utf8');
  const worker = (name: string) => readFileSync(join(repoRoot, 'deploy', 'aws-microvm', 'native-worker', name), 'utf8');

  it('installs both subscription CLIs into one image, each pinned to an exact release', () => {
    expect(NATIVE_CLAUDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(NATIVE_CODEX_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(env.endsWith(NATIVE_BUILD_ENV)).toBe(true);
    expect(env).toContain(`AGENT_PACKAGES="@anthropic-ai/claude-code@${NATIVE_CLAUDE_VERSION} @openai/codex@${NATIVE_CODEX_VERSION}"`);
    // The last AGENT_PACKAGES line wins when the build sources build.env: it is the pinned one.
    const lines = env.match(/^AGENT_PACKAGES=.*$/gm)!;
    expect(lines.at(-1)).toBe(`AGENT_PACKAGES="@anthropic-ai/claude-code@${NATIVE_CLAUDE_VERSION} @openai/codex@${NATIVE_CODEX_VERSION}"`);
    // The job runner image is unchanged: unpinned CLIs, as before.
    expect(CLOUD_BUILD_ENV).toContain('AGENT_PACKAGES="@anthropic-ai/claude-code @openai/codex"');
  });

  it('records the official native Codex binary from the pinned package, never the npm wrapper', () => {
    const install = worker('install.sh');
    expect(install).toContain('command -v codex');
    expect(install).toMatch(/@openai\/codex-linux-arm64/);
    expect(install).toContain('aarch64-unknown-linux-musl');
    expect(install).toContain('path.join(vendor,triple,"bin","codex")');
    expect(install).toContain('c.codex=bin');
    // Packaged into the image with the rest of the worker.
    expect(worker('package-image.sh')).toMatch(/cp "\$here"\/\*\.mjs "\$here"\/\*\.sh/);
  });
});
