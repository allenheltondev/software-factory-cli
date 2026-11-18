import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from './paths.js';

describe('resolvePaths', () => {
  const home = resolve('/home/jane');

  it('defaults to ~/.updraft for config, state and logs on every platform', () => {
    const root = join(home, '.updraft');
    expect(resolvePaths({ env: {}, homedir: home })).toEqual({
      configFile: join(root, 'config.yaml'),
      configDir: root,
      dataDir: root,
      dbFile: join(root, 'state.db'),
      logDir: join(root, 'logs'),
      runsDir: join(root, 'logs', 'runs'),
    });
  });

  it('ignores the per-OS app-data variables', () => {
    const env = { APPDATA: resolve('/roaming'), LOCALAPPDATA: resolve('/local'), XDG_CONFIG_HOME: resolve('/xdg') };
    expect(resolvePaths({ env, homedir: home }).dataDir).toBe(join(home, '.updraft'));
  });

  it('moves everything under UPDRAFT_HOME', () => {
    const root = resolve('/srv/updraft');
    const p = resolvePaths({ env: { UPDRAFT_HOME: root }, homedir: home });
    expect(p.configFile).toBe(join(root, 'config.yaml'));
    expect(p.dbFile).toBe(join(root, 'state.db'));
    expect(p.runsDir).toBe(join(root, 'logs', 'runs'));
  });

  it('lets --config win over UPDRAFT_CONFIG and move only the config file', () => {
    const env = { UPDRAFT_CONFIG: resolve('/etc/env.yaml') };
    const p = resolvePaths({ env, homedir: home, configPath: resolve('/etc/flag.yaml') });
    expect(p.configFile).toBe(resolve('/etc/flag.yaml'));
    expect(p.configDir).toBe(resolve('/etc'));
    expect(p.dataDir).toBe(join(home, '.updraft'));
    expect(resolvePaths({ env, homedir: home }).configFile).toBe(resolve('/etc/env.yaml'));
  });
});
