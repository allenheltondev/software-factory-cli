// One job: prepare a fresh state directory (with the shared state database, see state.mjs),
// make sure agents cannot reach it (isolation.mjs; unless AgentIsolation is disabled),
// run `updraft run-event` as the unprivileged job user, merge what it changed back into the
// shared database, report the outcome to S3, terminate the microVM. Everything that talks to AWS or the
// operating system's process table comes in through `deps`, so this file is tested with
// stand-ins (see ../../test/runner-job.test.mjs).
/* global AbortController */
import { spawn as nodeSpawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_SECRET_BYTES, createRedactor, redactingWriter } from './redact.mjs';
import { IsolationError, beginIsolation, isolationMode, verifyIsolation } from './isolation.mjs';
import {
  DEFAULT_CHECKPOINT_SECONDS,
  REPORT_RESERVE_MS,
  STATE_DB_FILE,
  UNSAVED_UPLOAD_MS,
  createCheckpointer,
  downloadState,
  saveUnsaved,
  stateSyncBudgetMs,
  syncState,
  waitForStateChange,
} from './state.mjs';
import { claudeTelemetryEnv, createOtlpRelay } from './otlp-relay.mjs';
import { HONEYCOMB_ENDPOINTS, createAgentTracer, createExporter } from './telemetry.mjs';

/** File names the runner writes into the state directory. Config objects may not use them. */
const KEY_FILE = 'github-app.pem';
/** Version 2 (Updraft Cloud): an installation token for the job's repository instead of the key. */
const TOKEN_FILE = 'app-token.json';
const EVENT_FILE = 'event.json';
const CONFIG_FILE = 'config.yaml';
const RESERVED_FILES = new Set([KEY_FILE, TOKEN_FILE, EVENT_FILE, STATE_DB_FILE, `${STATE_DB_FILE}-wal`, `${STATE_DB_FILE}-shm`]);
/** How often a version 2 job's token file is replaced (installation tokens last an hour). */
const TOKEN_REFRESH_MS = 20 * 60 * 1000;
/** The longest the runner waits for a coalescing window to close (the launcher's limit, plus slack). */
const MAX_NOT_BEFORE_WAIT_MS = 310 * 1000;

const MAX_CONFIG_FILES = 200;
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const MAX_LOG_BYTES = 20 * 1024 * 1024;

/**
 * run-event's exit code for "this pull request is Updraft's, and the state database I was
 * given does not know it yet" (docs/run-event.md, exit code 6). Nothing was done; the same
 * event is to be run again on a newer snapshot.
 */
export const STATE_PENDING_EXIT = 6;
/** Seconds a job waits, in all, for newer state when the payload does not say (statePendingWaitSeconds). */
export const DEFAULT_STATE_PENDING_WAIT_SECONDS = 180;
/** However often the shared state changes in that time, run-event is not started more often than this. */
export const MAX_STATE_PENDING_TRIES = 6;

// Names an agent-environment secret may not set: they would change how the job process itself
// runs, or hand it credentials this design keeps away from it.
const FORBIDDEN_ENV = /^(AWS_|UPDRAFT_|NODE_|LD_|GIT_CONFIG|GH_TOKEN$|GITHUB_TOKEN$|PATH$|HOME$|USER$|LOGNAME$|SHELL$|IFS$)/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * THE ONE PLACE that knows how Updraft is invoked for a webhook event (docs/run-event.md in
 * the Updraft repository):
 *
 *   updraft run-event --event-file <path> [--event-name issues] [--delivery-id <id>] [--json]
 *                     [--deadline-minutes <n>] [--worker-git-credentials]
 *
 * It reads the normal config ($UPDRAFT_HOME/config.yaml), works on the state database at
 * $UPDRAFT_HOME/state.db (the shared snapshot the runner put there, or a new one), creates
 * the clone when checkoutPath does not exist, and with --json prints one JSON object as its
 * last stdout line, on errors too. --deadline-minutes makes it stop everything (a running
 * agent, a review round, a wait for CI) and still print that summary.
 * --worker-git-credentials is not needed here.
 *
 * Event names passed through: issues, pull_request_review, pull_request (whatever the
 * launcher accepted). Read from the summary: that it is a JSON object, `outcome` (copied
 * into the result document, never interpreted) and `logPath`. Everything else about how the
 * run went is taken from the exit code, so an outcome this file has never heard of (a job
 * deferred by a capacity cooldown, say) is handled like any other: exit 0 keeps the
 * delivery record, any other exit releases it so that a redelivery is the retry.
 *
 * Exit 0 means that everything of the event went well, the jobs that followed from it in the
 * same run included (a reviewer run that failed is exit 1). One exit code is acted on here:
 * STATE_PENDING_EXIT, after which the job is run again on a newer snapshot (runJob).
 */
export function updraftInvocation({ eventFile, eventName, deliveryId, deadlineMinutes }) {
  return [
    'run-event',
    '--event-file', eventFile,
    '--event-name', eventName,
    '--delivery-id', deliveryId,
    '--json',
    '--deadline-minutes', String(deadlineMinutes),
  ];
}

/** What run-event's exit codes mean, for the result document. */
export function describeExitCode(code) {
  switch (code) {
    case 0:
      return null;
    case 1:
      return 'updraft exited 1: the job failed, could not start, was interrupted, was deferred or was not published, or the command itself failed (config, GitHub, event not matched); see summary.outcome and summary.message';
    case 2:
      return 'updraft exited 2: the event file is missing or not JSON, or --deadline-minutes was rejected';
    case 3:
      return "updraft exited 3: the state directory's worker lock is held";
    case 4:
      return 'updraft exited 4: work of the event waits for a usage-limit cooldown and is still queued in the shared state; redeliver the event after summary.deferredUntil';
    case 5:
      return 'updraft exited 5: the shared state database was written by a newer Updraft than the one in this image; rebuild the image';
    case STATE_PENDING_EXIT:
      return 'updraft exited 6: the event is about a pull request Updraft opened, and the shared state does not know it yet (the run that opened it has not saved its state, or never could); see state.pending. Redeliver this event once that state is saved; if it never is, redeliver the issue event of the pull request, which restores it';
    default:
      return `updraft exited with code ${code}`;
  }
}

/**
 * Minutes to give run-event as its own deadline: the watchdog's budget minus a margin, so
 * that run-event stops the agent itself and prints its summary before the watchdog would
 * have to kill it. 0 means there is not enough time to start.
 */
