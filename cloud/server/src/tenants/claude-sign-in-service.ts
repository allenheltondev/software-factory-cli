import type { Caller } from '../caller.js';
import { FlowError, type GitHubFlows } from '../flows/github.js';
import { SIGN_IN_WAIT_MINUTES } from '../jobs/claude-sign-in.js';
import type { JobClaudeSignIn, Store } from '../store/store.js';

/**
 * A job's Claude subscription sign-in in the console, for members of its installation only
 * (the broker's claude-sign-in actions, the runner's claude-sign-in.mjs). A member sees where it
 * stands and the claude.ai link to sign in at; once signed in there, they give the code claude.ai
 * shows, which the waiting job takes once and types into `claude setup-token`.
 */

export interface ClaudeSignInView {
  state: JobClaudeSignIn['state'];
  repository: string;
  issue?: number;
  pullRequest?: number;
  /** The claude.ai sign-in link: only while the job waits for a code. */
  url?: string;
  /** Until when the job waits for a code (ISO): only while it does. */
  waitsUntil?: string;
  /** Who gave the code. */
  by?: string;
  /** Why it failed. */
  reason?: string;
}

/** A code as claude.ai shows it (`<code>#<state>`): one token of URL-safe characters. Not a validity check. */
const CODE = /^[A-Za-z0-9._~#=+/-]{8,512}$/;

export function createClaudeSignInService({ store, github, now = Date.now }: { store: Store; github: Pick<GitHubFlows, 'member'>; now?: () => number }) {
  /** The job's sign-in, if the job is this installation's and is signing in; else not_found. */
  async function signInOf(installationId: number, jobId: string) {
    const job = /^[A-Za-z0-9_-]{8,64}$/.test(jobId) ? await store.getJob(jobId) : null;
    if (!job || job.installationId !== installationId || !job.claudeSignIn) throw new FlowError('not_found', 404, 'There is no Claude sign-in for that job');
    return { job, signIn: job.claudeSignIn };
  }

  function view(job: { repository: string; issue?: number; pullRequest?: number }, s: JobClaudeSignIn): ClaudeSignInView {
    const waiting = s.state === 'waiting';
    return {
      state: s.state,
      repository: job.repository,
      ...(job.issue !== undefined ? { issue: job.issue } : {}),
      ...(job.pullRequest !== undefined ? { pullRequest: job.pullRequest } : {}),
      ...(waiting && s.url ? { url: s.url, waitsUntil: new Date(Date.parse(s.at) + SIGN_IN_WAIT_MINUTES * 60_000).toISOString() } : {}),
      ...(s.by ? { by: s.by } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
    };
  }

  return {
    async get(caller: Caller, installationId: number, jobId: string): Promise<ClaudeSignInView> {
      await github.member(caller, installationId);
      const { job, signIn } = await signInOf(installationId, jobId);
      return view(job, signIn);
    },

    /** Gives the code claude.ai showed: only while the job waits for one, and only once. */
    async submit(caller: Caller, installationId: number, jobId: string, code: unknown): Promise<ClaudeSignInView> {
      const member = await github.member(caller, installationId);
      const typed = typeof code === 'string' ? code.trim() : '';
      if (!CODE.test(typed)) throw new FlowError('invalid_code', 400, 'Paste the whole code claude.ai shows after you sign in');
      const { job, signIn } = await signInOf(installationId, jobId);
      if (signIn.state !== 'waiting') throw new FlowError('sign_in_closed', 409, 'This sign-in is not waiting for a code any more');
      const next: JobClaudeSignIn = { state: 'code', at: new Date(now()).toISOString(), code: typed, ...(signIn.url ? { url: signIn.url } : {}), ...(member.githubLogin ? { by: member.githubLogin } : {}) };
      if (!(await store.updateClaudeSignIn(job.jobId, ['waiting'], next))) throw new FlowError('sign_in_closed', 409, 'This sign-in is not waiting for a code any more');
      return view(job, next);
    },
  };
}

export type ClaudeSignInService = ReturnType<typeof createClaudeSignInService>;
