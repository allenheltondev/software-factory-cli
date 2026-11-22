import { GetLogEventsCommand, ResourceNotFoundException as LogsResourceNotFound } from '@aws-sdk/client-cloudwatch-logs';
import { GetMicrovmCommand, RunMicrovmCommand, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { describe, expect, it, vi } from 'vitest';
import { ISOLATION_CHECK_MARKER, checkImageVersionIsolation, checkRunInput, parseIsolationCheckLine, type CheckSettings } from './job-image-check.js';

const settings: CheckSettings = {
  imageArn: 'arn:aws:lambda:us-east-1:111122223333:microvm-image:updraft-cloud-job',
  version: '2.0',
  region: 'us-east-1',
  partition: 'aws',
  executionRoleArn: 'arn:aws:iam::111122223333:role/updraft-cloud-MicrovmExecutionRole-x',
  logGroup: '/aws/lambda-microvms/updraft-cloud-job',
  stamp: '20261122T190000Z',
};

const line = (report: object) => `[runner] ${ISOLATION_CHECK_MARKER}${JSON.stringify(report)}`;

describe('the isolation check line', () => {
  it('reads the outcome the runner logged', () => {
    expect(parseIsolationCheckLine(line({ ok: true, failedStep: null, problems: [], checks: {} }))).toEqual({ ok: true, failedStep: null, problems: [] });
    expect(parseIsolationCheckLine(line({ ok: false, failedStep: 'packet filter', problems: ['no CAP_NET_ADMIN'] }))).toEqual({
      ok: false,
      failedStep: 'packet filter',
      problems: ['no CAP_NET_ADMIN'],
    });
  });

  it('ignores other lines, and fails a check line that is not JSON or does not say ok', () => {
    expect(parseIsolationCheckLine('[runner] starting job for delivery image-check-x')).toBeUndefined();
    expect(parseIsolationCheckLine(`[runner] ${ISOLATION_CHECK_MARKER}{oops`)).toEqual({ ok: false, failedStep: 'report', problems: ['the isolation check printed a line that is not JSON'] });
    expect(parseIsolationCheckLine(line({ ok: 'yes' }))?.ok).toBe(false);
    expect(parseIsolationCheckLine(`[runner] ${ISOLATION_CHECK_MARKER}null`)?.ok).toBe(false);
  });
});

describe('the check microVM', () => {
  it('runs the version with the jobs\' execution role, no ingress, a check payload and its own log stream', () => {
    const input = checkRunInput(settings);
    expect(input).toMatchObject({
      imageIdentifier: settings.imageArn,
      imageVersion: '2.0',
      executionRoleArn: settings.executionRoleArn,
      ingressNetworkConnectors: ['arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS'],
      egressNetworkConnectors: ['arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS'],
      logging: { cloudWatch: { logGroup: settings.logGroup, logStream: 'isolation-check/2.0/20261122T190000Z' } },
      clientToken: 'image-check-20261122t190000z',
    });
    expect(JSON.parse(input.runHookPayload)).toEqual({ version: 3, checkId: 'image-check-20261122t190000z' });
    // hooks.mjs takes the check id where a delivery id goes: letters, digits and dashes.
    expect(JSON.parse(input.runHookPayload).checkId).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
  });

  function fakeClients({ logPages, states }: { logPages: (Array<{ message: string }> | 'missing')[]; states: string[] }) {
    const sent: string[] = [];
    let logCall = 0;
    let stateCall = 0;
    const microvms = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof RunMicrovmCommand) return sent.push('run'), { microvmId: 'microvm-check-1' };
        if (command instanceof GetMicrovmCommand) return { state: states[Math.min(stateCall++, states.length - 1)] };
        if (command instanceof TerminateMicrovmCommand) return sent.push('terminate'), {};
        throw new Error('unexpected command');
      }),
    };
    const logs = {
      send: vi.fn(async (command: unknown) => {
        if (!(command instanceof GetLogEventsCommand)) throw new Error('unexpected command');
        const page = logPages[Math.min(logCall++, logPages.length - 1)];
        if (page === 'missing') throw new LogsResourceNotFound({ message: 'no stream', $metadata: {} });
        return { events: page, nextForwardToken: `f${logCall}` };
      }),
    };
    return { clients: { microvms, logs } as never, sent };
  }

  const fast = { pollMs: 0, wait: async () => {} };

  it('passes when the runner reports ok, and terminates the microVM', async () => {
    const { clients, sent } = fakeClients({
      logPages: ['missing', [{ message: '[runner] starting job for delivery image-check-x' }], [{ message: line({ ok: true, failedStep: null, problems: [] }) }]],
      states: ['RUNNING'],
    });
    await expect(checkImageVersionIsolation(clients, settings, fast)).resolves.toEqual({ ok: true, failedStep: null, problems: [], logStream: 'isolation-check/2.0/20261122T190000Z' });
    expect(sent).toEqual(['run', 'terminate']);
  });

  it('fails with the runner\'s reasons', async () => {
    const { clients, sent } = fakeClients({ logPages: [[{ message: line({ ok: false, failedStep: 'self-test', problems: ['bwrap: setting up uid map: Permission denied'] }) }]], states: ['RUNNING'] });
    await expect(checkImageVersionIsolation(clients, settings, fast)).resolves.toMatchObject({ ok: false, failedStep: 'self-test', problems: ['bwrap: setting up uid map: Permission denied'] });
    expect(sent).toEqual(['run', 'terminate']);
  });

  it('fails when the microVM ends without reporting, or nothing comes in time', async () => {
    const ended = fakeClients({ logPages: [[]], states: ['RUNNING', 'TERMINATED'] });
    await expect(checkImageVersionIsolation(ended.clients, settings, fast)).resolves.toMatchObject({ ok: false, failedStep: 'microvm' });
    expect(ended.sent).toEqual(['run', 'terminate']);

    let clock = 0;
    const silent = fakeClients({ logPages: [[]], states: ['RUNNING'] });
    const result = await checkImageVersionIsolation(silent.clients, settings, { ...fast, timeoutMs: 60_000, now: () => (clock += 20_000) });
    expect(result).toMatchObject({ ok: false, failedStep: 'timeout' });
    expect(silent.sent).toEqual(['run', 'terminate']);
  });
});
