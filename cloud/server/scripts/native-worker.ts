import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GetMicrovmCommand, LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { nativeRoute } from '../src/native/route.js';

// Launches a bounded signed-out worker and prints only the stack binding.
async function launch(file: string, broker: string, region: string) {
  const plan = JSON.parse(await readFile(file, 'utf8'));
  const route = nativeRoute(JSON.stringify({
    installationId: plan.installationId, workerId: plan.workerId, imageVersion: plan.imageVersion,
    controlSecretArn: plan.controlSecretArn, microvmId: 'mvm-pending',
  }))!;
  const arn = /^arn:[\w-]+:lambda:[\w-]+:\d{12}:microvm-image:[\w-]+$/;
  const role = /^arn:[\w-]+:iam::\d{12}:role\/[\w+=,.@/-]+$/;
  if (!arn.test(plan.imageArn ?? '') || !role.test(plan.executionRoleArn ?? '') ||
      !/^[\w-]{8,64}$/.test(plan.session ?? '') || !/^[\w:-]{1,200}$/.test(broker) ||
      !/^[\w-]+-\d$/.test(region) || (plan.previousMicrovmId !== undefined && !/^mvm-[\w-]+$/.test(plan.previousMicrovmId))) {
    throw new Error('invalid disposable worker references');
  }
  const client = new LambdaMicrovmsClient({ region });
  if (plan.previousMicrovmId) {
    try {
      const previous = await client.send(new GetMicrovmCommand({ microvmIdentifier: plan.previousMicrovmId }));
      if (previous.state !== 'TERMINATED') throw new Error('previous worker still exists');
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
    }
  }
  const partition = plan.imageArn.split(':')[1];
  const connectors = `arn:${partition}:lambda:${region}:aws:network-connector:aws-network-connector:`;
  const runHookPayload = JSON.stringify({ storage: 'ephemeral', cloud: {
    region, brokerFunctionName: broker, workerId: route.workerId, imageVersion: route.imageVersion,
    workerVersion: 'browser-login-1', controlSecretArn: route.controlSecretArn,
  } });
  const result = await client.send(new RunMicrovmCommand({
    imageIdentifier: plan.imageArn, imageVersion: route.imageVersion,
    executionRoleArn: plan.executionRoleArn, maximumDurationInSeconds: 8 * 60 * 60,
    clientToken: createHash('sha256').update(JSON.stringify([plan.session, plan.imageArn, plan.executionRoleArn, runHookPayload])).digest('hex'),
    ingressNetworkConnectors: [connectors + 'HTTP_INGRESS'], egressNetworkConnectors: [connectors + 'INTERNET_EGRESS'],
    runHookPayload,
  }));
  if (!result.microvmId) throw new Error('AWS did not return the worker ID');
  console.log(JSON.stringify({ ...route, microvmId: result.microvmId }, null, 2));
}

// Operator tooling only. The route file contains references, never a Claude credential.
// Run from cloud/: npx tsx server/scripts/native-worker.ts status route.json BROKER REGION
async function main() {
  const [op, file, broker, region, jobId] = process.argv.slice(2);
  if (op === 'launch' && file && broker && region && !jobId) return launch(file, broker, region);
  if (!['status', 'cancel'].includes(op ?? '') || !file || !broker || !region || (op === 'cancel' && !/^job_[\w-]{16}$/.test(jobId ?? ''))) {
    throw new Error('usage: native-worker.ts launch PLAN.json BROKER REGION or status|cancel ROUTE.json BROKER REGION [JOB_ID]');
  }
  const route = nativeRoute(await readFile(file, 'utf8'));
  if (!route) throw new Error('a native worker test route is required');
  const secrets = new SecretsManagerClient({ region });
  const token = (await secrets.send(new GetSecretValueCommand({ SecretId: route.controlSecretArn }))).SecretString;
  if (!token || token.length < 32) throw new Error('worker control credential unavailable');
  const lambda = new LambdaClient({ region });
  const response = await lambda.send(new InvokeCommand({ FunctionName: broker,
    Payload: Buffer.from(JSON.stringify({ action: 'worker', op, workerId: route.workerId, token, ...(jobId ? { jobId } : {}) })) }));
  if (response.FunctionError) throw new Error('worker broker unavailable');
  const result = JSON.parse(Buffer.from(response.Payload ?? []).toString('utf8'));
  if (!result?.ok) throw new Error('worker broker refused operation');
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error instanceof Error && error.message.startsWith('usage:') ? error.message : 'Native worker operation failed; check operator permissions, worker lifecycle state, and route references.'); process.exitCode = 1; });
