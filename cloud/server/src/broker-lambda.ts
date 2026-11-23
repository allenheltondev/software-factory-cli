import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { createBroker } from './broker/broker.js';
import { createGitHubApi } from './github/client.js';
import { appJwt } from './github/jwt.js';
import { createSettingsLoader, type AppSettings } from './github/settings.js';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from './jobs/kill-switch.js';
import { claudeSignInComment } from './jobs/claude-sign-in.js';
import { throttleCommentPermissions, throttledComment } from './jobs/quotas.js';
import { createDynamoStore } from './store/dynamo.js';
import { createSecretsManagerPort } from './tenants/secrets-manager.js';

/**
 * The job broker's Lambda entry point (dist/broker.mjs, BrokerFunction). Invoked directly
 * (lambda:InvokeFunction) by the runner in a microVM, with its execution role; the event is
 * `{ action, jobId, token, outcome? }` (broker/broker.ts).
 */

const sts = new STSClient({});
const microvms = new LambdaMicrovmsClient({});
const ssm = new SSMClient({});
const roleArn = process.env.JOB_DATA_ROLE_ARN ?? '';
const github = createGitHubApi();
const loadSettings = createSettingsLoader();

/**
 * The App's own token for one repository, allowed only to write issues (and a pull request's
 * conversation). The body is built from the settings: a link needs the console's URL (appUrl).
 */
async function comment(installationId: number, repository: string, repositoryId: number, issue: number, pullRequest: boolean | undefined, body: (settings: AppSettings) => string) {
  const settings = await loadSettings();
  if (!settings) return;
  const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId, {
    repositoryIds: [repositoryId],
    permissions: throttleCommentPermissions(pullRequest),
  });
  await github.createIssueComment(token, repository, issue, body(settings));
}

const handle = createBroker({
  store: createDynamoStore(process.env.TABLE_NAME ?? ''),
  loadSettings,
  github,
  policy: {
    bucket: process.env.TENANT_BUCKET ?? '',
    partition: process.env.PARTITION ?? 'aws',
    region: process.env.AWS_REGION ?? '',
    accountId: process.env.ACCOUNT_ID ?? '',
  },
  killSwitch: createKillSwitch({
    read: async () => {
      try {
        return (await ssm.send(new GetParameterCommand({ Name: process.env.KILL_SWITCH_PARAMETER || KILL_SWITCH_PARAMETER }))).Parameter?.Value ?? null;
      } catch (err) {
        if (err instanceof ParameterNotFound) return null;
        throw err;
      }
    },
  }),
  async assumeRole({ sessionName, policy, durationSeconds }) {
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName, Policy: policy, DurationSeconds: durationSeconds }));
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('AssumeRole returned no credentials');
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration.toISOString() };
  },
  async terminateMicrovm(microvmId) {
    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  },
  async microvmState(microvmId) {
    try {
      return (await microvms.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))).state ?? 'UNKNOWN';
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  },
  async notifyThrottled({ installationId, repository, repositoryId, issue, pullRequest, limit, quotas }) {
    await comment(installationId, repository, repositoryId, issue, pullRequest, () => throttledComment(limit, quotas, pullRequest));
  },
  // The console's URL is the App's own (its GitHub callback is a page of it).
  async notifyClaudeSignIn(notice) {
    await comment(notice.installationId, notice.repository, notice.repositoryId, notice.issue, notice.pullRequest !== undefined, (settings) => claudeSignInComment(notice, settings.appUrl));
  },
  // The token a job's Claude sign-in got: written as the tenant's CLAUDE_CODE_OAUTH_TOKEN.
  secrets: createSecretsManagerPort(),
});

export async function handler(event: unknown) {
  try {
    return await handle(event);
  } catch (err) {
    // Never the details: they could carry a token or a credential.
    console.error(JSON.stringify({ broker: 'error', name: (err as Error)?.name }));
    return { ok: false, error: 'unavailable' };
  }
}
