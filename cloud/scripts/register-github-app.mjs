#!/usr/bin/env node
// Registers the Updraft GitHub App for one deployment (once per environment) with GitHub's App
// manifest flow, and stores what GitHub returns where the API reads it (server/src/github/settings.ts):
//
//   SSM             /updraft/app/id, /updraft/app/client-id, /updraft/app/slug, /updraft/app/url
//   Secrets Manager updraft/app/private-key, updraft/app/client-secret, updraft/app/webhook-secret
//
// Run it on your own machine, with AWS credentials for the target account and region:
//
//   node scripts/register-github-app.mjs --app-url https://updraft.readysetcloud.io [--org <github org>]
//     [--name Updraft] [--region us-east-1] [--port 3999] [--replace]
//
// It serves a page on http://127.0.0.1:<port> that posts the manifest to GitHub. You review it and
// press "Create GitHub App" on github.com; GitHub sends the browser back with a one-time code,
// which this script exchanges for the App's id, key and secrets, and writes straight to AWS. The
// secrets are never printed. --replace is required to overwrite an App that is already stored
// (it would cut the deployment off from the old App).

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SSM_PREFIX = '/updraft/app/';
export const SECRET_PREFIX = 'updraft/app/';

/** The App's manifest. Its permissions and events are the ones docs/github-app.md and #64 list. */
export function manifest({ appUrl, name, port }) {
  const base = appUrl.replace(/\/+$/, '');
  return {
    name,
    url: base,
    description: 'Label a GitHub issue and Updraft hands it to a coding agent that opens a draft pull request.',
    hook_attributes: { url: `${base}/api/webhooks/github`, active: true },
    redirect_url: `http://127.0.0.1:${port}/done`,
    callback_urls: [`${base}/github/callback`],
    // With request_oauth_on_install GitHub sends installs to the callback URL (with a code), and
    // uses the setup URL only for updates; both are the same SPA route.
    setup_url: `${base}/github/callback`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: true,
    default_permissions: {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      checks: 'read',
      statuses: 'read',
      // Organization permission: lets a user's token read their own org membership, which is how
      // Updraft checks that whoever connects an org installation is an owner of that org.
      members: 'read',
    },
    // installation and installation_repositories are delivered to every App without subscribing.
    default_events: ['issues', 'pull_request', 'pull_request_review'],
  };
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function startPage({ manifestJson, org, state }) {
  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;
  return `<!doctype html><meta charset="utf-8"><title>Register the Updraft GitHub App</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
<h1>Register the Updraft GitHub App</h1>
<p>This sends the App's manifest to GitHub${org ? ` for the <b>${escapeHtml(org)}</b> organization` : ''}. Review it there and press <b>Create GitHub App</b>.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
<button type="submit" style="font-size:1.1rem;padding:.5rem 1rem">Continue to GitHub</button>
</form>
<details><summary>Manifest</summary><pre>${escapeHtml(JSON.stringify(JSON.parse(manifestJson), null, 2))}</pre></details>
</body>`;
}

async function aws(region) {
  const { SSMClient, GetParameterCommand, PutParameterCommand } = await import('@aws-sdk/client-ssm');
  const { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const ssm = new SSMClient(region ? { region } : {});
  const secrets = new SecretsManagerClient(region ? { region } : {});
  return {
    async existingAppId() {
      try {
        return (await ssm.send(new GetParameterCommand({ Name: `${SSM_PREFIX}id` }))).Parameter?.Value;
      } catch (err) {
        if (err.name === 'ParameterNotFound') return undefined;
        throw err;
      }
    },
    async putParameter(name, value) {
      await ssm.send(new PutParameterCommand({ Name: `${SSM_PREFIX}${name}`, Value: value, Type: 'String', Overwrite: true }));
    },
    async putSecret(name, value) {
      const SecretId = `${SECRET_PREFIX}${name}`;
      try {
        await secrets.send(new PutSecretValueCommand({ SecretId, SecretString: value }));
      } catch (err) {
        if (err.name !== 'ResourceNotFoundException') throw err;
        await secrets.send(new CreateSecretCommand({ Name: SecretId, SecretString: value, Description: 'Updraft Cloud GitHub App' }));
      }
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'app-url': { type: 'string' },
      org: { type: 'string' },
      name: { type: 'string', default: 'Updraft' },
      region: { type: 'string' },
      port: { type: 'string', default: '3999' },
      replace: { type: 'boolean', default: false },
    },
  });
  const appUrl = values['app-url'];
  if (!appUrl || !/^https:\/\/[^/]+$/.test(appUrl.replace(/\/+$/, ''))) {
    console.error('register-github-app: --app-url must be the deployment origin, e.g. https://updraft.readysetcloud.io');
    process.exit(2);
  }
  const port = Number(values.port);
  const store = await aws(values.region);
  const existing = await store.existingAppId();
  if (existing && !values.replace) {
    console.error(`register-github-app: App ${existing} is already stored for this account; pass --replace to register a new one.`);
    process.exit(2);
  }

  const state = randomBytes(16).toString('hex');
  const manifestJson = JSON.stringify(manifest({ appUrl, name: values.name, port }));

  await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(startPage({ manifestJson, org: values.org, state }));
        return;
      }
      if (url.pathname !== '/done') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || !code || !/^[\w-]+$/.test(code)) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('This response did not come from the registration this script started.');
        return;
      }
      try {
        const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
          method: 'POST',
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'updraft-cloud-register' },
        });
        if (!r.ok) throw new Error(`GitHub refused the manifest code (${r.status})`);
        const app = await r.json();
        await store.putSecret('private-key', app.pem);
        await store.putSecret('client-secret', app.client_secret);
        await store.putSecret('webhook-secret', app.webhook_secret);
        await store.putParameter('client-id', app.client_id);
        await store.putParameter('slug', app.slug);
        await store.putParameter('url', appUrl.replace(/\/+$/, ''));
        // The id last: the API treats the App as configured only once every value is there.
        await store.putParameter('id', String(app.id));
        const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">
<h1>Registered ${escapeHtml(app.slug)}</h1><p>Its key and secrets are stored in AWS. You can close this tab and open
<a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a> to connect GitHub.</p></body>`,
        );
        console.log(`register-github-app: registered App ${app.id} (${app.slug}): ${app.html_url}`);
        console.log(`register-github-app: stored under ${SSM_PREFIX}* and ${SECRET_PREFIX}*; install it from ${appUrl} (or ${installUrl})`);
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end('Registration failed; see the terminal.');
        server.close();
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`register-github-app: open http://127.0.0.1:${port}/ in your browser to continue`);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`register-github-app: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
