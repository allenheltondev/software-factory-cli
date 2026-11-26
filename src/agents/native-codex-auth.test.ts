import { describe, expect, it } from 'vitest';
import {
  checkNativeCodexAuth,
  defaultNativeCodexAuthRunner,
  hasCodexAuthOverride,
  nativeCodexAuthFromStatus,
  nativeCodexAuthHint,
} from './native-codex-auth.js';
import { CODEX_DIRECT_MODELS, CODEX_SUBSCRIPTION_ARGS, codexSubscriptionArgProblem, codexSubscriptionEnvProblem, isolatedCodexModelProblem, onNativeWorker } from './native-codex-args.js';

const status = (output: string, code: number | null = 0) => ({ code, output });

describe('native Codex (Sign in with ChatGPT) status, without inspecting credentials', () => {
  it('accepts only the official ChatGPT sign-in sentence with exit 0', () => {
    expect(nativeCodexAuthFromStatus(status('Logged in using ChatGPT\n'))).toEqual({ state: 'connected', reason: 'chatgpt_subscription' });
    // A banner or warning around the status line does not change the answer.
    expect(nativeCodexAuthFromStatus(status('WARNING: a newer version is available\nLogged in using ChatGPT\n')))
      .toEqual({ state: 'connected', reason: 'chatgpt_subscription' });
    expect(nativeCodexAuthFromStatus(status('Logged in using ChatGPT\n'), { CODEX_HOME: '/private/codex' }).state).toBe('connected');
  });

  it('asks for a sign-in only when the CLI says it holds no credential', () => {
    expect(nativeCodexAuthFromStatus(status('Not logged in\n', 1))).toEqual({ state: 'login_required', reason: 'sign_in_required' });
  });

  it.each([
    'API key configured - sk-proj-***ABCD\nAPI key authentication is billed separately.',
    'Logged in using access token',
    'Logged in using personal access token',
    'Logged in using Amazon Bedrock API key',
    'Logged in using Amazon Bedrock AWS access keys',
    'Logged in using workload identity',
  ])('rejects %j as subscription auth', (text) => {
    expect(nativeCodexAuthFromStatus(status(text))).toEqual({ state: 'wrong_method', reason: 'not_subscription' });
  });

  it('fails closed on mixed, unknown, inconsistent or oversized output', () => {
    for (const r of [
      status('Logged in using ChatGPT\nAPI key configured - sk-***'),
      status('Logged in using ChatGPT', 1),
      status('Not logged in', 0),
      status('Error checking login status: something', 1),
      status('', 0),
      status('Logged in using ChatGPT', null),
      status(`Logged in using ChatGPT\n${'x'.repeat(70_000)}`),
      status('logged in using chatgpt'),
    ]) {
      expect(['unknown', 'wrong_method']).toContain(nativeCodexAuthFromStatus(r).state);
      expect(nativeCodexAuthFromStatus(r).state).not.toBe('connected');
    }
  });

  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_FEDERATION_RULE_ID',
    'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_AUTHAPI_BASE_URL', 'openai_api_key',
    'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])(
    'treats %s as an override, whatever the CLI says', (name) => {
      expect(hasCodexAuthOverride({ [name]: 'SECRET_DO_NOT_LOG' })).toBe(true);
      expect(nativeCodexAuthFromStatus(status('Logged in using ChatGPT'), { [name]: 'SECRET_DO_NOT_LOG' }))
        .toEqual({ state: 'wrong_method', reason: 'auth_override_present' });
    },
  );

  it('ignores empty override variables and unrelated names', () => {
    expect(hasCodexAuthOverride({ OPENAI_API_KEY: '', CODEX_HOME: '/x', ANTHROPIC_API_KEY: 'other provider', PATH: '/bin' })).toBe(false);
    // A proxy alone cannot read TLS traffic while only the system roots are trusted.
    expect(hasCodexAuthOverride({ HTTPS_PROXY: 'http://proxy:3128', ALL_PROXY: 'http://proxy:3128' })).toBe(false);
  });

  it('does not start the CLI when an override is present, and treats a throwing probe as unknown', async () => {
    let calls = 0;
    const run = async () => { calls++; return status('Logged in using ChatGPT'); };
    expect(await checkNativeCodexAuth({ file: 'codex', args: [] }, { CODEX_API_KEY: 'x' }, run)).toEqual({ state: 'wrong_method', reason: 'auth_override_present' });
    expect(calls).toBe(0);
    expect(await checkNativeCodexAuth({ file: 'codex', args: [] }, {}, async () => { throw new Error('token=SECRET'); }))
      .toEqual({ state: 'unknown', reason: 'status_unavailable' });
  });

  it('runs `login status` without a shell and reads the status from stderr', async () => {
    const launch = { file: process.execPath, args: ['-e', 'process.stderr.write(process.argv.slice(1).join(",") + "\\n"); process.exit(0)'] };
    const run = await defaultNativeCodexAuthRunner(launch, { PATH: process.env.PATH });
    expect(run.code).toBe(0);
    expect(run.output).toContain('login,status');
    const signedOut = { file: process.execPath, args: ['-e', 'process.stderr.write("Not logged in\\n"); process.exit(1)'] };
    expect(nativeCodexAuthFromStatus(await defaultNativeCodexAuthRunner(signedOut, { PATH: process.env.PATH }))).toEqual({ state: 'login_required', reason: 'sign_in_required' });
  });

  it('has hints naming the official commands only', () => {
    expect(nativeCodexAuthHint('sign_in_required')).toContain('codex login --device-auth');
    expect(nativeCodexAuthHint('not_subscription')).toContain('codex logout');
    expect(nativeCodexAuthHint('status_unavailable')).toContain('codex login status');
  });
});

