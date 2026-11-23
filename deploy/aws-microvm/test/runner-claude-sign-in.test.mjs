// Claude subscription sign-in (image/runner/claude-sign-in.mjs): driving `claude setup-token`
// under a pseudo-terminal. The child is a stand-in that prints what the real one printed in a
// MicroVM (Claude Code 2.1.330): the URL as an OSC 8 hyperlink and as text, the paste field, then
// a token for a good code or "OAuth error" for another.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { claudeSignIn, plainText, printedToken, signInError, signInUrl } from '../image/runner/claude-sign-in.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const URL_TEXT = 'https://claude.ai/oauth/authorize?IeTNORyX8crYI1Al5bOf5n3lUsK-AglIiTg2gkdiJuWw';
const TOKEN = `sk-ant-oat01-${'a1B2c3D4'.repeat(12)}`;
const SCREEN = `${ESC}[?25l Welcome to Claude Code v2.1.330\r\n Browser didn't open? Use the URL below to sign in (c to copy)\r\n ${ESC}]8;id=v7ejox;${URL_TEXT}${BEL}${URL_TEXT}${ESC}]8;;${BEL}\r\n Paste code here if prompted\r\n╭──╮\r\n`;
const REFUSED = ` ${ESC}[31m✘ OAuth error: That code wasn't accepted. It may be incomplete, expired,${ESC}[39m\r\n already used, or from an earlier sign-in attempt. Sign in again to get a new\r\n code.\r\n Press ${ESC}[1mEnter${ESC}[22m to retry\r\n`;
const ACCEPTED = ` ✓ Long-lived authentication token created successfully!\r\n Your OAuth token (valid for 1 year):\r\n ${TOKEN}\r\n Store this token securely. You won't be able to see it again.\r\n`;

/** A `script -qfc "claude setup-token"` stand-in: prints the screen, then answers the code typed. */
function fakeSetupToken({ accept = 'good-code#state', printUrl = true } = {}) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.signalCode = signal;
    };
    let typed = '';
    child.stdin.on('data', (chunk) => {
      typed += chunk;
      if (typed.endsWith('\r')) child.stdout.write(typed.trim() === accept ? ACCEPTED : REFUSED);
    });
    setTimeout(() => child.stdout.write(printUrl ? SCREEN : ' Welcome\r\n'), 5);
    return child;
  };
  return { spawn, calls };
}

function broker({ codes = ['good-code#state'] } = {}) {
  const seen = { url: [], tokens: [], failed: [], polls: 0 };
  const queue = [...codes];
  return {
    seen,
    claudeSignIn: {
      url: async (u) => void seen.url.push(u),
      code: async () => {
        seen.polls += 1;
        // Waiting for the member on the first look, the code on the next.
        return seen.polls < 2 ? null : (queue.shift() ?? null);
      },
      token: async (t) => void seen.tokens.push(t),
      failed: async (r) => void seen.failed.push(r),
    },
  };
}

const fast = { urlTimeoutMs: 2_000, codeTimeoutMs: 2_000, exchangeTimeoutMs: 2_000, pollMs: 5 };
const jobUser = { home: '/home/updraft', name: 'updraft' };

