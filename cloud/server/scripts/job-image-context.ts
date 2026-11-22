import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZipEntry } from './zip.js';

/** The job image's build context (build-job-image.ts). */

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const IMAGE_DIR = join(repoRoot, 'deploy', 'aws-microvm', 'image');

/** Hosted ARM64 builds package Kiro alongside Claude and Codex. */
export const CLOUD_BUILD_ENV = `AGENT_PACKAGES="@anthropic-ai/claude-code @openai/codex"
KIRO_INSTALL_COMMAND="sh /opt/updraft/install-kiro-rpm.sh"
`;

/**
 * Text as the repository stores it (LF): a Windows checkout has CRLF, and the build sources
 * build.env and runs these files on Linux, where a CR breaks them. Binary files stay as they are.
 */
export function toLf(data: Buffer): Buffer {
  if (data.includes(0)) return data;
  const text = data.toString('utf8');
  return text.includes('\r\n') ? Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8') : data;
}

/**
 * The build context: image/ as it is in the repository, without installed modules or another
 * tarball, plus the CLI tarball in vendor/ and the hosted settings appended to build.env.
 */
export function buildContext(imageDir: string, tarball: { name: string; data: Buffer }, extraBuildEnv = CLOUD_BUILD_ENV): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(imageDir, full).split(sep).join('/');
      if (rel === 'runner/node_modules' || (rel.startsWith('vendor/') && rel.endsWith('.tgz'))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else entries.push({ path: rel, data: toLf(readFileSync(full)) });
    }
  };
  walk(imageDir);
  const env = entries.find((e) => e.path === 'build.env');
  if (!env) throw new Error(`${imageDir} has no build.env`);
  const text = env.data.toString('utf8');
  env.data = Buffer.from(`${text}${text.endsWith('\n') ? '' : '\n'}# Updraft Cloud (cloud/server/scripts/build-job-image.ts)\n${extraBuildEnv}`, 'utf8');
  entries.push({ path: `vendor/${tarball.name}`, data: tarball.data });
  return entries;
}