describe('native Codex profile arguments', () => {
  it.each([
    [['-c', 'model_provider="azure"'], 'model_provider'],
    [['-c', 'model_providers.x.env_key="KEY"'], 'model_providers.x.env_key'],
    [['--config=forced_login_method="api"'], 'forced_login_method'],
    [['-c', 'cli_auth_credentials_store="keyring"'], 'cli_auth_credentials_store'],
    [['-c', 'chatgpt_base_url="https://evil.example"'], 'chatgpt_base_url'],
    [['-c', 'openai_base_url="https://evil.example"'], 'openai_base_url'],
    [['--profile', 'work'], '--profile'],
    [['-p', 'work'], '-p'],
    [['--oss'], '--oss'],
    [['--local-provider=ollama'], '--local-provider'],
  ])('refuses %j', (args, named) => {
    expect(codexSubscriptionArgProblem(args)).toContain(named);
  });

  it('allows model, effort and ordinary options', () => {
    expect(codexSubscriptionArgProblem(['--model', 'gpt-5-codex', '-c', 'model_reasoning_effort="high"', '--sandbox', 'workspace-write'])).toBeNull();
  });

  it('allows only direct-mode models on the isolated native worker', () => {
    const worker = { runtime: '/opt/updraft/bin/updraft-native-worker', image: 'native-claude-worker' };
    expect(onNativeWorker({ container: worker })).toBe(true);
    expect(onNativeWorker({ container: { ...worker, image: 'other' } })).toBe(false);
    expect(onNativeWorker({ container: { ...worker, runtime: '/usr/local/bin/updraft-sandbox' } })).toBe(false);
    expect(onNativeWorker({})).toBe(false);
    expect([...CODEX_DIRECT_MODELS]).toEqual(['gpt-5.5']);
    expect(isolatedCodexModelProblem(null)).toBeNull();
    expect(isolatedCodexModelProblem('gpt-5.5')).toBeNull();
    for (const model of ['gpt-6-sol', 'gpt-5.6-luna', 'gpt-daybreak-red-latest', 'not-in-the-catalog']) {
      expect(isolatedCodexModelProblem(model)).toMatch(/code mode.*Use gpt-5\.5/);
    }
  });

  it('refuses a profile env that moves CODEX_HOME', () => {
    expect(codexSubscriptionEnvProblem({ CODEX_HOME: '/elsewhere' })).toContain('CODEX_HOME');
    expect(codexSubscriptionEnvProblem({ codex_home: '/elsewhere' })).toContain('codex_home');
    expect(codexSubscriptionEnvProblem({ FOO: '1' })).toBeNull();
    expect(codexSubscriptionEnvProblem(undefined)).toBeNull();
  });

  it('forces the built-in OpenAI provider, a ChatGPT-only login and the official backend', () => {
    expect([...CODEX_SUBSCRIPTION_ARGS]).toEqual(['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
      '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"']);
  });
});
