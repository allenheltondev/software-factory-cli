import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLegacyInstall, legacyInstallNotice, legacyLocations, resolvePaths } from './paths.js';

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

describe('legacy per-OS install', () => {
  const home = resolve('/home/jane');

  it('knows where each platform used to keep its files', () => {
    expect(legacyLocations({ env: {}, homedir: home, platform: 'linux' })).toEqual({
      configFile: join(home, '.config', 'updraft', 'config.yaml'),
      dataDir: join(home, '.local', 'state', 'updraft'),
    });
    expect(legacyLocations({ env: { XDG_CONFIG_HOME: resolve('/x/c'), XDG_STATE_HOME: resolve('/x/s') }, homedir: home, platform: 'linux' })).toEqual({
      configFile: join(resolve('/x/c'), 'updraft', 'config.yaml'),
      dataDir: join(resolve('/x/s'), 'updraft'),
    });
    expect(legacyLocations({ env: {}, homedir: home, platform: 'darwin' })).toEqual({
      configFile: join(home, 'Library', 'Application Support', 'updraft', 'config.yaml'),
      dataDir: join(home, 'Library', 'Application Support', 'updraft'),
    });
    const win = { APPDATA: resolve('/w/Roaming'), LOCALAPPDATA: resolve('/w/Local') };
    expect(legacyLocations({ env: win, homedir: home, platform: 'win32' })).toEqual({
      configFile: join(resolve('/w/Roaming'), 'updraft', 'config.yaml'),
      dataDir: join(resolve('/w/Local'), 'updraft'),
    });
  });

  const legacyConfig = join(home, '.config', 'updraft', 'config.yaml');
  const newConfig = join(home, '.updraft', 'config.yaml');
  const only = (...files: string[]) => (p: string) => files.includes(p);
  const base = { env: {}, homedir: home, platform: 'linux' as const };

  it('is reported when the default home has no config and the old one does', () => {
    expect(findLegacyInstall({ ...base, exists: only(legacyConfig) })).toEqual({
      configFile: legacyConfig,
      dataDir: join(home, '.local', 'state', 'updraft'),
    });
  });

  it('is not reported once ~/.updraft has a config, or when nothing was there', () => {
    expect(findLegacyInstall({ ...base, exists: only(legacyConfig, newConfig) })).toBeNull();
    expect(findLegacyInstall({ ...base, exists: only() })).toBeNull();
  });

  it('is not reported when the user chose the location', () => {
    const exists = only(legacyConfig);
    expect(findLegacyInstall({ ...base, exists, env: { UPDRAFT_HOME: resolve('/srv/u') } })).toBeNull();
    expect(findLegacyInstall({ ...base, exists, env: { UPDRAFT_CONFIG: resolve('/etc/u.yaml') } })).toBeNull();
    expect(findLegacyInstall({ ...base, exists, configPath: resolve('/etc/u.yaml') })).toBeNull();
  });

  it('tells how to keep using it unchanged', () => {
    const legacy = { configFile: legacyConfig, dataDir: join(home, '.local', 'state', 'updraft') };
    const text = legacyInstallNotice(legacy, { configDir: join(home, '.updraft') }).join('\n');
    expect(text).toContain(`UPDRAFT_CONFIG=${legacyConfig}`);
    expect(text).toContain(`UPDRAFT_HOME=${legacy.dataDir}`);
    expect(text).toContain('Moving from the per-OS locations');
  });
});
