// Dedicated image entrypoint. Tenant storage is attached only AFTER the build snapshot.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './policy.mjs';
import { assertEphemeralHome, startService } from './service.mjs';
import { startBrowserLogin } from './browser-login.mjs';
import { startProbe } from './probe.mjs';
import { cloudConfig, cloudProvider, startCloudWorker } from './cloud.mjs';

export function bootPayload(text) {
  const p = JSON.parse(text);
  if (!p || typeof p !== 'object') throw new Error('invalid storage references');
  const fields = Object.keys(p).filter((key) => key !== 'cloud').sort().join(',');
  const ephemeral = fields === 'storage' && p.storage === 'ephemeral';
  const efs = fields === 'accessPointId,fileSystemId' &&
    typeof p.fileSystemId === 'string' && /^fs-[a-f0-9]{8,40}$/.test(p.fileSystemId) &&
    typeof p.accessPointId === 'string' && /^fsap-[a-f0-9]{8,40}$/.test(p.accessPointId);
  if (!ephemeral && !efs) throw new Error('invalid storage references');
  if (p.cloud !== undefined) cloudConfig(p.cloud);
  return p;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let service;
  let probe;
  let login;
  let cloud;
  let terminating = false;
  let started = false;
  let pending = false;
  // Privileged provider lifecycle interface. Application endpoint tokens MUST exclude
  // port 9000; use endpoint-token.mjs and its deployed gateway probe when provisioning.
  const server = http.createServer((request, response) => {
    let phase = 'dispatch';
    void (async () => {
      const route = request.url;
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      if (['/ready', '/aws/lambda-microvms/runtime/v1/ready'].includes(route)) { response.writeHead(200).end(); return; }
      if (route === '/aws/lambda-microvms/runtime/v1/run') {
        if (started || pending) { response.writeHead(409).end(); return; }
        pending = true;
        try {
          phase = 'boot-payload';
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 16384) throw new Error('oversized lifecycle request');
          }
          const lifecycle = JSON.parse(body);
          const { storage, fileSystemId, accessPointId, cloud: cloudSettings } = bootPayload(lifecycle.runHookPayload);
          const ephemeral = storage === 'ephemeral';
          const storageArgs = ephemeral ? ['--ephemeral'] : [fileSystemId, accessPointId];
          phase = 'credential-storage';
          await new Promise((resolve, reject) => execFile('/bin/sh', ['/opt/updraft/native-worker/mount-home.sh', ...storageArgs],
            { timeout: 45000, maxBuffer: 65536 }, (error, _stdout, stderr) => {
              if (error && ephemeral) {
                const reason = /permission denied|operation not permitted|already exists|not found|wrong fs type/i.exec(stderr)?.[0];
                console.error('Disposable home mount failed' + (reason ? ': ' + reason.toLowerCase() : '.'));
              }
              if (error) reject(error); else resolve();
            }));
          phase = 'worker-config';
          const config = loadConfig('/etc/updraft-native-worker.json');
          phase = 'repository-isolation';
          service = await startService(config, undefined, ephemeral ? assertEphemeralHome : undefined);
          try {
            phase = 'health-listener';
            probe = await startProbe(config);
            if (ephemeral && cloudSettings) { phase = 'browser-login-listener'; login = await startBrowserLogin(config, cloudProvider(cloudSettings)); }
          } catch (error) { await probe?.close(); await service.close(); throw error; }
          if (cloudSettings) {
            phase = 'cloud-registration';
            try { cloud = await startCloudWorker(cloudSettings, lifecycle.microvmId, service); }
            catch (error) { login?.kill(); await probe.close(); await service.close(); throw error; }
          }
          login?.once('exit', () => {
            if (!terminating) { void cloud?.close(); void service.close(); }
          });
          probe.child.once('exit', () => {
            if (!terminating) {
              console.error('Native worker probe listener exited; worker is unavailable.');
              void cloud?.close();
              void service.close();
            }
          });
          started = true;
          response.writeHead(200).end();
        } finally { pending = false; }
        return;
      }
      if (route === '/aws/lambda-microvms/runtime/v1/terminate') {
        terminating = true;
        await cloud?.close();
        login?.kill();
        await probe?.close();
        await service?.close();
        response.writeHead(200).end();
        return;
      }
      // Suspend/resume is deliberately not enabled by the prototype image recipe. EFS
      // reconnection and ongoing-job semantics must be proven before enabling idle policies.
      response.writeHead(503).end();
    })().catch((error) => {
      const reason = error instanceof Error && [
        'native worker namespace probe failed', 'credential lease failed',
        'credential home already leased or lock unavailable', 'credential lock is not a private regular file', 'credential home must be private to the Claude account',
        'credential mount needs a private local parent directory', 'disposable Claude home requires a private tmpfs mount',
        'unexpected mount inside the disposable Claude home', 'probe listener exited before readiness',
      ].includes(error.message) ? error.message : undefined;
      console.error(JSON.stringify({ workerStartup: 'failed', phase, ...(reason ? { reason } : {}) }));
      if (!response.headersSent) response.writeHead(503).end();
    });
  });
  server.listen(9000, '0.0.0.0');
}