export const DEADLINE_MARGIN_MS = 3 * 60 * 1000;
export function deadlineMinutes(budgetMs) {
  return Math.max(0, Math.floor((budgetMs - DEADLINE_MARGIN_MS) / 60000));
}

/**
 * The agent-environment secret is either a JSON object of environment variables
 * (`{"ANTHROPIC_API_KEY": "...", "CODEX_API_KEY": "..."}`) or a bare string, which is taken
 * as ANTHROPIC_API_KEY. Throws without echoing any value.
 */
export function parseAgentEnv(secretString) {
  const text = (secretString ?? '').trim();
  if (text === '') throw new Error('the agent environment secret is empty');
  if (!text.startsWith('{')) return { ANTHROPIC_API_KEY: text };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('the agent environment secret starts with "{" but is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the agent environment secret is not a JSON object');
  }
  const env = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!ENV_NAME.test(name)) throw new Error('the agent environment secret has a key that is not a variable name');
    if (FORBIDDEN_ENV.test(name)) throw new Error(`the agent environment secret may not set ${name}`);
    if (typeof value !== 'string') throw new Error(`the agent environment secret's ${name} is not a string`);
    env[name] = value;
  }
  return env;
}

/**
 * The relative path a config object is written to, or undefined for keys to skip ("folder"
 * placeholders). Throws for keys that would land outside the state directory or on a file
 * the runner writes itself.
 */
export function configRelativePath(key, prefix) {
  if (!key.startsWith(prefix)) throw new Error(`config object ${JSON.stringify(key)} is outside ${prefix}`);
  const relative = key.slice(prefix.length);
  if (relative === '' || relative.endsWith('/')) return undefined;
  const segments = relative.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\\\0]/.test(segment)) {
      throw new Error(`config object ${JSON.stringify(key)} has an unusable path`);
    }
  }
  if (segments.length === 1 && RESERVED_FILES.has(relative)) {
    throw new Error(`config object ${JSON.stringify(key)} uses a name reserved by the runner`);
  }
  return segments.join(path.sep);
}

/**
 * How long `updraft run-event` may run: until `watchdogReserveSeconds` before the microVM's
 * maximum duration, counted from the moment the launcher asked for the microVM (which is
 * earlier than the microVM's own start, so the estimate errs on the safe side).
 */
export function watchdogBudgetMs(payload, nowMs) {
  const total = (payload.maximumDurationSeconds - payload.watchdogReserveSeconds) * 1000;
  const elapsed = Math.max(0, nowMs - Date.parse(payload.launchedAt));
  return Math.max(0, total - elapsed);
}

/**
 * @param {{ microvmId: string, payload: object }} request a validated /run request (hooks.mjs)
 * @param {object} deps
 * @param {(bucket: string, key: string) => Promise<Buffer>} deps.s3Get
 * @param {(bucket: string, prefix: string) => Promise<{ key: string, size: number }[]>} deps.s3List
 * @param {(bucket: string, key: string, body: string | Buffer, contentType?: string) => Promise<void>} deps.s3Put
 * @param {Function} [deps.s3GetIfExists] the shared state database and its ETag (state.mjs);
 *   needed when the payload has a stateKey
 * @param {Function} [deps.s3PutIf] a conditional write of it (state.mjs)
 * @param {number} [deps.stateSyncBudgetMs] overrides the computed budget of state sync (tests)
 * @param {(secretId: string) => Promise<string>} deps.getSecret
 * @param {(microvmId: string) => Promise<void>} deps.terminate
 * @param {(table: string, deliveryId: string) => Promise<void>} [deps.releaseDelivery] removes
 *   the launcher's deduplication record, so that a redelivery can retry a run that did not end well
 * @param {number} [deps.deadlineMinutes] overrides the computed --deadline-minutes (tests)
 * @param {string} deps.stateRoot directory under which the per-run state directory is made
 * @param {string[]} deps.updraftCommand the Updraft executable (and leading arguments)
 * @param {{ uid?: number, gid?: number, home: string, name: string }} deps.jobUser
 * @param {Record<string, string | undefined>} deps.baseEnv the runner's environment; only
 *   PATH, LANG, TZ and PLAYWRIGHT_BROWSERS_PATH are copied from it
 * @param {(message: string) => void} deps.log
 * @param {NodeJS.WritableStream} deps.logStream where the job's stdout and stderr are copied
 * @param {(listener: () => void) => void} [deps.onStop] registers a listener for "the microVM
 *   is terminating" (the runner's SIGTERM)
 * @param {() => number} [deps.now]
 * @param {number} [deps.killGraceMs] SIGTERM to SIGKILL
 * @param {number} [deps.retryDelayMs]
 * @param {typeof nodeSpawn} [deps.spawn]
 * @param {object} [deps.isolation] the sandbox runtime and the packet filter (isolation.mjs,
 *   run-job.mjs); required unless the payload says agentIsolation: "disabled"
 * @returns {Promise<object>} the result document that was written to S3
 */
