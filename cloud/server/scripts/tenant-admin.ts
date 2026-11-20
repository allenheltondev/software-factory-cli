// Admin commands for Updraft Cloud tenants, until the console has them (#69 config, #70 keys).
// Run with AWS credentials for the stack's account:
//
//   npm run tenant-admin --workspace=server -- config publish --installation 55 --file tenant.yaml [--prompts ./prompts]
//   npm run tenant-admin --workspace=server -- config list    --installation 55
//   npm run tenant-admin --workspace=server -- key set        --installation 55 --name ANTHROPIC_API_KEY   (value on stdin)
//   npm run tenant-admin --workspace=server -- key status     --installation 55
//   npm run tenant-admin --workspace=server -- limits show    --installation 55
//   npm run tenant-admin --workspace=server -- limits set     --installation 55 [--concurrent-jobs 2] [--jobs-per-day 50] [--minutes-per-month 3000]
//   npm run tenant-admin --workspace=server -- limits clear   --installation 55
//
//   [--stack updraft-cloud] [--region us-east-1] on any of them
//
// `config publish` compiles the tenant's config with what the platform enforces, validates it
// with the worker's own validator, checks every repository against what the installation can
// reach (with the App's own credentials), stores it as a new immutable version and activates it.
// `key set` reads the key from stdin, never from the command line, and never prints it.
// `limits` overrides the stack's default quotas for one tenant (jobs/quotas.ts): `set` changes
// only the limits it is given, `clear` goes back to the defaults, `show` prints both and the usage.
import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { CreateSecretCommand, DeleteSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { parse } from 'yaml';
import { createGitHubApi } from '../src/github/client.js';
import { appJwt } from '../src/github/jwt.js';
import { createSettingsLoader } from '../src/github/settings.js';
import { dayOf, DEFAULT_QUOTAS, limitProblems, monthOf, tenantQuotas } from '../src/jobs/quotas.js';
import type { Quotas, TenantLimits } from '../src/store/store.js';
import { createDynamoStore } from '../src/store/dynamo.js';
import { AGENT_KEY_NAMES, setAgentKey, type SecretsPort } from '../src/tenants/agent-keys.js';
import { publishTenantConfig } from '../src/tenants/publish.js';
import { createAdminClients, type AdminClients } from './admin-clients.js';

const usage = `usage: tenant-admin <config publish|config list|key set|key status|limits show|limits set|limits clear> --installation <id> [options]`;

async function describeStack(clients: AdminClients, stack: string): Promise<{ outputs: Record<string, string>; parameters: Record<string, string> }> {
  const out = await clients.cloudFormation.send(new DescribeStacksCommand({ StackName: stack }));
  const s = out.Stacks?.[0];
  return {
    outputs: Object.fromEntries((s?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? ''])),
    parameters: Object.fromEntries((s?.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue ?? ''])),
  };
}

