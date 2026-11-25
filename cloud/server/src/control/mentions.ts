import { controlHelp, controlPolicy, controlReply, isAutomatedComment, isControlActor, parseControlComment, refusalMessage, type ControlCommand, type RepoPermission } from '../../../../src/control/commands.js';
import type { QueueCancelResult } from '../jobs/queue.js';
import type { QueueEntry } from '../jobs/queue-store.js';
import type { RetryRequest, RetryResult } from '../jobs/retry.js';
import { resumeWorkflowPause, type StopResult } from '../jobs/stop.js';
import { UPDRAFT_BRANCH_PREFIX } from '../tenants/dispatch.js';
import type { ControlCommandRecord, Job, Store, WorkflowPause } from '../store/store.js';
import { workflowIdFor } from '../workflows/workflow.js';

/**
 * Human steering by GitHub mention in Updraft Cloud (#135, docs/controls.md): `@<app> pause`,
 * `resume`, `stop`, `cancel` in a managed issue or pull request, from `issue_comment.created` and
 * `pull_request_review_comment.created` deliveries (the HMAC was checked by the webhook).
 *
 * It reuses the primitives the console uses, never a new launch path:
 *   - stop: the shared stopper (jobs/stop.ts createJobStopper) on the one active job of the
 *     workflow, which fences, terminates and pauses exactly as the console's Stop job does;
 *   - pause and cancel: a durable PAUSE record on the workflow's subjects (no TTL), which the
 *     launcher, the admission queue, the broker and native assignment already check. A `pause`
 *     lets a job that already started finish its step; `cancel` also stops the active job and ends
 *     the queued one (the admission queue's own cancel);
 *   - resume: resumeWorkflowPause on exactly the pause it found (a newer stop wins), then, for a
 *     stopped job, the console's retry path (jobs/retry.ts): once per job, with every current
 *     check (config, keys, quotas, kill switch, Claude sign-in), from the stopped job's own event,
 *     so an existing pull request is continued rather than a new one opened.
 * Every command is claimed by its comment id before anything else (a redelivery or a replay does
 * nothing), and audited with its outcome. Who may give it is controlPolicy's. A refusal says
 * nothing about the workflow. `review`, `steer` and `escalate` are answered as not available here
 * yet: they need the job runner to take a comment as its event.
 */

export const CLOUD_UNSUPPORTED: readonly ControlCommand[] = ['review', 'steer', 'escalate'];

export interface MentionGitHub {
  permission(installationId: number, repositoryId: number, repository: string, login: string): Promise<RepoPermission | null>;
  /** `headRepoId`: the head branch's repository (a fork's differs; null when it was deleted). */
  pullRequest(installationId: number, repositoryId: number, repository: string, number: number): Promise<{ state: 'open' | 'closed'; merged: boolean; headRef: string; headSha: string; headRepoId?: number | null }>;
  issueOpen(installationId: number, repositoryId: number, repository: string, number: number): Promise<boolean>;
  reply(installationId: number, repositoryId: number, repository: string, number: number, body: string): Promise<void>;
}