export async function runJob(request, deps) {
  const { microvmId, payload } = request;
  const now = deps.now ?? Date.now;
  // Until the job's keys are loaded only the shape-based rules apply; then its keys too (#70).
  let redact = createRedactor();
  const log = (message) => deps.log(redact(message));
  const startedAt = now();
  const result = {
    deliveryId: payload.deliveryId,
    eventName: payload.eventName,
    microvmId,
    // succeeded | failed | timed_out | terminated | runner_error, or state_not_saved: the job
    // ran and what it changed in the shared state could not be saved (jobOutcome says how
    // the job itself went, state.sync why, state.unsaved where its database was kept).
    outcome: 'runner_error',
    jobOutcome: null,
    exitCode: null,
    signal: null,
    summary: null,
    summaryMissing: true,
    // summary.outcome, copied up: nothing-to-do | succeeded | canceled | superseded | failed |
    // publish-failed | not-started | error | whatever a newer run-event adds
    updraftOutcome: null,
    // The shared state database: what the run started from and whether its changes were
    // saved. null when the launcher sent no stateKey (state sync is off).
    // checkpoints: the saves made while the job ran. pending: the waits for newer state
    // after run-event exited STATE_PENDING_EXIT. unsaved: set when the final sync failed.
    state: payload.stateKey ? { key: payload.stateKey, snapshot: null, checkpoints: null, pending: null, sync: notAttempted(), unsaved: null } : null,
    logs: [],
    // Whether agents and verify commands were kept away from the App key, the state database
    // and the execution role (isolation.mjs). mode: enforced | disabled. enforced is true only
    // once the per-job self-test has passed; with mode disabled, warning says what that gives up.
    isolation: { mode: isolationMode(payload), enforced: false, warning: null, checks: null, problems: [] },
    error: null,
    // Set for a runner error with a cause of its own: isolation-not-enforced.
    errorCode: null,
    stderrTail: '',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationSeconds: null,
  };

  // Registered first, so that a /terminate during preparation is not lost.
  let stopRequested = false;
  let stopChild = () => {};
  let stopTokenRefresh = () => {};
  let stopWaiting = () => {};
  let hurrySync = () => {};
  deps.onStop?.(() => {
    stopRequested = true;
    stopWaiting();
    stopChild();
    hurrySync();
  });

  let stateDirForLogs;
  // Agent telemetry (telemetry.mjs), when the tenant set it up: started with the job process.
  let tracer;
  // The runner's own steps, timed for the trace (sent only when telemetry is on): isolation, the
  // state, the coalescing wait, each try of `updraft run-event` and each wait for newer state.
  const steps = [];
  const timed = async (name, attributes, operation) => {
    const step = { name, start: now(), attributes };
    steps.push(step);
    try {
      return await operation(step);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      step.end = now();
    }
  };
  // With telemetry: the loopback relay Claude Code sends its own log events to (otlp-relay.mjs),
  // and the variables that point the agents at it (no key among them).
  let relay;
  let agentTelemetryEnv;
  // Set once `updraft run-event` has run, whatever its outcome: only then is there a
  // database worth merging.
  let stateToSync;
  try {
    // First of all, before a secret is fetched or a job process exists: the packet filter
    // that keeps every user but root from the execution role's credentials.
    result.isolation = await timed('isolation', {}, () => beginIsolation(payload, deps));
    // Agent telemetry next, so the trace has every later step, a failed one too. The key is the
    // runner's own, like the token: it is never in the job's environment, and it is redacted
    // wherever it might appear (until the agents' keys are loaded, it and the shape-based rules).
    const telemetry = payload.version === 2 ? await telemetrySetup(payload, deps, log) : null;
    if (telemetry) {
      redact = createRedactor([telemetry.apiKey]);
      // Through `redact` as it is when a span leaves: the agents' keys join it below.
      const redactNow = (text) => redact(text);
      tracer = createAgentTracer({
        startedAt,
        captureContent: telemetry.captureContent,
        redact: redactNow,
        log,
        now,
        exporter: createExporter({
          endpoint: telemetry.endpoint,
          apiKey: telemetry.apiKey,
          redact: redactNow,
          resource: { 'service.name': telemetry.serviceName, 'updraft.delivery.id': payload.deliveryId, 'updraft.microvm.id': microvmId },
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          log,
          now,
        }),
        ...(deps.telemetryPollMs ? { pollMs: deps.telemetryPollMs } : {}),
      });
      tracer.start();
      log(`sending agent telemetry (trace ${tracer.traceId}) to ${telemetry.endpoint}${telemetry.captureContent ? ', with content' : ''}`);
    }
    const { stateDir, state } = await timed('restore_state', {}, async (step) => {
      const prepared = await prepare(payload, deps);
      step.attributes = { 'updraft.state.restored': Boolean(prepared.state) };
      return prepared;
    });
    // The job user owns everything under the state directory: the run logs are read confined to it.
    tracer?.watch({ runsDir: path.join(stateDir, 'logs', 'runs'), confineTo: stateDir });
    if (result.state && state) result.state.snapshot = state.snapshot;
    // Nothing is started unless the boundary around agents is proven in this microVM: the
    // config contains every agent, and a probe in the sandbox cannot reach the key, the state
    // or the credentials. Throws IsolationError; the job then never starts.
    await timed('verify_isolation', {}, () => verifyIsolation(
      result.isolation,
      { stateDir, protectedFiles: [payload.version === 2 ? TOKEN_FILE : KEY_FILE, STATE_DB_FILE, CONFIG_FILE, EVENT_FILE].map((name) => path.join(stateDir, name)) },
      deps,
    ));
    // A pull request event that other deliveries were coalesced into: start only when the
    // launcher has stopped coalescing, so that this run sees all of them on GitHub.
    const waitMs = Math.min(MAX_NOT_BEFORE_WAIT_MS, payload.notBefore ? Date.parse(payload.notBefore) - now() : 0);
    if (waitMs > 0 && !stopRequested) {
      log(`waiting ${Math.ceil(waitMs / 1000)} s for the launcher's coalescing window to close`);
      await timed('coalesce_wait', { 'updraft.wait.planned_ms': waitMs }, () =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          stopWaiting = () => {
            clearTimeout(timer);
            resolve();
          };
        }),
      );
    }
    if (stopRequested) throw new Error('the microVM was terminated before the job started');
    const budgetMs = watchdogBudgetMs(payload, now());
    const deadline = deps.deadlineMinutes ?? deadlineMinutes(budgetMs);
    if (budgetMs <= 0 || deadline < 1) throw new Error('no time left before the microVM reaches its maximum duration');
    log(`running updraft run-event for delivery ${payload.deliveryId}; its deadline is ${deadline} min, the watchdog fires in ${Math.round(budgetMs / 1000)} s`);

    stateDirForLogs = stateDir;
    let current = state;
    let budget = budgetMs;
    let deadlineNow = deadline;
    let run;
    const pending = { tries: 0, waitedMs: 0, resolved: null };
    const pendingWaitMs = (payload.statePendingWaitSeconds ?? DEFAULT_STATE_PENDING_WAIT_SECONDS) * 1000;
    const checkpointMs = (payload.stateCheckpointSeconds ?? DEFAULT_CHECKPOINT_SECONDS) * 1000;
    const checkpoints = [];
    // Version 2: the token in the token file lasts an hour; replace it well before that, for as
    // long as the job runs (Updraft reads the file again for every token it needs).
    if (payload.version === 2) stopTokenRefresh = startTokenRefresh(stateDir, deps);
    // The agents' keys, read once for every try. From here, nothing the runner forwards or
    // keeps (the log stream, the uploaded logs, the result) carries a value of them.
    const agentEnv = payload.version === 2 ? await brokerAgentEnv(payload, deps) : parseAgentEnv(await deps.getSecret(payload.secrets.agentEnv));
    redact = createRedactor([...secretValues(payload, agentEnv), ...(telemetry ? [telemetry.apiKey] : [])]);
    if (tracer) ({ relay, env: agentTelemetryEnv } = await startAgentEventRelay(tracer, log));
    for (;;) {
      // Checkpoints: what the run records (the pull request it opened, above all) reaches the
      // shared database while it runs, not only at its end. Stopped before anything else
      // touches the run's database or the shared one.
      const checkpointer =
        current !== undefined && checkpointMs > 0
          ? createCheckpointer(
              { bucket: payload.bucket, key: payload.stateKey, stateDir, baseFile: current.baseFile, intervalMs: deps.checkpointIntervalMs ?? checkpointMs, intervalSeconds: checkpointMs / 1000, timeLeftMs: () => stateSyncBudgetMs(payload, now()) },
              deps,
            )
          : undefined;
      checkpointer?.start();
      try {
        run = await timed('run_event', { 'updraft.run_event.try': pending.tries + 1, 'updraft.run_event.deadline_minutes': deadlineNow }, async (step) => {
          const done = await runUpdraft(payload, stateDir, budget, deadlineNow, { ...deps, log, traceId: tracer?.traceId, agentTelemetryEnv }, { agentEnv, redact }, (stop) => {
            stopChild = stop;
            if (stopRequested) stop();
          });
          Object.assign(step.attributes, { 'updraft.run_event.exit_code': done.exitCode ?? undefined, 'updraft.run_event.signal': done.signal ?? undefined, 'updraft.run_event.timed_out': done.timedOut || undefined, 'updraft.run_event.state_pending': done.exitCode === STATE_PENDING_EXIT || undefined });
          if (done.exitCode !== 0 && done.exitCode !== STATE_PENDING_EXIT) step.error = done.signal ? `killed by ${done.signal}` : `exited ${done.exitCode}`;
          return done;
        });
      } finally {
        const made = await checkpointer?.stop();
        if (made) checkpoints.push(made);
      }
      if (current) stateToSync = { stateDir, baseFile: current.baseFile };
      if (run.exitCode !== STATE_PENDING_EXIT) {
        if (pending.tries > 0) pending.resolved = true;
        break;
      }
      // The pull request of this event is Updraft's, and the snapshot this run started from
      // does not know it: the run that opened it has not saved its state yet. Wait for the
      // shared object to change, take a fresh snapshot, and run the same event again, a
      // bounded number of times; after that the job has failed, and says why.
      pending.tries += 1;
      pending.resolved = false;
      if (!current || stopRequested || run.timedOut || pending.tries >= MAX_STATE_PENDING_TRIES) break;
      const waitStarted = now();
      const mayWaitMs = Math.min(pendingWaitMs - pending.waitedMs, watchdogBudgetMs(payload, now()) - DEADLINE_MARGIN_MS - 60_000);
      if (mayWaitMs <= 0) break;
      log(`the shared state does not know this event's pull request yet; waiting up to ${Math.round(mayWaitMs / 1000)} s for it to change (try ${pending.tries})`);
      const waiting = new AbortController();
      stopWaiting = () => waiting.abort();
      const changed = await timed('state_wait', { 'updraft.wait.planned_ms': mayWaitMs, 'updraft.state_pending.try': pending.tries }, async (step) => {
        const found = await waitForStateChange({ bucket: payload.bucket, key: payload.stateKey, etag: current.snapshot.etag ?? undefined, timeoutMs: mayWaitMs, signal: waiting.signal }, deps);
        step.attributes['updraft.state.changed'] = Boolean(found);
        return found;
      });
      stopWaiting = () => {};
      pending.waitedMs += Math.max(0, now() - waitStarted);
      if (!changed || stopRequested) break;
      budget = watchdogBudgetMs(payload, now());
      deadlineNow = deps.deadlineMinutes ?? deadlineMinutes(budget);
      if (budget <= 0 || deadlineNow < 1) break;
      // The database of the try that found nothing is replaced by the newer snapshot.
      stateToSync = undefined;
      current = await refreshState(payload, stateDir, current, deps);
      result.state.snapshot = current.snapshot;
      log(`running updraft run-event again on the newer shared state (try ${pending.tries + 1})`);
    }
    if (result.state) {
      result.state.checkpoints = checkpoints.length ? summarizeCheckpoints(checkpoints) : null;
      result.state.pending = pending.tries > 0 ? pending : null;
    }
    result.exitCode = run.exitCode;
    result.signal = run.signal;
    result.stderrTail = run.stderrTail;
    result.summary = run.summary;
    result.summaryMissing = run.summary === null;
    result.updraftOutcome = typeof run.summary?.outcome === 'string' ? run.summary.outcome : null;
    if (run.timedOut) {
      result.outcome = 'timed_out';
      result.error = `stopped by the watchdog after ${Math.round(budgetMs / 1000)} s, before the microVM's maximum duration`;
    } else if (stopRequested) {
      result.outcome = 'terminated';
      result.error = 'the microVM was terminated while the job was running';
    } else if (run.exitCode === 0) {
      result.outcome = 'succeeded';
      if (run.summary === null) result.error = `updraft exited 0 without a JSON summary on its last stdout line${run.summaryProblem}`;
    } else {
      result.outcome = 'failed';
      result.error = run.signal ? `updraft was killed by ${run.signal}` : describeExitCode(run.exitCode);
      if (run.exitCode === STATE_PENDING_EXIT && pending.tries > 0) {
        result.error += ` (tried ${pending.tries} time(s), waited ${Math.round(pending.waitedMs / 1000)} s for newer state)`;
      }
    }
  } catch (error) {
    result.outcome = stopRequested ? 'terminated' : 'runner_error';
    result.error = error instanceof Error ? error.message : String(error);
    if (error instanceof IsolationError) {
      // A failure of its own kind: nothing was started, and nothing may be until it is fixed.
      result.outcome = 'runner_error';
      result.errorCode = 'isolation-not-enforced';
      result.isolation = { ...result.isolation, enforced: false, failedStep: error.step, problems: error.problems };
      log(`ISOLATION NOT ENFORCED: the job was NOT started. ${error.step}: ${error.problems.join('; ')}`);
    }
    log(`job could not run: ${result.error}`);
  }
  stopTokenRefresh();
  // The job process has exited: nothing more for the relay to hear before the last spans go.
  await relay?.stop();
  if (tracer) {
    // The last spans, with how the job ended. Little time when the microVM is being stopped.
    result.telemetry = await tracer.stop({
      outcome: result.outcome,
      summary: result.summary,
      deliveryId: payload.deliveryId,
      eventName: payload.eventName,
      steps,
      budgetMs: deps.telemetryBudgetMs ?? (stopRequested ? 5_000 : 15_000),
    });
    log(`agent telemetry: ${result.telemetry.exported} of ${result.telemetry.spans} span(s) sent${result.telemetry.lastError ? ` (last error: ${result.telemetry.lastError})` : ''}`);
  }

  // Save what the run changed in the shared state, whatever the job's outcome: a failed run
  // also recorded things later runs need (a capacity cooldown, a review it has seen).
  result.jobOutcome = result.outcome;
  if (stateToSync && result.state) {
    const budgetMs = deps.stateSyncBudgetMs ?? stateSyncBudgetMs(payload, now(), { terminating: stopRequested });
    result.state.sync = await syncState(
      {
        bucket: payload.bucket,
        key: payload.stateKey,
        stateDir: stateToSync.stateDir,
        baseFile: stateToSync.baseFile,
        budgetMs,
        onHurry: (hurry) => {
          hurrySync = hurry;
        },
      },
      deps,
    );
    hurrySync = () => {};
    // The job ran and its state is not in the shared database. With a pull request opened,
    // that state exists nowhere else: every later event about the pull request would find it
    // unknown. So this is a failure of its own, whatever the job's outcome was: the delivery
    // record is released below (a redelivery restores the publication from GitHub), and the
    // run's database is kept under its own key for `deploy.sh state recover`.
    const sync = result.state.sync;
    if (sync.notSavedReason && sync.notSavedCode !== 'no-run-database') {
      result.outcome = 'state_not_saved';
      const lost = `the job ended "${result.jobOutcome}", and what it changed in the shared state was NOT saved (${sync.notSavedCode}): ${sync.notSavedReason}`;
      result.error = result.error ? `${lost}; the job: ${result.error}` : lost;
      const hardEnd = Date.parse(payload.launchedAt) + payload.maximumDurationSeconds * 1000;
      // Lambda gives a terminating microVM a minute in all: keep this short then.
      const unsavedBudgetMs = deps.unsavedUploadMs ?? Math.min(stopRequested ? 20_000 : UNSAVED_UPLOAD_MS, hardEnd - REPORT_RESERVE_MS / 2 - now());
      result.state.unsaved = await saveUnsaved(
        { bucket: payload.bucket, stateKey: payload.stateKey, deliveryId: payload.deliveryId, stateDir: stateToSync.stateDir, baseFile: stateToSync.baseFile, budgetMs: unsavedBudgetMs },
        deps,
      );
    }
  }

  const finishedAt = now();
  result.finishedAt = new Date(finishedAt).toISOString();
  result.durationSeconds = Math.round((finishedAt - startedAt) / 1000);
  const resultKey = `${payload.resultKeyPrefix}${microvmId}.json`;
  // The microVM's disk is gone after termination: keep Updraft's own log and the run log
  // (the agent's transcript) next to the result.
  if (stateDirForLogs) {
    result.logs = await uploadLogs(stateDirForLogs, result.summary, `${payload.resultKeyPrefix}${microvmId}/`, payload.bucket, { ...deps, log }, redact);
  }
  // What is kept and returned carries no secret: the summary and the error are the job's own
  // words. Redacted as JSON text (the redaction never adds a quote, so it stays JSON).
  try {
    Object.assign(result, JSON.parse(redact(JSON.stringify(result))));
  } catch {
    result.summary = null;
    result.error = redact(String(result.error ?? ''));
  }
  // One line in the log as well, so the outcome survives a failed upload.
  log(`RESULT ${JSON.stringify({ ...result, stderrTail: undefined })}`);
  try {
    await retry(() => deps.s3Put(payload.bucket, resultKey, `${JSON.stringify(result, null, 2)}\n`), deps);
    log(`result written to s3://${payload.bucket}/${resultKey}`);
  } catch (error) {
    log(`could not write the result to S3: ${error?.message ?? error}`);
  }
  // The launcher refuses a redelivery while its record of this delivery exists. Keep the
  // record after a clean exit whose state was saved (a redelivery would find the work done),
  // remove it otherwise: redelivering the webhook is how a failed run is retried, and how a
  // publication whose state was lost is put back on record.
  if (payload.dedupeTable && deps.releaseDelivery && !(result.outcome === 'succeeded' && !result.summaryMissing)) {
    try {
      await retry(() => deps.releaseDelivery(payload.dedupeTable, payload.deliveryId), deps);
      log('the delivery can be redelivered to retry this run');
    } catch (error) {
      log(`could not remove the deduplication record; a redelivery is refused until it expires: ${error?.message ?? error}`);
    }
  }
  // Version 2: tell the broker the job is over, so nothing more is served for its token. As with
  // the deduplication record above, only a clean success keeps the delivery's claim: a success
  // without a summary is reported as "unconfirmed", which lets a redelivery run it again.
  if (payload.version === 2 && deps.finishJob) {
    const outcome = result.outcome === 'succeeded' && result.summaryMissing ? 'unconfirmed' : result.outcome;
    try {
      await retry(() => deps.finishJob(outcome, finishDetail(result)), deps);
    } catch (error) {
      log(`could not tell the job broker the job finished; its token stops working at the maximum duration: ${error?.message ?? error}`);
    }
  }
  // Whatever happened, do not leave the microVM running (and billed) until its maximum
  // duration. If this fails too, the maximum duration is the backstop.
  try {
    await retry(() => deps.terminate(microvmId), deps);
    log(`asked Lambda to terminate microVM ${microvmId}`);
  } catch (error) {
    log(`could not terminate microVM ${microvmId}: ${error?.message ?? error}`);
  }
  return result;
}

