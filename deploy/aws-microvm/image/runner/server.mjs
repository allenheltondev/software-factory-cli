// The image's ENTRYPOINT: a small HTTP server for the Lambda MicroVMs lifecycle hooks.
//
// This process is running when Lambda snapshots the image, so every microVM starts with a
// copy of its memory. It therefore holds nothing per-run and does nothing that needs fresh
// randomness or a network connection: no TLS, no AWS SDK, no secrets. On /run it starts
// run-job.mjs as a new process, which begins life inside the microVM and does all of that.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHookHandler } from './hooks.mjs';

const HOOK_PORT = Number(process.env.HOOK_PORT ?? 9000);
// The terminate hook may take at most 60 seconds (the image is created with that timeout).
// Leave the job most of it to stop the agent and write its result.
const STOP_WAIT_MS = 45_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (message) => console.log(`[runner] ${message}`);

/** @type {import('node:child_process').ChildProcess | undefined} */
let job;
let jobExited = false;

function startJob(request) {
  log(`starting job for delivery ${request.payload.deliveryId} (${request.payload.eventName}) in microVM ${request.microvmId}`);
  job = spawn(process.execPath, [path.join(here, 'run-job.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // References only (bucket, keys, secret ARNs); never a secret value.
    env: { ...process.env, UPDRAFT_RUN_REQUEST: JSON.stringify(request) },
  });
  job.on('error', (error) => {
    jobExited = true;
    log(`cannot start the job process: ${error.message}`);
  });
  job.on('exit', (code, signal) => {
    jobExited = true;
    log(`job process exited (${signal ? `signal ${signal}` : `code ${code}`})`);
  });
}

function stopJob() {
  if (!job || jobExited) return Promise.resolve();
  log('terminate hook: stopping the job');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('the job did not stop in time; letting the microVM terminate');
      resolve();
    }, STOP_WAIT_MS);
    job.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    job.kill('SIGTERM');
  });
}

const server = http.createServer(createHookHandler({ startJob, stopJob, log }));
server.listen(HOOK_PORT, '0.0.0.0', () => log(`lifecycle hooks on port ${HOOK_PORT}`));