export interface MentionDeps {
  store: Pick<Store, 'getTenant' | 'getConfigVersion' | 'getWorkflowPause' | 'pauseWorkflowSubjects' | 'setPauseControl' | 'claimControlCommand' | 'finishControlCommand' | 'listActiveJobs' | 'getJob' | 'resumeWorkflowPause'>;
  github: MentionGitHub;
  /** The App's slug: `@<slug>` is the handle. */
  slug: () => Promise<string | undefined>;
  stopJob?: (installationId: number, jobId: string, by: string, reason: string) => Promise<StopResult | null>;
  queue?: { waitingFor(installationId: number, repositoryId: number, subject: { issue?: number; pullRequest?: number }): Promise<QueueEntry | null>; cancel(installationId: number, jobId: string, by: string): Promise<QueueCancelResult> };
  retry?: (request: RetryRequest) => Promise<RetryResult>;
  issueOfPullRequest?: (installationId: number, repositoryId: number, pullRequest: number) => Promise<number | undefined>;
  /** Whether Updraft manages this issue (it has a workflow, or a pause): read from the table, no GitHub call. */
  managedIssue: (installationId: number, repositoryId: number, issue: number) => Promise<boolean>;
  consoleOrigin?: string;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface MentionEvent {
  installationId: number;
  deliveryId: string;
  eventName: string;
  payload: {
    action?: unknown;
    repository?: { id?: unknown; full_name?: unknown };
    sender?: { login?: unknown; type?: unknown };
    issue?: { number?: unknown; pull_request?: unknown; state?: unknown };
    pull_request?: { number?: unknown; head?: { ref?: unknown } };
    comment?: { id?: unknown; body?: unknown; user?: { login?: unknown; type?: unknown }; html_url?: unknown };
  };
}

export interface MentionResult {
  /** For the deliveries list: what became of it. */
  disposition: 'ignored' | 'filtered' | 'deduped' | 'handled';
  reason?: string;
  message?: string;
}

/** The events that can carry a command. */
export const isMentionEvent = (eventName: string, action: string) =>
  (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') && action === 'created';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined);

export function createMentionHandler(d: MentionDeps) {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((entry) => console.log(JSON.stringify(entry)));

  return async function handle(e: MentionEvent): Promise<MentionResult> {
    const p = e.payload;
    if (!isMentionEvent(e.eventName, str(p.action) ?? '')) return { disposition: 'ignored' };
    const body = str(p.comment?.body) ?? '';
    const slug = await d.slug();
    if (!slug) return { disposition: 'ignored', reason: 'no_handle' };
    const parsed = parseControlComment(body, [slug]);
    // Not addressed to the App: nothing at all happens, not even a GitHub call.
    if (parsed.kind === 'none') return { disposition: 'ignored', reason: 'no_command' };
    const login = str(p.comment?.user?.login) ?? str(p.sender?.login) ?? null;
    const actor = { login, type: str(p.comment?.user?.type) ?? str(p.sender?.type) ?? null };
    if (isAutomatedComment(actor, body, [slug])) return { disposition: 'ignored', reason: 'automated' };

    const repository = str(p.repository?.full_name);
    const repositoryId = int(p.repository?.id);
    const commentId = int(p.comment?.id);
    const onPullRequest = e.eventName === 'pull_request_review_comment' || (p.issue?.pull_request !== undefined && p.issue?.pull_request !== null);
    const number = e.eventName === 'pull_request_review_comment' ? int(p.pull_request?.number) : int(p.issue?.number);
    if (!repository || !repositoryId || !commentId || !number) return { disposition: 'ignored', reason: 'malformed' };

    const tenant = await d.store.getTenant(e.installationId, { consistent: true });
    if (!tenant || tenant.status !== 'active' || tenant.activeConfigVersion === undefined) return { disposition: 'filtered', reason: 'tenant_inactive' };
    const config = await d.store.getConfigVersion(e.installationId, tenant.activeConfigVersion, { consistent: true });
    const rules = config?.dispatch?.repositories[repository.toLowerCase()];
    // Not a configured repository (by name and id): left alone, unanswered.
    if (!rules || rules.id !== repositoryId) return { disposition: 'filtered', reason: 'unknown_repo' };

    // Someone the configuration does not let direct work here: nothing is written, GitHub is not
    // asked, and no reply is posted (anyone can comment; no one can make the App answer them).
    const actors = [...new Set([...(rules.actors ?? []), ...rules.triggers.flatMap((t) => t.actors ?? [])])];
    if (!isControlActor(actors, login)) {
      log({ control: 'actor_not_allowed', installationId: e.installationId, repositoryId, commentId });
      return { disposition: 'filtered', reason: 'actor_not_allowed' };
    }

    // Whose workflow, from the table alone: an issue Updraft manages, or a pull request a recorded
    // job of it opened (mapped to its issue). Anything else is left alone before any GitHub call.
    let issue: number | undefined;
    if (onPullRequest) {
      issue = await d.issueOfPullRequest?.(e.installationId, repositoryId, number);
      if (issue === undefined) return { disposition: 'filtered', reason: 'not_managed' };
    } else {
      if (!(await d.managedIssue(e.installationId, repositoryId, number))) return { disposition: 'filtered', reason: 'not_managed' };
      issue = number;
    }
    let pr: Awaited<ReturnType<MentionGitHub['pullRequest']>> | undefined;
    if (onPullRequest) {
      pr = await d.github.pullRequest(e.installationId, repositoryId, repository, number);
      // An Updraft branch of this repository: never a fork's branch that happens to share the name.
      if (!pr.headRef.startsWith(UPDRAFT_BRANCH_PREFIX) || pr.headRepoId !== repositoryId) return { disposition: 'filtered', reason: 'not_updraft_pr' };
    }
    const subjects = [...new Set([issue, onPullRequest ? number : undefined].filter((n): n is number => n !== undefined))];

    const command: ControlCommand = parsed.kind === 'command' ? parsed.command : 'help';
    const record: ControlCommandRecord = {
      installationId: e.installationId, repositoryId, repository, commentId, deliveryId: e.deliveryId.slice(0, 64), actor: login ?? '', command,
      ...(issue !== undefined ? { issue } : {}), ...(onPullRequest ? { pullRequest: number } : {}), receivedAt: new Date(now()).toISOString(),
    };
    // Once per comment, whatever happens next: a redelivery or a replay of it does nothing.
    if (!(await d.store.claimControlCommand(record))) return { disposition: 'deduped', reason: 'command_seen' };

    const by = `github:${login}`;
    const reply = async (message: string) => {
      try {
        await d.github.reply(e.installationId, repositoryId, repository, number, controlReply(commentId, `@${login} ${message}`));
      } catch (error) {
        log({ control: 'reply_failed', installationId: e.installationId, commentId, name: (error as Error)?.name });
      }
    };
    const finish = async (outcome: NonNullable<ControlCommandRecord['outcome']>, message: string, answer = true): Promise<MentionResult> => {
      await d.store.finishControlCommand(record, outcome, message).catch((error: unknown) => log({ control: 'audit_failed', commentId, name: (error as Error)?.name }));
      log({ control: outcome, installationId: e.installationId, repositoryId, commentId, command, actor: login });
      if (answer) await reply(message);
      return { disposition: 'handled', reason: `control_${outcome}`, message: `${command}: ${outcome}` };
    };

    const carryOut = async (): Promise<MentionResult> => {
      const held = async (): Promise<WorkflowPause | null> => {
        for (const s of subjects) {
          const pause = await d.store.getWorkflowPause(e.installationId, repositoryId, s);
          if (pause) return { ...pause, subjects: pause.subjects ?? [s] };
        }
        return null;
      };
      const current = await held();
      const elevated = command === 'resume' && current !== null && current.control?.kind !== 'pause';
      let permission: RepoPermission | null = null;
      if (login) {
        try {
          permission = await d.github.permission(e.installationId, repositoryId, repository, login);
        } catch (error) {
          log({ control: 'permission_unavailable', commentId, name: (error as Error)?.name });
        }
      }
      const decision = controlPolicy({ command, actor, body, ownLogins: [slug], allowedActors: actors, permission, elevated });
      if (!decision.allowed) return finish(decision.respond === 'ignore' ? 'ignored' : 'refused', refusalMessage(decision.reason, command), decision.respond === 'refuse');
      if (parsed.kind !== 'command' || command === 'help') {
        return finish('noop', `${parsed.kind === 'command' ? '' : 'That is not a command I know. '}${controlHelp(slug, { unsupported: CLOUD_UNSUPPORTED })}`);
      }
      if (CLOUD_UNSUPPORTED.includes(command)) {
        return finish('unsupported', `\`${command}\` is not available on Updraft Cloud yet, so nothing was done. Push a commit to have the pull request reviewed, or submit a "Request changes" review with instructions.`);
      }
      const ref = `#${issue ?? number}${onPullRequest && issue !== undefined ? ` (pull request #${number})` : ''}`;
      const workflowId = workflowIdFor(repositoryId, issue !== undefined ? { issue } : { pullRequest: number });
      const link = d.consoleOrigin && workflowId ? ` [Workflow](${new URL(`/installations/${e.installationId}/workflows/${workflowId}`, d.consoleOrigin).href}).` : '';

      // The workflow's active jobs: on one of its subjects.
      const activeJobs = async (): Promise<Job[]> => {
        const out: Job[] = [];
        for (const a of await d.store.listActiveJobs()) {
          if (a.installationId !== e.installationId) continue;
          const job = await d.store.getJob(a.jobId);
          if (!job || job.installationId !== e.installationId || job.repositoryId !== repositoryId || job.status === 'finished') continue;
          if ([job.issue, job.pullRequest, job.workflowIssue].some((n) => n !== undefined && subjects.includes(n))) out.push(job);
        }
        return out;
      };
      const controlPause = (kind: 'pause' | 'cancel'): WorkflowPause => ({
        jobId: `control-${commentId}`, at: now(), by, reason: (parsed.text || `${command} from GitHub`).slice(0, 500), confirmedAt: now(),
        repository, ...(issue !== undefined ? { issue } : {}), ...(onPullRequest ? { pullRequest: number } : {}), control: { kind, source: String(commentId) },
      });
      const cancelQueued = async (): Promise<string[]> => {
        const out: string[] = [];
        for (const s of [issue !== undefined ? { issue } : null, onPullRequest ? { pullRequest: number } : null]) {
          if (!s || !d.queue) continue;
          const entry = await d.queue.waitingFor(e.installationId, repositoryId, s);
          if (entry && (await d.queue.cancel(e.installationId, entry.jobId, by)).ok) out.push(entry.jobId);
        }
        return out;
      };
      const open = onPullRequest ? pr!.state === 'open' : await d.github.issueOpen(e.installationId, repositoryId, repository, number);
      const state = onPullRequest ? (pr!.merged ? 'merged' : pr!.state) : open ? 'open' : 'closed';

      switch (command) {
        case 'pause': {
          if (current) return finish('noop', `${ref} is already paused (by ${current.by}): nothing new starts until it is resumed.${link}`);
          if ((await d.store.pauseWorkflowSubjects(e.installationId, repositoryId, controlPause('pause'), subjects)) === 'held') {
            return finish('noop', `${ref} was paused in the meantime; nothing changed.${link}`);
          }
          const running = await activeJobs();
          const still = running.length ? ` Still running: ${running.map((j) => `job ${j.jobId}`).join(', ')}; it finishes its current step and may still publish it. \`stop\` stops it now.` : '';
          return finish('applied', `Paused ${ref}: nothing new starts until it is resumed; queued work waits and is not started.${still}${link}`);
        }
        case 'stop': {
          if (!d.stopJob) return finish('unsupported', 'Stopping jobs is not configured here, so nothing was done.');
          const running = await activeJobs();
          const target = parsed.target ? running.find((j) => j.jobId === parsed.target) : running.length === 1 ? running[0] : undefined;
          if (parsed.target && !target) return finish('refused', `Job ${parsed.target} is not active for ${ref}, so nothing was stopped.${link}`);
          if (!target && running.length === 0) return finish('noop', `No job is active for ${ref}, so nothing was stopped. \`pause\` or \`cancel\` holds queued work.${link}`);
          if (!target) return finish('ambiguous', `${running.length} jobs are active for ${ref} (${running.map((j) => j.jobId).join(', ')}). Nothing was stopped: name one, e.g. \`stop ${running[0]!.jobId}\`.${link}`);
          const result = await d.stopJob(e.installationId, target.jobId, by, (parsed.text || 'Stopped from GitHub').slice(0, 500));
          if (!result) return finish('refused', `Job ${target.jobId} could not be stopped (it is no longer this installation's).${link}`);
          const said = result.state === 'stopping' ? 'stopping: termination is not confirmed yet' : result.state === 'canceled' ? 'stopped (confirmed)' : 'already finished';
          return finish('applied', `Job ${target.jobId} is ${said}. Its commits and pull request are kept, and ${ref} stays paused until a maintainer resumes it.${link}`);
        }
        case 'cancel': {
          // 1. Hold the workflow first, so nothing is admitted while the rest is ended: a new
          // cancel pause, or the pause in place taken over (a `pause` becomes a cancel, so only a
          // maintainer can lift it).
          const reason = (parsed.text || 'Canceled from GitHub').slice(0, 500);
          let pause = await held();
          if (!pause) {
            await d.store.pauseWorkflowSubjects(e.installationId, repositoryId, controlPause('cancel'), subjects);
            pause = await held();
          } else if (pause.control?.kind === 'pause') {
            if (!(await d.store.setPauseControl(e.installationId, repositoryId, pause, [...new Set([...subjects, ...(pause.subjects ?? [])])], { ...pause.control, kind: 'cancel' }))) {
              return finish('refused', `${ref} changed while it was being canceled; nothing was canceled. Look at it and comment again.${link}`);
            }
          }
          if (!pause) return finish('refused', `${ref} could not be held; nothing was canceled. Comment again.${link}`);
          // 2. Queued work of every subject (one waiting entry per issue or pull request).
          const queued = await cancelQueued();
          // 3. Active jobs. Each stop pauses its subjects as that job's stop; the cancel and every
          // job it stopped are recorded on the pause in place, so resume runs all of them again.
          const stopped: string[] = [];
          const said: string[] = [];
          for (const job of d.stopJob ? await activeJobs() : []) {
            const result = await d.stopJob!(e.installationId, job.jobId, by, reason);
            if (result) { stopped.push(job.jobId); said.push(`${job.jobId} (${result.state})`); }
          }
          if (stopped.length) {
            const now = await held();
            if (now) {
              const prior = now.control?.stopped ?? (now.control ? [] : [now.jobId]);
              await d.store.setPauseControl(e.installationId, repositoryId, now, now.subjects ?? subjects,
                { kind: 'cancel', source: now.control?.source ?? String(commentId), stopped: [...prior.filter((j) => !stopped.includes(j)), ...stopped] });
            }
          }
          return finish('applied',
            `Canceled work on ${ref}:${queued.length ? ` queued ${queued.join(', ')} canceled;` : ''}${said.length ? ` stopping ${said.join(', ')};` : ''} commits and pull requests are kept. Nothing starts until a maintainer resumes it.${link}`);
        }
        case 'resume': {
          if (state !== 'open') return finish('refused', `${ref} is ${state}, so there is nothing to resume. Reopen it and apply the trigger label to start new work.${link}`);
          if (!current) return finish('noop', `${ref} is not paused; nothing to resume.${link}`);
          const outcome = await resumeWorkflowPause(d.store, { installationId: e.installationId, repositoryId, subject: subjects.find((s) => (current.subjects ?? []).includes(s)) ?? subjects[0]!, expected: current, by, at: now() });
          if (outcome === 'stop_pending') return finish('refused', `The stopped job ${current.jobId} is still stopping. Resume once it is confirmed stopped.${link}`);
          if (outcome !== 'resumed') return finish('refused', `${ref} was paused again in the meantime; nothing was resumed.${link}`);
          // Stopped jobs (a stop's, or every job a cancel stopped): each runs again from its own
          // event, through the console's retry (once per job, every current check).
          const toRetry = current.control ? (current.control.stopped ?? []) : [current.jobId];
          if (toRetry.length && d.retry) {
            const again: string[] = [];
            const not: string[] = [];
            for (const jobId of toRetry) {
              const retried = await d.retry({ updraftRetry: { installationId: e.installationId, jobId, by } });
              if (retried.ok) again.push(`job ${retried.jobId} runs the stopped job ${jobId} again`);
              else not.push(`${jobId}: ${retried.message}`);
            }
            return finish('applied', `Resumed ${ref}:${again.length ? ` ${again.join('; ')}, from its own event against the current head; publication never opens a second pull request.` : ' automation continues with the next event.'}${not.length ? ` Not run again: ${not.join('; ')}.` : ''}${link}`);
          }
          return finish('applied', `Resumed ${ref}: automation continues with the next event (a push, a review or the trigger label).${link}`);
        }
        default:
          return finish('unsupported', 'That command is not available here.');
      }
    };

    try {
      return await carryOut();
    } catch (error) {
      // Claimed already, so a redelivery would do nothing: say so, rather than leave the asker waiting.
      log({ control: 'failed', installationId: e.installationId, commentId, name: (error as Error)?.name, message: (error as Error)?.message });
      return finish('refused', 'Updraft could not finish this command (an internal error); part of it may have happened. Check the workflow, then comment again.');
    }
  };
}
