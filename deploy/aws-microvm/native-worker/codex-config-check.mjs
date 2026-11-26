#!/usr/bin/env node
// Image build guard (#125): the real pinned Codex binary must accept the worker's whole launch
// argv. `codexArgs` runs Codex under `--strict-config`, so a key that release does not know (a
// renamed or removed feature) would end every Codex job at startup. This runs exactly that argv
// once, at image build time (install.sh), and fails the build on any configuration error.
//
// How it stays offline and signed out: a fresh, empty CODEX_HOME (no login, no config), a private
// empty cwd, no inherited environment, and every proxy variable pointing at a closed local port,
// so nothing can leave the machine. The one MCP server the argv configures is `/bin/false`: Codex
// parses and validates every `-c` override first ("Error loading config.toml: unknown
// configuration field ..." is the strict failure), and only then starts the required MCP server,
// whose failed handshake ends the run before any thread, model or network call. So the expected
// outcome is exactly "required MCP servers failed to initialize", and anything else fails.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEAD_PROXY = 'http://127.0.0.1:9';

/** What one guarded run printed means: `ok`, or why the argv is not accepted. */
export function judgeCodexConfigRun({ status, signal, stdout = '', stderr = '' }) {
  const out = `${stdout}\n${stderr}`;
  const unknown = /unknown configuration field `([^`]{1,200})`/.exec(out);
  if (unknown) return { ok: false, reason: `the pinned Codex does not know ${unknown[1]}` };
  if (/Error loading config/i.test(out)) return { ok: false, reason: 'the pinned Codex refused the worker configuration' };
  if (signal) return { ok: false, reason: `Codex was stopped by ${signal}` };
  if (/required MCP servers failed to initialize/.test(out) && status !== 0) return { ok: true };
  return { ok: false, reason: `unexpected Codex outcome (exit ${status ?? 'none'})` };
}

/** Runs the pinned binary with the worker's real argv; returns the judgement. */
export async function checkCodexConfig(binary, { policy = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'policy.mjs')).href, run = spawnSync, timeoutMs = 120_000 } = {}) {
  const { codexArgs } = await import(policy);
  const args = codexArgs(['exec', '--json', '-c', 'model_reasoning_effort="medium"'], { command: '/bin/false', args: [] });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'updraft-codex-check-'));
  const home = path.join(scratch, 'home');
  const cwd = path.join(scratch, 'cwd');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  try {
    const result = run(binary, args, {
      cwd, input: 'Configuration check: do nothing.', encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, CODEX_HOME: home,
        HTTPS_PROXY: DEAD_PROXY, HTTP_PROXY: DEAD_PROXY, ALL_PROXY: DEAD_PROXY, https_proxy: DEAD_PROXY, http_proxy: DEAD_PROXY, all_proxy: DEAD_PROXY, NO_PROXY: '' },
    });
    if (result.error && result.error.code !== 'ETIMEDOUT') return { ok: false, reason: `Codex could not start (${result.error.code ?? 'error'})` };
    return judgeCodexConfigRun(result);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = process.argv[2];
  if (!binary) { console.error('Usage: codex-config-check.mjs <codex native binary>'); process.exit(2); }
  const verdict = await checkCodexConfig(binary);
  if (!verdict.ok) { console.error(`Codex configuration check failed: ${verdict.reason}`); process.exit(1); }
  console.log('Codex configuration check passed: the pinned Codex accepts the worker launch arguments.');
}
