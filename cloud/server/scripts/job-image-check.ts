// The isolation check a new job image version must pass before build-job-image.ts activates it.
//
// A version that AWS reports SUCCESSFUL has only answered its /ready hook. Whether a job's
// boundary holds on it (the packet filter loads, the sandbox self-test passes) shows only in a
// microVM run from it. So the build runs one with an isolation-check payload (version 3,
// hooks.mjs): the runner installs the packet filter and runs the same self-test a job does, with
// stand-ins for the job's files, logs one `ISOLATION CHECK {json}` line (checkImageIsolation in
// job.mjs) and starts nothing else. No tenant, no broker, no job token.
import { type CloudWatchLogsClient, GetLogEventsCommand, ResourceNotFoundException as LogsResourceNotFound } from '@aws-sdk/client-cloudwatch-logs';
import { GetMicrovmCommand, type LambdaMicrovmsClient, RunMicrovmCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';

/** The runner's marker (ISOLATION_CHECK_MARKER in job.mjs) and a check's payload version (hooks.mjs). */
export const ISOLATION_CHECK_MARKER = 'ISOLATION CHECK ';
export const ISOLATION_CHECK_PAYLOAD_VERSION = 3;
const CHECK_TIMEOUT_MS = 6 * 60 * 1000;
const POLL_MS = 5_000;
// Lambda ends it by then even if the build dies before its own TerminateMicrovm.
const CHECK_MAXIMUM_DURATION_SECONDS = 900;

export interface IsolationCheck {
  ok: boolean;
  failedStep: string | null;
  problems: string[];
  /** The microVM's log stream in the image's log group. */
  logStream: string;
}

/** The check's outcome from a runner log line, or undefined when the line is not the check's. Pure. */
export function parseIsolationCheckLine(message: string): Omit<IsolationCheck, 'logStream'> | undefined {
  const at = message.indexOf(ISOLATION_CHECK_MARKER);
  if (at < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(at + ISOLATION_CHECK_MARKER.length).trim());
  } catch {
    return { ok: false, failedStep: 'report', problems: ['the isolation check printed a line that is not JSON'] };
  }
  const report = (parsed ?? {}) as { ok?: unknown; failedStep?: unknown; problems?: unknown };
  return {
    ok: report.ok === true,
    failedStep: typeof report.failedStep === 'string' ? report.failedStep : null,
    problems: Array.isArray(report.problems) ? report.problems.map(String) : [],
  };
}

export interface CheckSettings {
  imageArn: string;
  version: string;
  region: string;
  partition: string;
  executionRoleArn: string;
  logGroup: string;
  /** The build's timestamp: names the check's microVM request and log stream. */
  stamp: string;
}

/** What RunMicrovm gets for the check. Pure. */
export function checkRunInput(s: CheckSettings) {
  const connector = (name: string) => `arn:${s.partition}:lambda:${s.region}:aws:network-connector:aws-network-connector:${name}`;
  const checkId = `image-check-${s.stamp.toLowerCase()}`;
  return {
    imageIdentifier: s.imageArn,
    imageVersion: s.version,
    // The role every job runs with: the check proves that role's credentials are out of reach.
    executionRoleArn: s.executionRoleArn,
    ingressNetworkConnectors: [connector('NO_INGRESS')],
    egressNetworkConnectors: [connector('INTERNET_EGRESS')],
    maximumDurationInSeconds: CHECK_MAXIMUM_DURATION_SECONDS,
    idlePolicy: { maxIdleDurationSeconds: CHECK_MAXIMUM_DURATION_SECONDS, suspendedDurationSeconds: 0, autoResumeEnabled: false },
    logging: { cloudWatch: { logGroup: s.logGroup, logStream: `isolation-check/${s.version}/${s.stamp}` } },
    runHookPayload: JSON.stringify({ version: ISOLATION_CHECK_PAYLOAD_VERSION, checkId }),
    clientToken: checkId,
  };
}

/**
 * Runs the check in one microVM from the version, waits for its ISOLATION CHECK line and
 * terminates the microVM. Resolves to the outcome; throws only when an AWS call is refused.
 */
export async function checkImageVersionIsolation(
  clients: { microvms: LambdaMicrovmsClient; logs: CloudWatchLogsClient },
  s: CheckSettings,
  { timeoutMs = CHECK_TIMEOUT_MS, pollMs = POLL_MS, now = Date.now, wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<IsolationCheck> {
  const input = checkRunInput(s);
  const logStream = input.logging.cloudWatch.logStream;
  const run = await clients.microvms.send(new RunMicrovmCommand(input));
  const microvmId = run.microvmId;
  if (!microvmId) throw new Error('RunMicrovm returned no microVM id for the isolation check');
  console.log(`==> isolation check in microVM ${microvmId} (log stream ${logStream})`);
  try {
    const started = now();
    let nextToken: string | undefined;
    for (;;) {
      if (now() - started > timeoutMs) {
        return { ok: false, failedStep: 'timeout', problems: [`no ISOLATION CHECK line within ${Math.round(timeoutMs / 60000)} minutes`], logStream };
      }
      await wait(pollMs);
      // Read the microVM's state before the log, so a microVM that reported and then ended is
      // not taken for one that ended without reporting.
      const vm = await clients.microvms.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      let page;
      try {
        page = await clients.logs.send(new GetLogEventsCommand({ logGroupName: s.logGroup, logStreamName: logStream, startFromHead: true, nextToken }));
      } catch (err) {
        // The stream appears with the microVM's first line.
        if (!(err instanceof LogsResourceNotFound)) throw err;
      }
      for (const event of page?.events ?? []) {
        const found = parseIsolationCheckLine(event.message ?? '');
        if (found) return { ...found, logStream };
      }
      if (page?.nextForwardToken) nextToken = page.nextForwardToken;
      if (vm.state === 'TERMINATED' || vm.state === 'TERMINATING') {
        const reason = vm.stateReason ? `: ${vm.stateReason}` : '';
        return { ok: false, failedStep: 'microvm', problems: [`the microVM ended before the check reported (${vm.state}${reason})`], logStream };
      }
    }
  } finally {
    await clients.microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId })).catch((err: unknown) => {
      console.error(`could not terminate the isolation check's microVM ${microvmId} (its maximum duration ends it): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
