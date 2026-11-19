// Admin commands for Updraft Cloud tenants, until the console has them (#69 config, #70 keys).
// Run with AWS credentials for the stack's account:
//
//   npm run tenant-admin --workspace=server -- config publish --installation 55 --file tenant.yaml [--prompts ./prompts]
//   npm run tenant-admin --workspace=server -- config list    --installation 55
//   npm run tenant-admin --workspace=server -- key set        --installation 55 --name ANTHROPIC_API_KEY   (value on stdin)
//   npm run tenant-admin --workspace=server -- key status     --installation 55
//
//   [--stack updraft-cloud] [--region us-east-1] on any of them
//
// `config publish` compiles the tenant's config with what the platform enforces, validates it
// with the worker's own validator, checks every repository against what the installation can
// reach (with the App's own credentials), stores it as a new immutable version and activates it.
// `key set` reads the key from stdin, never from the command line, and never prints it.
import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { parse } from 'yaml';
import { createGitHubApi } from '../src/github/client.js';
import { appJwt } from '../src/github/jwt.js';
import { createSettingsLoader } from '../src/github/settings.js';
import { createDynamoStore } from '../src/store/dynamo.js';
import { AGENT_KEY_NAMES, setAgentKey, type SecretsPort } from '../src/tenants/agent-keys.js';
import { publishTenantConfig } from '../src/tenants/publish.js';

const usage = `usage: tenant-admin <config publish|config list|key set|key status> --installation <id> [options]`;

async function stackOutputs(stack: string, region: string | undefined): Promise<Record<string, string>> {
  const cf = new CloudFormationClient(region ? { region } : {});
  const out = await cf.send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries((out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
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
      stack: { type: 'string', default: 'updraft-cloud' },
      region: { type: 'string' },
    },
  });
  const [area, command] = positionals;
  const installationId = Number(values.installation);
  if (!area || !command || !Number.isSafeInteger(installationId) || installationId <= 0) throw new Error(usage);
  const region = values.region ?? process.env.AWS_REGION;
  const outputs = await stackOutputs(values.stack!, region);
  if (!outputs.TableName || !outputs.TenantBucket) throw new Error(`stack ${values.stack} has no TableName/TenantBucket outputs; deploy it first`);
  const store = createDynamoStore(outputs.TableName);
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
    const settings = await createSettingsLoader()();
    if (!settings) throw new Error('the Updraft GitHub App is not registered for this account (scripts/register-github-app.mjs)');
    const github = createGitHubApi();
    const { token } = await github.createInstallationToken(appJwt(settings.appId, settings.privateKey), installationId);
    const repositoryIds = new Map((await github.listInstallationRepositories(token)).map((r) => [r.fullName.toLowerCase(), r.id]));

    const s3 = new S3Client(region ? { region } : {});
    const result = await publishTenantConfig(
      { installationId, submission: { config, prompts }, platform: { appId: Number(settings.appId) }, repositoryIds, publishedBy: admin },
      { store, putObject: async (key, body, contentType) => void (await s3.send(new PutObjectCommand({ Bucket: outputs.TenantBucket, Key: key, Body: body, ContentType: contentType }))) },
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
    const client = new SecretsManagerClient(region ? { region } : {});
    const secrets: SecretsPort = {
      async get(name) {
        try {
          return (await client.send(new GetSecretValueCommand({ SecretId: name }))).SecretString ?? undefined;
        } catch (err) {
          if ((err as { name?: string }).name === 'ResourceNotFoundException') return undefined;
          throw err;
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

  throw new Error(usage);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
