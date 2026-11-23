// Claude subscription sign-in for a job that has no Claude credential (Updraft Cloud).
//
// The tenant has neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN, so the broker starts
// the job with `claudeSignIn`. Before `run-event`, the runner runs the real `claude setup-token`
// (Claude Code's own sign-in for a long-lived token), as the job user and under a pseudo-terminal,
// because without one it prints nothing:
//
//   1. it prints a claude.ai sign-in URL: the broker posts a link on the issue to a page of the
//      console where a member of the installation opens it and signs in;
//   2. claude.ai shows that member a code, which they paste on the console page: the broker hands
//      it here, and it is typed into `setup-token`, which exchanges it (the code is useless
//      without the verifier this process holds);
//   3. `setup-token` prints the token: it goes to the broker, which saves it as the tenant's
//      CLAUDE_CODE_OAUTH_TOKEN for every later job, and this job runs with it.
//
// Seen in a MicroVM (Claude Code 2.1.330, 2026-11-22): without a terminal `setup-token` waits
// and prints nothing; under `script` it prints the URL (as an OSC 8 hyperlink and as text) and a
// "Paste code here if prompted" field; a code typed there is exchanged, and a refused one prints
// "OAuth error: ...". The token is never logged: only its shape is checked here.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** The sign-in URL `setup-token` printed, or null. Pure. */
export function signInUrl(output) {
  const match = /https:\/\/claude\.ai\/oauth\/authorize\?[A-Za-z0-9._~%&=+/-]+/.exec(String(output));
  return match ? match[0] : null;
}

/** The long-lived token `setup-token` printed after a code was accepted, or null. Pure. */
export function printedToken(output) {
  const match = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/.exec(String(output));
  return match ? match[0] : null;
}

/** Terminal output as text: escape sequences dropped, one space where the cursor moved. Pure. */
export function plainText(output) {
  return String(output)
    .split(`${ESC}]`)
    .map((part, i) => {
      if (i === 0) return part;
      const end = [part.indexOf(BEL), part.indexOf(`${ESC}\\`)].filter((n) => n >= 0);
      return end.length ? part.slice(Math.min(...end) + (part[Math.min(...end)] === BEL ? 1 : 2)) : '';
    })
    .join('')
    .replace(new RegExp(`${ESC}\\[[0-9;?>]*[a-zA-Z]`, 'g'), ' ')
    .replace(new RegExp(`${ESC}[=>78()B]`, 'g'), '')
    .replace(/\r/g, '');
}

/** Why `setup-token` refused the code ("That code wasn't accepted. ..."), or null. Pure. */
export function signInError(output) {
  const text = plainText(output).replace(/\s+/g, ' ');
  const match = /OAuth error:\s*(.*?)(?:\s*Press\s+Enter\s+to\s+retry|$)/i.exec(text);
  return match ? match[1].trim().slice(0, 300) || 'the code was not accepted' : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs in. Resolves to `{ ok: true, token }` or `{ ok: false, reason }`; never throws for what
 * the member or Claude did (only for a broker that cannot be reached at all).
 *
 * @param {object} deps
 * @param {{ url(u: string): Promise<unknown>, code(): Promise<string|null>, token(t: string): Promise<unknown>, failed(r: string): Promise<unknown> }} deps.claudeSignIn
 * @param {{ uid?: number, gid?: number, home: string, name: string }} deps.jobUser
 * @param {(message: string) => void} deps.log
 * @param {() => boolean} [deps.stopped] the microVM is going away: stop waiting
 * @param {object} [options]
 */
export async function claudeSignIn(deps, { command = 'claude', urlTimeoutMs = 60_000, codeTimeoutMs = 15 * 60_000, exchangeTimeoutMs = 60_000, pollMs = 5_000, now = Date.now } = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const stopped = deps.stopped ?? (() => false);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'updraft-claude-sign-in-'));
  if (deps.jobUser.uid !== undefined && deps.jobUser.gid !== undefined) await fs.chown(home, deps.jobUser.uid, deps.jobUser.gid);
  let child;
  let output = '';
  const fail = async (reason) => {
    deps.log(`Claude sign-in failed: ${reason}`);
    await deps.claudeSignIn.failed(reason).catch((error) => deps.log(`could not tell the broker the sign-in failed: ${error?.message ?? error}`));
    return { ok: false, reason };
  };
  /** Waits until `found(output)` gives something, the child exits, or the time is up. */
  const until = async (found, timeoutMs) => {
    const end = now() + timeoutMs;
    for (;;) {
      const value = found(output);
      if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null || stopped() || now() >= end) return null;
      await sleep(Math.min(200, pollMs));
    }
  };
  try {
    // Under a pseudo-terminal (util-linux `script`), wide enough that nothing it prints wraps.
    // Its own home: what Claude Code writes there is thrown away with it.
    const options = {
      cwd: home,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color', COLUMNS: '400', LINES: '50' },
    };
    if (deps.jobUser.uid !== undefined) options.uid = deps.jobUser.uid;
    if (deps.jobUser.gid !== undefined) options.gid = deps.jobUser.gid;
    child = spawn('script', ['-qfc', `${command} setup-token`, '/dev/null'], options);
    child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-64 * 1024)));
    child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-64 * 1024)));
    child.on('error', (error) => (output += `\nspawn failed: ${error.message}`));

    const url = await until(signInUrl, urlTimeoutMs);
    if (!url) return await fail('claude setup-token did not print a sign-in URL');
    await deps.claudeSignIn.url(url);
    deps.log('Claude sign-in: waiting for a member of the installation to sign in and give the code (the link is on the issue)');

    const codeEnd = now() + codeTimeoutMs;
    let code = null;
    while (!code) {
      if (stopped()) return await fail('the microVM was stopped before a code was given');
      if (now() >= codeEnd) return await fail(`no code was given within ${Math.round(codeTimeoutMs / 60_000)} minutes`);
      if (child.exitCode !== null || child.signalCode !== null) return await fail('claude setup-token ended before a code was given');
      code = await deps.claudeSignIn.code();
      if (!code) await sleep(pollMs);
    }
    // The code, then Enter on its own, as a person would type it.
    child.stdin.write(code.trim());
    await sleep(500);
    child.stdin.write('\r');

    const done = await until((out) => printedToken(out) ?? (signInError(out) ? { error: signInError(out) } : null), exchangeTimeoutMs);
    if (!done) return await fail('claude setup-token printed no token after the code was given');
    if (typeof done === 'object') return await fail(`Claude did not accept the code: ${done.error}`);
    await deps.claudeSignIn.token(done);
    deps.log('Claude sign-in: done; the token is saved for this installation\'s later jobs');
    return { ok: true, token: done };
  } catch (error) {
    return await fail(error?.message ?? String(error));
  } finally {
    try {
      if (child && child.exitCode === null) child.kill('SIGKILL');
    } catch {
      // gone
    }
    output = '';
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