/** result.state.sync for a job that never ran: there is nothing to merge. */
function notAttempted() {
  return {
    attempted: false,
    saved: false,
    changed: null,
    attempts: 0,
    conflicts: 0,
    merge: null,
    info: null,
    uploadedBytes: null,
    schemaVersion: null,
    etag: null,
    notSavedReason: 'the job did not start, so there is nothing to save',
    notSavedCode: 'job-not-started',
    durationMs: null,
  };
}

/**
 * Creates the state directory and fills it: event, config tree, App key and, when the
 * payload names one, the shared state database. Returns its path and what was downloaded.
 */
async function prepare(payload, deps) {
  const { jobUser } = deps;
  await fs.mkdir(deps.stateRoot, { recursive: true });
  // mkdtemp's suffix is generated now, inside this microVM, not at image build.
  const stateDir = await fs.mkdtemp(path.join(deps.stateRoot, 'job-'));
  await fs.chmod(stateDir, 0o700);

  const event = await deps.s3Get(payload.bucket, payload.eventKey);
  await fs.writeFile(path.join(stateDir, EVENT_FILE), event, { mode: 0o600 });

  const objects = await deps.s3List(payload.bucket, payload.configPrefix);
  if (objects.length > MAX_CONFIG_FILES) throw new Error(`more than ${MAX_CONFIG_FILES} objects under s3://${payload.bucket}/${payload.configPrefix}`);
  let total = 0;
  let sawConfig = false;
  for (const object of objects) {
    const relative = configRelativePath(object.key, payload.configPrefix);
    if (relative === undefined) continue;
    total += object.size ?? 0;
    if (total > MAX_CONFIG_BYTES) throw new Error(`the config under s3://${payload.bucket}/${payload.configPrefix} is larger than ${MAX_CONFIG_BYTES} bytes`);
    const target = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await deps.s3Get(payload.bucket, object.key), { mode: 0o600 });
    if (relative === CONFIG_FILE) sawConfig = true;
  }
  if (!sawConfig) throw new Error(`no ${CONFIG_FILE} at s3://${payload.bucket}/${payload.configPrefix}${CONFIG_FILE}`);

  if (payload.version === 2) {
    // Updraft Cloud: no key in the job at all. An installation token for this job's repository,
    // which the tenant's compiled config reads (github.app.tokenFile: ./app-token.json).
    await writeTokenFile(stateDir, await deps.githubToken(), deps);
  } else {
    const privateKey = await deps.getSecret(payload.secrets.githubAppPrivateKey);
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey ?? '')) {
      throw new Error('the GitHub App private key secret is empty or not a PEM private key');
    }
    await fs.writeFile(path.join(stateDir, KEY_FILE), privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  }

  // Last, so that the snapshot is as fresh as it can be when the job starts.
  let state;
  if (payload.stateKey) {
    if (!deps.s3GetIfExists || !deps.s3PutIf) throw new Error('the run request names a shared state database, but this runner cannot reach one');
    state = await retry(async () => {
      await fs.rm(path.join(stateDir, STATE_DB_FILE), { force: true });
      return downloadState({ bucket: payload.bucket, key: payload.stateKey, stateDir }, deps);
    }, deps);
  }

  if (jobUser.uid !== undefined && jobUser.gid !== undefined) await chownTree(stateDir, jobUser.uid, jobUser.gid);
  return { stateDir, state };
}