/** The stack's default quotas, from its parameters (template.yaml). */
function stackQuotas(parameters: Record<string, string>): Quotas {
  const n = (name: string, fallback: number) => (Number.isInteger(Number(parameters[name])) && Number(parameters[name]) > 0 ? Number(parameters[name]) : fallback);
  return {
    concurrentJobs: n('QuotaConcurrentJobs', DEFAULT_QUOTAS.concurrentJobs),
    jobsPerDay: n('QuotaJobsPerDay', DEFAULT_QUOTAS.jobsPerDay),
    microvmMinutesPerMonth: n('QuotaMicrovmMinutesPerMonth', DEFAULT_QUOTAS.microvmMinutesPerMonth),
    platformConcurrentJobs: n('PlatformConcurrentJobs', DEFAULT_QUOTAS.platformConcurrentJobs),
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('Paste the key, then press Enter (it is not shown): ');
    process.stdin.setRawMode(true);
    return new Promise((resolve) => {
      let value = '';
      process.stdin.on('data', (chunk: Buffer) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stderr.write('\n');
            resolve(value);
            return;
          }
          if (ch === '\u0003') process.exit(130);
          value += ch;
        }
      });
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      installation: { type: 'string' },
      file: { type: 'string' },
      prompts: { type: 'string' },
      name: { type: 'string' },
      'concurrent-jobs': { type: 'string' },
      'jobs-per-day': { type: 'string' },
      'minutes-per-month': { type: 'string' },
      stack: { type: 'string', default: 'updraft-cloud' },
      region: { type: 'string' },
    },
  });
  const [area, command] = positionals;
  const installationId = Number(values.installation);
  if (!area || !command || !Number.isSafeInteger(installationId) || installationId <= 0) throw new Error(usage);
  // One region for every client (admin-clients.ts): --region, else the SDK's own resolution.
  const clients = createAdminClients(values.region);
  const { outputs, parameters } = await describeStack(clients, values.stack!);
  if (!outputs.TableName || !outputs.TenantBucket) throw new Error(`stack ${values.stack} has no TableName/TenantBucket outputs; deploy it first`);
  const store = createDynamoStore(outputs.TableName, clients.dynamo);
  const tenant = await store.getTenant(installationId);
  if (!tenant) throw new Error(`there is no tenant for installation ${installationId}; connect it from the console first`);
  const admin = `admin:${userInfo().username}`;

  if (area === 'config' && command === 'list') {
    for (const v of await store.listConfigVersions(installationId)) {
      const active = v.version === tenant.activeConfigVersion ? '  (active)' : '';
      console.log(`${v.version}\t${v.status}\t${v.publishedAt}\t${v.publishedBy}\t${v.sha256.slice(0, 12)}${active}`);
    }
    return;
  }

  if (area === 'config' && command === 'publish') {
    if (!values.file) throw new Error('config publish needs --file <tenant config YAML>');
    const config = parse(readFileSync(values.file, 'utf8')) as unknown;
    const prompts: Record<string, string> = {};
    if (values.prompts) for (const f of readdirSync(values.prompts)) if (f.endsWith('.md')) prompts[f] = readFileSync(join(values.prompts, f), 'utf8');

    // The repositories the installation reaches, as the App sees them (not as anyone claims).
    const settings = await createSettingsLoader({ ssm: clients.ssm, secrets: clients.secrets })();
    if (!settings) throw new Error('the Updraft GitHub App is not registered for this account (scripts/register-github-app.mjs)');
    const github = createGitHubApi();
    const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey), installationId);
    const repositoryIds = new Map((await github.listInstallationRepositories(token)).map((r) => [r.fullName.toLowerCase(), r.id]));

    const result = await publishTenantConfig(
      { installationId, submission: { config, prompts }, platform: { appId: Number(settings.appId) }, repositoryIds, publishedBy: admin },
      { store, putObject: async (key, body, contentType) => void (await clients.s3.send(new PutObjectCommand({ Bucket: outputs.TenantBucket, Key: key, Body: body, ContentType: contentType }))) },
    );
    if (!result.ok) {
      if (result.reason === 'invalid') for (const e of result.errors) console.error(`  ✗ ${e.path}: ${e.message}`);
      else console.error(`  ✗ ${result.message}`);
      process.exitCode = 1;
      return;
    }
    for (const w of result.warnings) console.error(`  ! ${w.path}: ${w.message}`);
    console.log(`published and activated version ${result.version} for installation ${installationId} (${tenant.accountLogin})`);
    return;
  }

  if (area === 'key' && command === 'status') {
    const meta = new Map((await store.listAgentKeyMeta(installationId)).map((m) => [m.name, m]));
    for (const name of AGENT_KEY_NAMES) {
      const m = meta.get(name);
      console.log(`${name}\t${m ? `set ${m.updatedAt} by ${m.updatedBy}` : 'not set'}`);
    }
    return;
  }

  if (area === 'key' && command === 'set') {
    if (!values.name) throw new Error(`key set needs --name (${AGENT_KEY_NAMES.join(' or ')})`);
    const client = clients.secrets;
    const secrets: SecretsPort = {
      async remove(name) {
        try {
          await client.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }));
        } catch (err) {
          if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
        }
      },
      async put(name, value, tags) {
        try {
          await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
        } catch (err) {
          if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
          await client.send(
            new CreateSecretCommand({ Name: name, SecretString: value, Description: 'Updraft Cloud tenant agent keys', Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }),
          );
        }
      },
    };
    const result = await setAgentKey({ installationId, name: values.name, value: await readStdin(), updatedBy: admin }, { secrets, store });
    if (!result.ok) {
      console.error(`  ✗ ${result.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${values.name} set for installation ${installationId} (${tenant.accountLogin})`);
    return;
  }

  if (area === 'limits' && command === 'show') {
    const defaults = stackQuotas(parameters);
    const effective = tenantQuotas(defaults, tenant.limits);
    const now = Date.now();
    const used = await store.getUsage(installationId, dayOf(now), monthOf(now));
    const row = (label: string, name: keyof TenantLimits, unit: string, value: string) =>
      console.log(`${label}\t${effective[name]}${unit}${tenant.limits?.[name] !== undefined ? ' (override)' : ' (default)'}\t${value}`);
    console.log(`installation ${installationId} (${tenant.accountLogin}), ${tenant.status}`);
    row('concurrent jobs', 'concurrentJobs', '', '');
    row('jobs per day', 'jobsPerDay', '', `${used.jobsToday} today (${used.day}, UTC)`);
    row('microVM time', 'microvmMinutesPerMonth', ' min/month', `${Math.ceil(used.microvmSecondsThisMonth / 60)} min in ${used.month}, ${used.jobsThisMonth} jobs`);
    console.log(`throttled\t\t${used.throttledThisMonth} in ${used.month}`);
    console.log(`platform ceiling\t${defaults.platformConcurrentJobs} concurrent jobs`);
    return;
  }

  if (area === 'limits' && command === 'set') {
    const given: TenantLimits = {};
    const read = (flag: 'concurrent-jobs' | 'jobs-per-day' | 'minutes-per-month', name: keyof TenantLimits) => {
      if (values[flag] !== undefined) given[name] = Number(values[flag]);
    };
    read('concurrent-jobs', 'concurrentJobs');
    read('jobs-per-day', 'jobsPerDay');
    read('minutes-per-month', 'microvmMinutesPerMonth');
    if (Object.keys(given).length === 0) throw new Error('limits set needs --concurrent-jobs, --jobs-per-day or --minutes-per-month');
    const problems = limitProblems(given);
    if (problems.length > 0) throw new Error(problems.join('; '));
    const limits = { ...tenant.limits, ...given };
    if ((await store.setTenantLimits(installationId, limits)) === 'no_tenant') throw new Error(`there is no tenant for installation ${installationId}`);
    console.log(`limits for installation ${installationId} (${tenant.accountLogin}): ${JSON.stringify(limits)}, set by ${admin}`);
    return;
  }

  if (area === 'limits' && command === 'clear') {
    await store.setTenantLimits(installationId, null);
    console.log(`installation ${installationId} (${tenant.accountLogin}) is back on the stack's default quotas`);
    return;
  }

  throw new Error(usage);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
