/**
 * Is this CLI running out of npm's npx cache? `npx <pkg>` installs the package under
 * `<npm cache>/_npx/<hash>/node_modules/` (the cache is ~/.npm by default on macOS and Linux and
 * %LocalAppData%\npm-cache on Windows), so the CLI's own file path has a `_npx` segment with a
 * `node_modules` below it. Either separator is accepted, so a Windows path is recognized on any OS.
 */
export function isInNpxCache(file: string): boolean {
  const parts = file.split(/[\\/]+/);
  const i = parts.indexOf('_npx');
  return i > 0 && parts.indexOf('node_modules', i + 1) > i;
}

/** What `updraft start` logs when {@link isInNpxCache} is true. It never blocks startup. */
export const NPX_START_WARNING =
  'updraft is running from the npx cache; for background use, install it globally with "npm install -g @allenheltondev/updraft". ' +
  'npx can clear or change its cache folder, and an unpinned npx can run a newer CLI that upgrades the state database past what this worker supports';