/**
 * Writes the token file (Updraft's github.app.tokenFile format) owner-only, by writing a new file
 * and renaming it over the old one, so Updraft never reads half a file. Owned by the job user,
 * like the rest of the state directory. Never logged.
 */
async function writeTokenFile(stateDir, document, deps) {
  if (!document || typeof document.token !== 'string' || typeof document.expiresAt !== 'string') {
    throw new Error('the job broker returned no usable GitHub token');
  }
  const target = path.join(stateDir, TOKEN_FILE);
  const temp = path.join(stateDir, `.${TOKEN_FILE}.${process.pid}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(document)}\n`, { mode: 0o600, flag: 'wx' });
  const { uid, gid } = deps.jobUser;
  if (uid !== undefined && gid !== undefined) await fs.lchown(temp, uid, gid);
  await fs.rename(temp, target);
}

/**
 * Replaces the token file every TOKEN_REFRESH_MS while the job runs. A failed refresh is logged
 * and retried on the next tick; the token in place stays valid for the rest of its hour.
 */
function startTokenRefresh(stateDir, deps) {
  const timer = setInterval(() => {
    deps
      .githubToken()
      .then((document) => writeTokenFile(stateDir, document, deps))
      .catch((error) => deps.log(`could not refresh the GitHub token: ${error?.message ?? error}`));
  }, deps.tokenRefreshMs ?? TOKEN_REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * What the broker records of the job for the tenant's console (#71), from the redacted result:
 * how run-event ended, whether verification passed, the pull request, the logs uploaded.
 */
export function finishDetail(result) {
  const detail = {};
  if (typeof result.updraftOutcome === 'string') detail.updraftOutcome = result.updraftOutcome;
  // Every job the run did (the event's own, more of them, and what followed: a reviewer run, a
  // revision): verification failed if it failed for any of them.
  const jobs = [result.summary, ...(Array.isArray(result.summary?.jobs) ? result.summary.jobs : []), ...(Array.isArray(result.summary?.followOnJobs) ? result.summary.followOnJobs : [])];
  const verdicts = jobs.map((j) => j?.verification?.passed).filter((v) => typeof v === 'boolean');
  if (verdicts.length) detail.verificationPassed = !verdicts.includes(false);
  if (typeof result.summary?.prUrl === 'string') detail.prUrl = result.summary.prUrl;
  const logs = (result.logs ?? []).map((key) => String(key).split('/').pop());
  if (logs.length) detail.logs = logs;
  // Agent telemetry: the trace, for a link to it, and whether it got there.
  if (result.telemetry) {
    const t = result.telemetry;
    detail.telemetry = {
      traceId: t.traceId,
      spans: t.spans,
      exported: t.exported,
      failed: t.failed,
      startedAt: t.startedAt,
      ...(t.lastError ? { lastError: t.lastError } : {}),
      // Where the links on the job's page go: its conversation, and spans worth opening at.
      ...(t.conversationId ? { conversationId: t.conversationId } : {}),
      ...(t.marks?.length ? { marks: t.marks } : {}),
    };
  }
  // The lifecycle (the console's job timeline): where the review loop left the pull request, and
  // each step in order. The broker keeps only codes, counts and booleans of it.
  const loop = result.summary?.loop;
  if (loop && typeof loop === 'object') {
    detail.loop = { rounds: loop.rounds, maxRevisions: loop.maxRevisions, reviews: loop.reviews, verdict: loop.verdict, stage: loop.stage, merged: loop.merged };
  }
  if (result.summary && typeof result.summary === 'object') {
    const event = result.summary.event?.name;
    const ownKind = event === 'issues' ? 'implement' : null;
    const own = Array.isArray(result.summary.jobs) && result.summary.jobs.length ? result.summary.jobs : result.summary.jobId ? [result.summary] : [];
    const follow = Array.isArray(result.summary.followOnJobs) ? result.summary.followOnJobs : [];
    const step = (j, kind) => ({
      kind,
      agent: j.agent ?? undefined,
      outcome: j.outcome ?? j.runOutcome ?? j.status ?? undefined,
      verificationPassed: typeof j.verification?.passed === 'boolean' ? j.verification.passed : undefined,
      publication: j.publication ?? undefined,
    });
    const steps = [
      ...own.map((j) => step(j, j.kind === 'review' || j.kind === 'revision' ? j.kind : ownKind)).filter((s) => s.kind),
      ...follow.filter((j) => j.kind === 'review' || j.kind === 'revision').map((j) => step(j, j.kind)),
    ];
    if (steps.length) detail.steps = steps;
  }
  return detail;
}

/**
 * The loopback relay for Claude Code's own log events, feeding the tracer, and the variables
 * that point the agents at it. A relay that cannot start costs only those events.
 */
async function startAgentEventRelay(tracer, log) {
  const relay = createOtlpRelay({ onRecord: (record) => tracer.agentEvent(record), log });
  try {
    const { port } = await relay.start();
    return { relay, env: claudeTelemetryEnv(port) };
  } catch (error) {
    log(`agent telemetry: Claude Code's own events are not collected (the relay did not start: ${error?.code ?? error?.message ?? error})`);
    await relay.stop();
    return { relay: undefined, env: undefined };
  }
}

/**
 * The job's telemetry settings, from the broker's descriptor, with the key read from the
 * tenant's secret. Null when telemetry is off, or the key cannot be read (the job runs anyway).
 */
async function telemetrySetup(payload, deps, log) {
  const t = payload.telemetry;
  if (!t || typeof t !== 'object' || typeof t.secret !== 'string') return null;
  const endpoint = HONEYCOMB_ENDPOINTS[t.region] ?? null;
  if (!endpoint) return null;
  try {
    // The version the tenant's settings name: the key is the one checked for this region and
    // team, whatever was written to the secret since. Settings from before versions: the current.
    const version = typeof t.secretVersion === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(t.secretVersion) ? t.secretVersion : undefined;
    const apiKey = (await deps.getSecret(t.secret, version))?.trim();
    if (!apiKey) {
      log('agent telemetry is on, but its key is not set; nothing is sent');
      return null;
    }
    return {
      apiKey,
      endpoint,
      serviceName: typeof t.serviceName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(t.serviceName) ? t.serviceName : 'updraft',
      captureContent: t.captureContent === true,
    };
  } catch (error) {
    log(`agent telemetry is on, but its key could not be read (${error?.name ?? 'error'}); nothing is sent`);
    return null;
  }
}

/**
 * The values to redact. Version 2: every value is a tenant's key. Version 1's agent-env secret
 * may also hold settings that are not secret (a model name, a mode); those whose name says
 * key, token, secret, password or credential are redacted.
 */
function secretValues(payload, agentEnv) {
  if (payload.version === 2) return Object.values(agentEnv);
  return Object.entries(agentEnv)
    .filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name))
    .map(([, value]) => value);
}

