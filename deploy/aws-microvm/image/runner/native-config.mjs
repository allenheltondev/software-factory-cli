import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

export const NATIVE_RUNTIME = '/opt/updraft/bin/updraft-native-worker';
export const NATIVE_IMAGE = 'native-claude-worker';
export const NATIVE_GROUP = 'native-claude-worker';

/** Root-owned runner policy, applied only after Cloud selected this dedicated worker. */
export function nativeConfig(config) {
  if (!config || typeof config !== 'object' || !config.agents || config.triage) throw new Error('native worker requires agent profiles and no triage');
  config.maxConcurrent = 1;
  config.capacity ??= {};
  config.capacity.groups ??= {};
  config.capacity.groups[NATIVE_GROUP] = { maxConcurrent: 1 };
  let count = 0;
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent || agent.enabled === false) continue;
    if ((agent.adapter ?? name) !== 'claude') continue;
    count++;
    // No inherited API auth, alternate CLI, flags, container env, settings or mounts.
    delete agent.authentication;
    agent.command = 'claude';
    agent.maxConcurrent = 1;
    agent.capacityGroup = NATIVE_GROUP;
    agent.container = { runtime: NATIVE_RUNTIME, image: NATIVE_IMAGE, network: 'none', env: [] };
  }
  if (!count) throw new Error('native worker configuration has no enabled Claude profile');
  return config;
}

export async function configureNativeJob(stateDir) {
  const file = path.join(stateDir, 'config.yaml');
  await fs.writeFile(file, stringify(nativeConfig(parse(await fs.readFile(file, 'utf8')))), { mode: 0o600 });
}
