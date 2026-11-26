// Links to the Updraft Cloud console, for the comments a hosted run writes on GitHub
// (docs/assignment-comments.md, "Job link"). The runner hands the context to `updraft run-event`;
// standalone workers have none, and then nothing links.
//
// The destination never comes from issue content, agent output or repository configuration: only
// from the runner's environment, checked here. A link grants no access: the console still
// requires sign-in and installation membership.

/**
 * Hosted context the runner hands to `updraft run-event`: the trusted console origin, the GitHub
 * installation id and the Cloud job id. All three are required for a link; none is a secret.
 */
export interface ConsoleContext {
  origin: string;
  installationId: string;
  cloudJobId: string;
}

/** Reads the hosted context from the runner's environment; null when absent or unusable. */
export function consoleContextFromEnv(env: NodeJS.ProcessEnv): ConsoleContext | null {
  const installationId = env.UPDRAFT_CLOUD_INSTALLATION_ID?.trim();
  const cloudJobId = env.UPDRAFT_CLOUD_JOB_ID?.trim();
  const origin = env.UPDRAFT_CONSOLE_ORIGIN?.trim();
  if (!origin || !installationId || !cloudJobId) return null;
  return { origin, installationId, cloudJobId };
}

/** The console origin and installation, or null when the context is missing or not a plain https (or localhost http) origin. */
function base(ctx: ConsoleContext | null | undefined): string | null {
  if (!ctx || !/^\d+$/.test(ctx.installationId)) return null;
  let u: URL;
  try {
    u = new URL(ctx.origin);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  return `${u.origin}/installations/${encodeURIComponent(ctx.installationId)}`;
}

/** The job page URL, or null when the context is missing or unusable. */
export function consoleJobUrl(ctx: ConsoleContext | null | undefined): string | null {
  const root = base(ctx);
  if (!root || !/^[A-Za-z0-9_.-]{1,128}$/.test(ctx!.cloudJobId)) return null;
  return `${root}/jobs/${encodeURIComponent(ctx!.cloudJobId)}`;
}

/**
 * The workflow timeline of an issue (every job of it, from the label to the merge), or null. The
 * console's workflow id is `<repository id>-i<issue>` (cloud/server/src/workflows/workflow.ts).
 */
export function consoleWorkflowUrl(ctx: ConsoleContext | null | undefined, repoId: number, issue: number): string | null {
  const root = base(ctx);
  if (!root || !Number.isSafeInteger(repoId) || repoId <= 0 || !Number.isSafeInteger(issue) || issue <= 0) return null;
  return `${root}/workflows/${repoId}-i${issue}`;
}

/** The installation's console page (agent keys, Claude, configuration live under it), or null. */
export function consoleInstallationUrl(ctx: ConsoleContext | null | undefined): string | null {
  return base(ctx);
}