/**
 * A version 2 job's agent environment: the tenant's key secrets the broker named, read with the
 * tenant-scoped credentials. A secret that does not exist is a key the tenant has not set.
 */
async function brokerAgentEnv(payload, deps) {
  const env = {};
  for (const [name, secretId] of Object.entries(payload.agentKeySecrets ?? {})) {
    try {
      const value = await deps.getSecret(secretId);
      if (value) env[name] = value;
    } catch (error) {
      if (!/ResourceNotFound/.test(`${error?.name ?? ''} ${error?.message ?? ''}`)) throw error;
    }
  }
  return env;
}

/**
 * A fresh snapshot for another try of the same event: the run's database (and its
 * write-ahead log) is removed, the shared object is downloaded again, and the new file is
 * given to the job user. The job's processes are gone by now; even so, the file is created
 * exclusively, so nothing left behind can make root write through a link.
 */
async function refreshState(payload, stateDir, previous, deps) {
  const fresh = await retry(async () => {
    for (const name of [STATE_DB_FILE, `${STATE_DB_FILE}-wal`, `${STATE_DB_FILE}-shm`]) await fs.rm(path.join(stateDir, name), { force: true });
    return downloadState({ bucket: payload.bucket, key: payload.stateKey, stateDir }, deps);
  }, deps);
  if (previous.baseDir) await fs.rm(previous.baseDir, { recursive: true, force: true }).catch(() => {});
  const { uid, gid } = deps.jobUser;
  if (fresh.snapshot.found && uid !== undefined && gid !== undefined) await fs.lchown(path.join(stateDir, STATE_DB_FILE), uid, gid);
  return fresh;
}

