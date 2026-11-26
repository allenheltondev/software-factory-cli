// Deletes old versions of a MicroVM image so the next build does not hit the API's cap on the
// number of versions an image may have ("has reached the maximum number of versions allowed").
import {
  AccessDeniedException,
  ConflictException,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  ResourceNotFoundException,
  type LambdaMicrovmsClient,
  type MicrovmImageVersionSummary,
} from '@aws-sdk/client-lambda-microvms';

/** How many of the newest versions a build leaves in place. */
export const DEFAULT_KEEP_VERSIONS = 5;

const BUSY_IMAGE_STATES = new Set(['CREATING', 'UPDATING', 'DELETING']);
const SETTLE_TIMEOUT_MS = 10 * 60 * 1000;
const SETTLE_POLL_MS = 5_000;

/**
 * Waits until the image is not changing. Deleting versions puts it in UPDATING for a while, and
 * the API refuses an update or another delete until that is over ("Cannot update MicroVM Image in
 * its current state").
 */
export async function waitForImageSettled(
  microvms: LambdaMicrovmsClient,
  imageArn: string,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<void> {
  const { timeoutMs = SETTLE_TIMEOUT_MS, pollMs = SETTLE_POLL_MS, log = console.log } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (;;) {
    const { state } = await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: imageArn }));
    if (!BUSY_IMAGE_STATES.has(state ?? '')) return;
    if (waited >= timeoutMs) throw new Error(`the image is still ${state} after ${Math.round(timeoutMs / 60000)} minutes`);
    if (waited === 0) log(`    waiting for the image to finish ${state?.toLowerCase()}`);
    await sleep(pollMs);
    waited += pollMs;
  }
}

export interface PruneResult {
  deleted: string[];
  /** Versions that should have gone but did not (in use, or the deploy role may not delete). */
  skipped: string[];
}

/** A version no longer counted or touched: already gone or on its way out. */
const GONE = new Set(['DELETED', 'DELETING']);
/** A version that is still building must be left to finish. */
const SETTLED = new Set(['SUCCESSFUL', 'FAILED', 'DELETE_FAILED']);

/** The versions to delete, oldest first: everything settled beyond the `keep` newest, except the `protect`ed ones. */
export function versionsToDelete(versions: MicrovmImageVersionSummary[], keep: number, protect: Iterable<string | undefined>): string[] {
  const protectedVersions = new Set([...protect].filter((v): v is string => Boolean(v)));
  const newestFirst = versions
    .filter((v) => v.imageVersion && !GONE.has(v.state ?? ''))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return newestFirst
    .slice(Math.max(keep, 0))
    .filter((v) => SETTLED.has(v.state ?? '') && !protectedVersions.has(v.imageVersion!))
    .map((v) => v.imageVersion!)
    .reverse();
}

/**
 * Deletes the settled versions of `imageArn` beyond the `keep` newest, never the `protect`ed ones
 * (the version jobs start with, the latest active one). Best effort: a deploy role that may not
 * list or delete versions, or a version that is still in use, is reported and the build goes on,
 * because it only fails if the image is actually at its cap.
 */
export async function pruneImageVersions(
  microvms: LambdaMicrovmsClient,
  imageArn: string,
  options: { keep?: number; protect?: Iterable<string | undefined>; log?: (line: string) => void; settle?: typeof waitForImageSettled } = {},
): Promise<PruneResult> {
  const log = options.log ?? console.log;
  const settle = options.settle ?? waitForImageSettled;
  const result: PruneResult = { deleted: [], skipped: [] };
  const versions: MicrovmImageVersionSummary[] = [];
  await settle(microvms, imageArn, { log });
  try {
    let nextToken: string | undefined;
    do {
      const page = await microvms.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: imageArn, nextToken }));
      versions.push(...(page.items ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
  } catch (error) {
    if (error instanceof AccessDeniedException) {
      log('    cannot list image versions (the deploy role needs lambda:ListMicrovmImageVersions); not pruning old ones');
      return result;
    }
    throw error;
  }

  for (const version of versionsToDelete(versions, options.keep ?? DEFAULT_KEEP_VERSIONS, options.protect ?? [])) {
    try {
      await microvms.send(new DeleteMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: version }));
      result.deleted.push(version);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) continue;
      if (error instanceof AccessDeniedException) {
        log('    cannot delete image versions (the deploy role needs lambda:DeleteMicrovmImageVersion); stopping');
        result.skipped.push(version);
        break;
      }
      if (error instanceof ConflictException) {
        log(`    kept version ${version}: ${error.message}`);
        result.skipped.push(version);
        continue;
      }
      throw error;
    }
  }
  if (result.deleted.length) await settle(microvms, imageArn, { log });
  if (result.deleted.length) log(`==> deleted ${result.deleted.length} old image version${result.deleted.length === 1 ? '' : 's'}: ${result.deleted.join(', ')}`);
  return result;
}

/** A microVM in any of these states may still be running its version: it keeps that version. */
const ENDED_VM_STATES = new Set(['TERMINATED']);

/**
 * Every version of `imageArn` that some microVM not yet terminated runs (PENDING, RUNNING,
 * SUSPENDING, SUSPENDED, TERMINATING). Throws when the list cannot be read whole: a caller that
 * cannot tell which versions are live must not delete any.
 */
export async function liveImageVersions(microvms: LambdaMicrovmsClient, imageArn: string): Promise<Set<string>> {
  const live = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await microvms.send(new ListMicrovmsCommand({ imageIdentifier: imageArn, nextToken }));
    for (const vm of page.items ?? []) {
      // A row that names no version cannot be matched to one: refuse to guess.
      if (!vm.imageVersion) throw new Error(`microVM ${vm.microvmId ?? '(unnamed)'} reports no image version`);
      if (!ENDED_VM_STATES.has(vm.state ?? '')) live.add(vm.imageVersion);
    }
    nextToken = page.nextToken ?? undefined;
  } while (nextToken);
  return live;
}

/**
 * Pruning for the Claude subscription image (#176). A managed session keeps its immutable image
 * version for its whole life, across any number of rollouts, so "the newest few" is no bound on
 * what is in use: a dozen merges in an afternoon pushed a live session's version out of it. Every
 * version a live microVM runs is kept, besides the active and latest ones; when the live VMs
 * cannot be listed, nothing is deleted (the build fails at the version cap instead, loudly, rather
 * than deleting a version a session may be using). Pruning never reads or writes an approval:
 * a kept or deleted version's compatibility record is left as it is.
 */
export async function pruneNativeImageVersions(
  microvms: LambdaMicrovmsClient,
  imageArn: string,
  options: { active?: string; latestActive?: string; keep?: number; log?: (line: string) => void; settle?: typeof waitForImageSettled },
): Promise<PruneResult & { live: string[] }> {
  const log = options.log ?? console.log;
  let live: Set<string>;
  try {
    live = await liveImageVersions(microvms, imageArn);
  } catch (error) {
    const why = error instanceof AccessDeniedException ? 'the deploy role needs lambda:ListMicrovms' : (error as Error)?.message ?? 'unknown error';
    log(`    cannot list the image's live microVMs (${why}); not pruning old versions, so no live session's version is deleted`);
    return { deleted: [], skipped: [], live: [] };
  }
  if (live.size) log(`    keeping ${live.size} version${live.size === 1 ? '' : 's'} live microVMs run: ${[...live].join(', ')}`);
  const result = await pruneImageVersions(microvms, imageArn, {
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
    protect: [options.active, options.latestActive, ...live],
    log,
    ...(options.settle ? { settle: options.settle } : {}),
  });
  return { ...result, live: [...live] };
}
