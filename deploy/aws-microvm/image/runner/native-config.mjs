import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

export const NATIVE_RUNTIME = '/opt/updraft/bin/updraft-native-worker';
export const NATIVE_IMAGE = 'native-claude-worker';
export const NATIVE_GROUP = 'native-claude-worker';

/**
 * Root-owned runner policy, applied only after Cloud selected this dedicated worker. `provider`
 * is the CLI the worker's session is signed in to: `claude` (the default, as before) or `codex`
 * (ChatGPT plan, #125). Its enabled profiles run on the native worker; every other agent keeps
 * its configured runtime and its own API key.
 */
export function nativeConfig(config, provider = 'claude') {
  if (!config || typeof config !== 'object' || !config.agents || config.triage) throw new Error('native worker requires agent profiles and no triage');
  if (provider !== 'claude' && provider !== 'codex') throw new Error('unknown native worker provider');
  config.maxConcurrent = 1;
  config.capacity ??= {};
  config.capacity.groups ??= {};
  config.capacity.groups[NATIVE_GROUP] = { maxConcurrent: 1 };
  let count = 0;
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent || agent.enabled === false) continue;
    if ((agent.adapter ?? name) !== provider) continue;
    count++;
    // No inherited API auth, alternate CLI, flags, container env, settings or mounts. The
    // supervisor checks the CLI's own login before every session (Claude's or ChatGPT's).
    delete agent.authentication;
    agent.command = provider;
    agent.maxConcurrent = 1;
    agent.capacityGroup = NATIVE_GROUP;
    agent.container = { runtime: NATIVE_RUNTIME, image: NATIVE_IMAGE, network: 'none', env: [] };
  }
  if (!count) throw new Error(`native worker configuration has no enabled ${provider === 'codex' ? 'Codex' : 'Claude'} profile`);
  return config;
}

export async function configureNativeJob(stateDir, provider = 'claude') {
  const file = path.join(stateDir, 'config.yaml');
  await fs.writeFile(file, stringify(nativeConfig(parse(await fs.readFile(file, 'utf8')), provider)), { mode: 0o600 });
}
