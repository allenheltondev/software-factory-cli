// `factory doctor`: each repo's checkoutPath must be a clone of that repo. The remote is
// chosen with the same rule the worker uses (selectRepoRemote); the repo check confirms
// the ID behind the configured name via the API.
import { resolve } from 'node:path';
import { repoNeedsCheckout, type FactoryConfig } from '../config/schema.js';
import { redactRemoteUrl, selectRepoRemote, type Remote } from '../git/git.js';
import type { FactoryPaths } from '../paths.js';
import type { CheckResult, CheckStatus, DoctorProbes } from './doctor.js';

export async function checkRepoCheckouts(
  config: FactoryConfig,
  paths: Pick<FactoryPaths, 'configDir'>,
  probes: Pick<DoctorProbes, 'which' | 'run' | 'fileExists'>,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const git = probes.which('git');
  for (const [fullName, repo] of Object.entries(config.repositories)) {
    if (!repo.checkoutPath) continue; // validation already requires it where the mode needs it
    const name = `checkout ${fullName}`;
    const required = config.execution.mode === 'prepare-only' && repoNeedsCheckout(config, repo);
    const sev: CheckStatus = required ? 'fail' : 'warn';
    const add = (status: CheckStatus, detail: string) => checks.push({ status, name, detail });
    const dir = resolve(paths.configDir, repo.checkoutPath);

    if (!probes.fileExists(dir)) {
      add(sev, `${dir} does not exist; clone ${fullName} there or fix checkoutPath`);
      continue;
    }
    if (!git) {
      add(sev, `cannot check ${dir}: git not found on PATH`);
      continue;
    }
    const inRepo = await probes.run(git, ['-C', dir, 'rev-parse', '--git-dir']).catch(() => null);
    if (inRepo?.code !== 0) {
      add(sev, `${dir} is not a git repository; clone ${fullName} there`);
      continue;
    }
    const listed = await probes.run(git, ['-C', dir, 'remote']).catch(() => null);
    const remotes: Remote[] = [];
    for (const r of (listed?.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const url = await probes.run(git, ['-C', dir, 'remote', 'get-url', r]).catch(() => null);
      if (url?.code === 0) remotes.push({ name: r, url: url.stdout.trim() });
    }
    const selection = selectRepoRemote(remotes, fullName, repo.remote);
    if (!selection.ok) {
      add(sev, `${dir}: ${selection.error}`);
      continue;
    }
    const { remote } = selection;
    add('ok', `${dir}: using remote ${remote.name} (${redactRemoteUrl(remote.url)}); ${selection.reason}`);
  }
  return checks;
}
