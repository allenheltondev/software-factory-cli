// Dedicated image entrypoint. Tenant storage is attached only AFTER the build snapshot.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './policy.mjs';
import { startService } from './service.mjs';

export function bootPayload(text) {
  const p = JSON.parse(text);
  if (!p || Object.keys(p).sort().join(',') !== 'accessPointId,fileSystemId' ||
      !/^fs-[a-f0-9]{8,40}$/.test(p.fileSystemId) || !/^fsap-[a-f0-9]{8,40}$/.test(p.accessPointId)) throw new Error('invalid storage references');
  return p;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let service;
  let started = false;
  let pending = false;
  // Privileged provider lifecycle interface. Application endpoint tokens MUST exclude
  // port 9000; use endpoint-token.mjs and its deployed gateway probe when provisioning.
  const server = http.createServer((request, response) => {
    void (async () => {
      const route = request.url;
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      if (['/ready', '/aws/lambda-microvms/runtime/v1/ready'].includes(route)) { response.writeHead(200).end(); return; }
      if (route === '/aws/lambda-microvms/runtime/v1/run') {
        if (started || pending) { response.writeHead(409).end(); return; }
        pending = true;
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 16384) throw new Error('oversized lifecycle request');
          }
          const { fileSystemId, accessPointId } = bootPayload(JSON.parse(body).runHookPayload);
          await new Promise((resolve, reject) => execFile('/bin/sh', ['/opt/updraft/native-worker/mount-home.sh', fileSystemId, accessPointId],
            { timeout: 45000, maxBuffer: 65536 }, (error) => error ? reject(error) : resolve()));
          service = await startService(loadConfig('/etc/updraft-native-worker.json'));
          started = true;
          response.writeHead(200).end();
        } finally { pending = false; }
        return;
      }
      if (route === '/aws/lambda-microvms/runtime/v1/terminate') {
        await service?.close();
        response.writeHead(200).end();
        return;
      }
      // Suspend/resume is deliberately not enabled by the prototype image recipe. EFS
      // reconnection and ongoing-job semantics must be proven before enabling idle policies.
      response.writeHead(503).end();
    })().catch(() => {
      console.error('Native worker lifecycle operation failed; worker is unavailable.');
      if (!response.headersSent) response.writeHead(503).end();
    });
  });
  server.listen(9000, '0.0.0.0');
}
