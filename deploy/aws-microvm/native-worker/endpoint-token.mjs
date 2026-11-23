#!/usr/bin/env node
// Operator-side provisioning helper, not part of Claude authentication. Never log tokens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const HOOK_PORT = 9000;

export function endpointPorts(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error('explicit application ports required');
  return value.map((entry) => {
    if (!entry || Object.keys(entry).join(',') !== 'port' || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || entry.port === HOOK_PORT) {
      throw new Error('endpoint tokens must use explicit ports excluding the lifecycle port; ranges and allPorts are forbidden');
    }
    return { port: entry.port };
  });
}

export function tokenArgs(microvmId, ports) {
  if (typeof microvmId !== 'string' || !/^mvm-[A-Za-z0-9-]{1,100}$/.test(microvmId)) throw new Error('invalid MicroVM identifier');
  return ['lambda-microvms', 'create-microvm-auth-token', '--microvm-identifier', microvmId,
    '--expiration-in-minutes', '15', '--allowed-ports', JSON.stringify(endpointPorts(ports)), '--output', 'json'];
}

export async function verifyHookPort(endpoint, token, applicationPort, fetcher = globalThis.fetch) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('expected the HTTPS MicroVM endpoint origin');
  endpointPorts([{ port: applicationPort }]);
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('missing endpoint token');
  const headers = (port) => ({ 'X-aws-proxy-auth': token, 'X-aws-proxy-port': String(port) });
  const options = { redirect: 'error', signal: globalThis.AbortSignal.timeout(10000) };
  // A denied/expired token proves nothing. First establish access on the granted port.
  const application = await fetcher(url.origin, { ...options, headers: headers(applicationPort) });
  await application.body?.cancel();
  if (application.status < 200 || application.status >= 500 || [401, 403].includes(application.status)) throw new Error('cannot establish access to the permitted application port');
  // Empty payload cannot mount storage even if the hook was accidentally exposed.
  const hook = await fetcher(`${url.origin}/aws/lambda-microvms/runtime/v1/run`, {
    ...options, method: 'POST', headers: { ...headers(HOOK_PORT), 'Content-Type': 'application/json' }, body: '{}',
  });
  await hook.body?.cancel();
  if (![401, 403].includes(hook.status)) throw new Error('lifecycle port is reachable through an application endpoint token');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--verify') {
      const token = JSON.parse(fs.readFileSync(process.argv[5], 'utf8')).authToken?.['X-aws-proxy-auth'];
      await verifyHookPort(process.argv[3], token, Number(process.argv[4]));
      console.log('Application endpoint access verified; lifecycle port denied.');
    } else {
      const args = tokenArgs(process.argv[2], JSON.parse(process.argv[3]));
      const result = spawnSync('aws', args, { stdio: 'inherit', shell: false });
      process.exitCode = result.status ?? 1;
    }
  } catch {
    console.error('Endpoint token provisioning or lifecycle-port verification failed.');
    process.exitCode = 1;
  }
}