describe('reading what claude setup-token prints', () => {
  it('finds the sign-in URL, the token and a refusal in terminal output', () => {
    expect(signInUrl(SCREEN)).toBe(URL_TEXT);
    expect(signInUrl(' Welcome\r\n')).toBeNull();
    expect(printedToken(ACCEPTED)).toBe(TOKEN);
    expect(printedToken(REFUSED)).toBeNull();
    expect(signInError(SCREEN + REFUSED)).toMatch(/^That code wasn't accepted\. It may be incomplete, expired, already used/);
    expect(signInError(SCREEN)).toBeNull();
    expect(plainText(SCREEN)).toContain('Paste code here if prompted');
    expect(plainText(SCREEN)).not.toContain(ESC);
  });
});

describe('claudeSignIn', () => {
  it('runs setup-token under a pseudo-terminal as the job user, hands the URL over, types the code, and returns the token', async () => {
    const child = fakeSetupToken();
    const b = broker();
    const logs = [];
    const out = await claudeSignIn({ ...b, spawn: child.spawn, jobUser: { ...jobUser, uid: process.getuid?.() ?? undefined, gid: process.getgid?.() ?? undefined }, log: (m) => logs.push(m) }, fast);
    expect(out).toEqual({ ok: true, token: TOKEN });
    expect(b.seen.url).toEqual([URL_TEXT]);
    expect(b.seen.tokens).toEqual([TOKEN]);
    expect(b.seen.failed).toEqual([]);
    const [call] = child.calls;
    expect(call.cmd).toBe('script');
    expect(call.args).toEqual(['-qfc', 'claude setup-token', '/dev/null']);
    // Nothing of the runner's environment: no AWS credentials, its own throwaway home.
    expect(Object.keys(call.options.env).sort()).toEqual(['COLUMNS', 'HOME', 'LANG', 'LINES', 'PATH', 'TERM']);
    expect(call.options.env.HOME).toMatch(/updraft-claude-sign-in-/);
    // The token is never logged.
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('says why when Claude refuses the code, and saves nothing', async () => {
    const child = fakeSetupToken();
    const b = broker({ codes: ['wrong#state'] });
    const out = await claudeSignIn({ ...b, spawn: child.spawn, jobUser, log: () => {} }, fast);
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/^Claude did not accept the code: That code wasn't accepted/) });
    expect(b.seen.tokens).toEqual([]);
    expect(b.seen.failed).toEqual([out.reason]);
  });

  it('gives up when no code comes in time, when setup-token prints no URL, or when the microVM is stopped', async () => {
    const waiting = broker({ codes: [] });
    expect(await claudeSignIn({ ...waiting, spawn: fakeSetupToken().spawn, jobUser, log: () => {} }, { ...fast, codeTimeoutMs: 50 })).toMatchObject({ ok: false, reason: expect.stringMatching(/^no code was given within/) });
    expect(waiting.seen.url).toEqual([URL_TEXT]);

    const silent = broker();
    expect(await claudeSignIn({ ...silent, spawn: fakeSetupToken({ printUrl: false }).spawn, jobUser, log: () => {} }, { ...fast, urlTimeoutMs: 50 })).toMatchObject({ ok: false, reason: 'claude setup-token did not print a sign-in URL' });
    expect(silent.seen.url).toEqual([]);

    const stopped = broker({ codes: [] });
    expect(await claudeSignIn({ ...stopped, spawn: fakeSetupToken().spawn, jobUser, log: () => {}, stopped: () => stopped.seen.url.length > 0 }, fast)).toMatchObject({ ok: false, reason: 'the microVM was stopped before a code was given' });
  });
});

describe('a refused credential, at the finish', () => {
  it("is reported when Claude answered 401 or said to sign in again, in the run's job or a later one", async () => {
    const { agentAuthFailed, finishDetail } = await import('../image/runner/job.mjs');
    const failed = (error) => ({ summary: { outcome: 'failed', error } });
    expect(agentAuthFailed(failed('claude reported an error (API status 401) (authentication_error): OAuth token has expired'))).toBe(true);
    expect(agentAuthFailed(failed('Invalid API key · Please run /login'))).toBe(true);
    expect(agentAuthFailed({ summary: { outcome: 'failed', followOnJobs: [{ message: 'claude reported an error (API status 401)' }] } })).toBe(true);
    expect(agentAuthFailed(failed('claude reported an error (API status 400) (api_error): Credit balance is too low'))).toBe(false);
    expect(agentAuthFailed({})).toBe(false);
    expect(finishDetail({ updraftOutcome: 'failed', ...failed('API status 401') }).authFailed).toBe(true);
    expect(finishDetail({ updraftOutcome: 'failed', ...failed('verification failed') }).authFailed).toBeUndefined();
  });
});
