import type { ClaudeSignInNotice } from '../broker/broker.js';

/**
 * What the broker posts on the issue when a job signs in to Claude (the runner's
 * claude-sign-in.mjs): a link to the console page where a member opens claude.ai and gives the
 * code, never the claude.ai URL itself (it is shown to members only), or why it failed.
 */

/** The console page a member signs in from (cloud/app, ClaudeSignInPage). */
export function claudeSignInPage(appUrl: string, installationId: number, jobId: string): string {
  return `${appUrl.replace(/\/+$/, '')}/installations/${installationId}/claude-sign-in/${encodeURIComponent(jobId)}`;
}

/** How long the runner waits for a code (claude-sign-in.mjs, codeTimeoutMs). */
export const SIGN_IN_WAIT_MINUTES = 15;

export function claudeSignInComment(notice: ClaudeSignInNotice, appUrl: string): string {
  const keys = `${appUrl.replace(/\/+$/, '')}/installations/${notice.installationId}/keys`;
  if (notice.kind === 'needed') {
    return [
      '**Claude needs a sign-in to run this job.** This installation has no working Claude credential, so the job is waiting for a member to sign in with a Claude Pro or Max subscription.',
      '',
      `1. Open **[Sign in to Claude](${claudeSignInPage(appUrl, notice.installationId, notice.jobId)})** in Updraft Cloud (members of the installation only).`,
      '2. Sign in to Claude from there, and copy the code it shows.',
      '3. Paste the code on that page. The job then goes on by itself, and later jobs reuse the sign-in.',
      '',
      `The job waits ${SIGN_IN_WAIT_MINUTES} minutes. To use API credits instead, add an \`ANTHROPIC_API_KEY\` under [Agent keys](${keys}) and apply the label again.`,
    ].join('\n');
  }
  return [
    `**The Claude sign-in did not finish:** ${notice.reason ?? 'no code was given'}. Nothing was run.`,
    '',
    `Apply the label again to start a new sign-in, or add an \`ANTHROPIC_API_KEY\` under [Agent keys](${keys}).`,
  ].join('\n');
}
