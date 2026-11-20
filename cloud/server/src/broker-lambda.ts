import { LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { createBroker } from './broker/broker.js';
import { createGitHubApi } from './github/client.js';
import { createSettingsLoader } from './github/settings.js';
import { createDynamoStore } from './store/dynamo.js';

/**
 * The job broker's Lambda entry point (dist/broker.mjs, BrokerFunction). Invoked directly
 * (lambda:InvokeFunction) by the runner in a microVM, with its execution role; the event is
 * `{ action, jobId, token, outcome? }` (broker/broker.ts).
 */

const sts = new STSClient({});
const microvms = new LambdaMicrovmsClient({});
const roleArn = process.env.JOB_DATA_ROLE_ARN ?? '';

const handle = createBroker({
  store: createDynamoStore(process.env.TABLE_NAME ?? ''),
  loadSettings: createSettingsLoader(),
  github: createGitHubApi(),
  policy: {
    bucket: process.env.TENANT_BUCKET ?? '',
    partition: process.env.PARTITION ?? 'aws',
    region: process.env.AWS_REGION ?? '',
    accountId: process.env.ACCOUNT_ID ?? '',
  },
  async assumeRole({ sessionName, policy, durationSeconds }) {
    const out = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName, Policy: policy, DurationSeconds: durationSeconds }));
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('AssumeRole returned no credentials');
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration.toISOString() };
  },
  async terminateMicrovm(microvmId) {
    await microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  },
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
