import { describe, expect, it } from 'vitest';
import { isInNpxCache } from './npx.js';

describe('isInNpxCache', () => {
  it('recognizes the npx cache on POSIX paths', () => {
    expect(isInNpxCache('/home/jane/.npm/_npx/6a9f1c2b3d4e5f60/node_modules/@allenheltondev/updraft/dist/commands/start.js')).toBe(true);
    expect(isInNpxCache('/Users/jane/.npm/_npx/6a9f1c2b3d4e5f60/node_modules/.bin/updraft')).toBe(true);
    // A custom npm cache (npm_config_cache) still has the _npx folder.
    expect(isInNpxCache('/var/cache/npm/_npx/abc/node_modules/@allenheltondev/updraft/dist/cli.js')).toBe(true);
  });

  it('recognizes the npx cache on Windows paths', () => {
    expect(isInNpxCache('C:\\Users\\Jane Doe\\AppData\\Local\\npm-cache\\_npx\\6a9f1c2b3d4e5f60\\node_modules\\@allenheltondev\\updraft\\dist\\commands\\start.js')).toBe(true);
    expect(isInNpxCache('C:/Users/jane/AppData/Local/npm-cache/_npx/abc/node_modules/@allenheltondev/updraft/dist/cli.js')).toBe(true);
  });

  it('does not flag a global install, a checkout, or a folder merely named like _npx', () => {
    expect(isInNpxCache('/usr/local/lib/node_modules/@allenheltondev/updraft/dist/commands/start.js')).toBe(false);
    expect(isInNpxCache('/home/jane/.npm-global/lib/node_modules/@allenheltondev/updraft/dist/cli.js')).toBe(false);
    expect(isInNpxCache('C:\\Users\\jane\\AppData\\Roaming\\npm\\node_modules\\@allenheltondev\\updraft\\dist\\cli.js')).toBe(false);
    expect(isInNpxCache('C:\\git\\updraft\\dist\\cli.js')).toBe(false);
    expect(isInNpxCache('/home/jane/my_npx/node_modules/@allenheltondev/updraft/dist/cli.js')).toBe(false);
    expect(isInNpxCache('/home/jane/_npx/notes.txt')).toBe(false);
  });
});