/** The checkpoints of every try of the job, as one entry of the result document. */
function summarizeCheckpoints(all) {
  const total = { intervalSeconds: all[0].intervalSeconds, attempted: 0, saved: 0, unchanged: 0, failed: 0, lastSavedAt: null, lastEtag: null, lastProblem: null };
  for (const one of all) {
    for (const name of ['attempted', 'saved', 'unchanged', 'failed']) total[name] += one[name];
    for (const name of ['lastSavedAt', 'lastEtag', 'lastProblem']) total[name] = one[name] ?? total[name];
  }
  return total;
}

async function chownTree(target, uid, gid) {
  await fs.lchown(target, uid, gid);
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(target)) await chownTree(path.join(target, entry), uid, gid);
}

/** The job process's environment: built from nothing, not inherited. */
function jobEnvironment(payload, stateDir, agentEnv, deps) {
  const { baseEnv, jobUser } = deps;
  const env = {
    PATH: baseEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: jobUser.home,
    USER: jobUser.name,
    LOGNAME: jobUser.name,
    LANG: baseEnv.LANG ?? 'C.UTF-8',
    // Updraft reads its config from $UPDRAFT_HOME/config.yaml and keeps its state there.
    UPDRAFT_HOME: stateDir,
    ...agentEnv,
  };
  if (baseEnv.TZ) env.TZ = baseEnv.TZ;
  // Where the image keeps its headless browser; without it Playwright looks in the job
  // user's empty cache and reports the browser as not installed.
  if (baseEnv.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = baseEnv.PLAYWRIGHT_BROWSERS_PATH;
  // Settings of the sandbox runtime client that Updraft starts (tests point it at a config).
  Object.assign(env, deps.isolation?.runtimeEnv);
  // The job's trace, when telemetry is on: Updraft records it with each run, so a later job's
  // trace can link back to this one (a revision to the review it answers). An id, not a secret.
  if (typeof deps.traceId === 'string' && /^[0-9a-f]{32}$/.test(deps.traceId)) env.UPDRAFT_TRACE_ID = deps.traceId;
  // With agent telemetry: where Claude Code sends its own log events (the runner's loopback
  // relay; no key). Last, so an agent key of the same name cannot point them elsewhere. The
  // sandbox runtime passes exactly these on to a contained agent (updraft-sandbox.mjs).
  Object.assign(env, deps.agentTelemetryEnv);
  // Deliberately absent: AWS_* (the runner's credentials and region), anything naming the
  // key file, and the run request. See "Security model" in the README for what this does
  // and does not achieve.
  return env;
}

/**
 * Uploads updraft.log and the run log named by the summary's logPath. The path comes from
 * the job's output, and this process is root, so only a regular file that really lies inside
 * the state directory is read. Returns the keys written.
 */
async function uploadLogs(stateDir, summary, keyPrefix, bucket, deps, redact) {
  const maxBytes = deps.maxLogBytes ?? MAX_LOG_BYTES;
  // With UPDRAFT_HOME set, Updraft keeps its worker log under logs/ (src/paths.ts).
  const candidates = [['updraft.log', path.join(stateDir, 'logs', 'updraft.log')]];
  if (typeof summary?.logPath === 'string' && summary.logPath !== '') {
    candidates.push(['run.log', path.resolve(stateDir, summary.logPath)]);
  }
  const uploaded = [];
  let root;
  try {
    root = await fs.realpath(stateDir);
  } catch {
    return uploaded;
  }
  for (const [name, file] of candidates) {
    try {
      const real = await fs.realpath(file);
      if (!real.startsWith(`${root}${path.sep}`)) throw new Error('it is outside the state directory');
      const stat = await fs.lstat(real);
      if (!stat.isFile()) throw new Error('it is not a regular file');
      const handle = await fs.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let body;
      // A log larger than the limit is cut to its end, which is where a failure shows. A little
      // more is read and redacted than is kept, so a secret the cut runs through is still whole
      // when it is redacted (what is kept then starts inside "[redacted]", never inside a key).
      const length = Math.min(stat.size, maxBytes);
      const extra = Math.min(stat.size - length, MAX_SECRET_BYTES);
      try {
        body = Buffer.alloc(length + extra);
        await handle.read(body, 0, length + extra, stat.size - length - extra);
      } finally {
        await handle.close();
      }
      const redactedAll = Buffer.from(redact(body.toString('utf8')), 'utf8');
      const redacted = extra > 0 ? redactedAll.subarray(Math.max(0, redactedAll.length - length)) : redactedAll;
      const key = `${keyPrefix}${name}`;
      await retry(() => deps.s3Put(bucket, key, redacted, 'text/plain; charset=utf-8'), deps);
      uploaded.push(key);
    } catch (error) {
      if (error?.code !== 'ENOENT') deps.log(`could not upload ${name}: ${error?.message ?? error}`);
    }
  }
  return uploaded;
}

async function runUpdraft(payload, stateDir, budgetMs, deadline, deps, { agentEnv, redact }, registerStop) {
  const spawn = deps.spawn ?? nodeSpawn;
  const killGraceMs = deps.killGraceMs ?? 20_000;
  const [command, ...leading] = deps.updraftCommand;
  const args = [
    ...leading,
    ...updraftInvocation({
      eventFile: path.join(stateDir, EVENT_FILE),
      eventName: payload.eventName,
      deliveryId: payload.deliveryId,
      deadlineMinutes: deadline,
    }),
  ];
  const options = {
    cwd: stateDir,
    env: jobEnvironment(payload, stateDir, agentEnv, deps),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the watchdog can stop Updraft and everything it started.
    detached: true,
  };
  if (deps.jobUser.uid !== undefined) options.uid = deps.jobUser.uid;
  if (deps.jobUser.gid !== undefined) options.gid = deps.jobUser.gid;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let timedOut = false;
    let killTimer;
    let lastLine = '';
    let pending = '';
    let pendingOversized = false;
    let stderrTail = '';

    const stop = () => {
      signalGroup(child, 'SIGTERM');
      killTimer ??= setTimeout(() => signalGroup(child, 'SIGKILL'), killGraceMs);
    };
    registerStop(stop);
    const watchdog = setTimeout(() => {
      timedOut = true;
      deps.log('watchdog: updraft outlived its own deadline; stopping it, the microVM is close to its maximum duration');
      stop();
    }, budgetMs);

    // stderr is redacted on its way to the log stream, holding back a partial line; stdout line by line.
    const stderrOut = redactingWriter((text) => {
      deps.logStream.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
    }, redact);
    // The summary is read from the line as Updraft wrote it (its paths are used); only what is
    // kept (the result document) is redacted.
    const takeLine = (line) => {
      deps.logStream.write(`${redact(line)}\n`);
      if (line.trim() !== '') lastLine = line;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (pendingOversized) pendingOversized = false;
        else takeLine(line);
      }
      if (pending.length > MAX_STDOUT_LINE_BYTES) {
        // Not a summary line; drop it instead of holding it in memory.
        pending = '';
        pendingOversized = true;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrOut.write(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      reject(new Error(`cannot start ${command}: ${error.message}`));
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      if (pending !== '' && !pendingOversized) takeLine(pending);
      stderrOut.end();
      // Nothing the job started may outlive it: the state database is merged next, and the
      // microVM is about to go away.
      signalGroup(child, 'SIGKILL');
      const { summary, problem } = parseSummary(lastLine);
      resolve({ exitCode, signal, timedOut, summary, summaryProblem: problem, stderrTail });
    });
  });
}

function parseSummary(line) {
  if (line.trim() === '') return { summary: null, problem: ' (stdout was empty)' };
  try {
    const parsed = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { summary: parsed, problem: '' };
    return { summary: null, problem: ' (the last line is JSON but not an object)' };
  } catch {
    return { summary: null, problem: ' (the last line is not JSON)' };
  }
}

function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone already.
  }
}

async function retry(operation, deps, attempts = 3) {
  const delayMs = deps.retryDelayMs ?? 2000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
