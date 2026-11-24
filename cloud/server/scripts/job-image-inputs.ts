import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, toLf } from './job-image-context.js';

/**
 * What the job image is built from, or must agree with (paths from the repository root; a
 * trailing slash is a directory). build-job-image.ts records a fingerprint of these files on each
 * image version it builds, and the deploy workflow rebuilds only when the checkout's fingerprint
 * differs from the active version's:
 *
 *   deploy/aws-microvm/image/      the Dockerfile, build.env, the runner and the sandbox
 *   cloud/server/scripts/...       the build script, its context, these inputs and the zip writer
 *   src/config/, src/agents/       the config schema and its validation, which checks agent
 *                                  profiles and adapters: the server validates tenant configs
 *                                  with them and the image's CLI runs them, so both must agree
 *   package.json, package-lock.json  the CLI's version and dependencies
 *
 * The rest of the CLI (src/) is deliberately not here: its changes reach jobs with the next image
 * built for one of the reasons above, or when the workflow is run with build_image.
 */
export const IMAGE_INPUTS: readonly string[] = [
  'deploy/aws-microvm/image/',
  'cloud/server/scripts/build-job-image.ts',
  'cloud/server/scripts/job-image-check.ts',
  'cloud/server/scripts/job-image-context.ts',
  'cloud/server/scripts/job-image-inputs.ts',
  'cloud/server/scripts/zip.ts',
  'src/config/',
  'src/agents/',
  'package.json',
  'package-lock.json',
];

export function isImageInput(path: string): boolean {
  return IMAGE_INPUTS.some((input) => (input.endsWith('/') ? path.startsWith(input) : path === input));
}

/** The fingerprint of these files: their paths and contents (LF), in path order. */
export function fingerprintOf(files: readonly { path: string; data: Buffer }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const data = toLf(file.data);
    hash.update(`${file.path}\0${data.length}\0`).update(data);
  }
  return hash.digest('hex');
}

/**
 * The image inputs in a checkout as they are on disk: tracked files and new ones git does not
 * ignore (installed modules, a packed tarball), so a local build fingerprints what it builds.
 */
export function imageInputFiles(root = repoRoot, inputs = IMAGE_INPUTS): { path: string; data: Buffer }[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs], { cwd: root, encoding: 'utf8' });
  const paths = [...new Set(listed.split('\0').filter(Boolean))];
  // A tracked file deleted in the working tree is not an input any more.
  return paths.filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile()).map((path) => ({ path, data: readFileSync(join(root, path)) }));
}

export const imageInputFingerprint = (root = repoRoot) => fingerprintOf(imageInputFiles(root));

/** How an image version's description carries the fingerprint. */
export const describeInputs = (fingerprint: string) => `inputs ${fingerprint}`;
export function inputsFromDescription(description: string | undefined): string | null {
  return /\binputs ([0-9a-f]{64})\b/.exec(description ?? '')?.[1] ?? null;
}
