import { createDynamoWorkflowStore } from './workflows/store.js';
import { createWorkflowRecorder } from './workflows/recorder.js';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetMicrovmCommand, LambdaMicrovmsClient, ResourceNotFoundException, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { createBroker } from './broker/broker.js';
import { createGitHubApi } from './github/client.js';
import { appJwt } from './github/jwt.js';
import { createSettingsLoader } from './github/settings.js';
import { createKillSwitch, KILL_SWITCH_PARAMETER } from './jobs/kill-switch.js';
import { throttleCommentPermissions, throttledComment } from './jobs/quotas.js';
import { createDynamoStore } from './store/dynamo.js';
import { nativeAws } from './native/aws.js';

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

const store = createDynamoStore(process.env.TABLE_NAME ?? '');
const killSwitch = createKillSwitch({ read: async () => {
  try { return (await ssm.send(new GetParameterCommand({ Name: process.env.KILL_SWITCH_PARAMETER || KILL_SWITCH_PARAMETER }))).Parameter?.Value ?? null; }
  catch (e) { if (e instanceof ParameterNotFound) return null; throw e; }
} });
const nativeWorker = nativeAws(store, () => killSwitch.engaged());
const native = nativeWorker.control;
const webhook = new LambdaClient({});
const handle = createBroker({
  store,
  workflows: createWorkflowRecorder({ store: createDynamoWorkflowStore(process.env.TABLE_NAME ?? '') }),
  native,
  loadSettings,
  github,
  policy: {
    bucket: process.env.TENANT_BUCKET ?? '',
    partition: process.env.PARTITION ?? 'aws',
    region: process.env.AWS_REGION ?? '',
    accountId: process.env.ACCOUNT_ID ?? '',
  },
  killSwitch,
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
  // The App's own token for that one repository, allowed only to write issues (and a pull request's conversation).
  async notifyThrottled({ installationId, repository, repositoryId, issue, pullRequest, limit, quotas }) {
    const settings = await loadSettings();
    if (!settings) return;
    const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey, Date.now()), installationId, {
      repositoryIds: [repositoryId],
      permissions: throttleCommentPermissions(pullRequest),
    });
    await github.createIssueComment(token, repository, issue, throttledComment(limit, quotas, pullRequest));
  },
});

export async function handler(event: unknown) {
  try {
    if (event && typeof event === 'object' && (event as { action?: unknown }).action === 'worker') {
      const result = await native.handle(event);
      const message = event as { workerId?: string; auth?: string; op?: string };
      const id = Number(/^managed-([1-9]\d*)$/.exec(message.workerId ?? '')?.[1]);
      const sessions = nativeWorker.managed?.sessions;
      if (result.ok === true && message.op === 'poll' && message.auth === 'connected' && Number.isSafeInteger(id) &&
          sessions && process.env.CLAUDE_WEBHOOK_PARAMETER) {
        try {
          if (!(await sessions.pending(id)).length) return result;
          const name = (await ssm.send(new GetParameterCommand({ Name: process.env.CLAUDE_WEBHOOK_PARAMETER }))).Parameter?.Value;
          if (name) await webhook.send(new InvokeCommand({ FunctionName: name, InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ action: 'resumeClaude', installationId: id })) }));
        } catch { console.error('Could not schedule a waiting Claude job; the next worker poll retries'); }
      }
      return result;
    }
    return await handle(event);
  } catch (err) {
    // Never the details: they could carry a token or a credential.
    console.error(JSON.stringify({ broker: 'error', name: (err as Error)?.name }));
    return { ok: false, error: 'unavailable' };
  }
}
