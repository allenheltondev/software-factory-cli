// Test-only: installs test/fake-runtime.mjs as an executable "container runtime" in a temp
// directory, and reads back what it was asked to do. POSIX only (containerized agents are not
// supported on native Windows).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url));

export interface FakeRuntimeCall {
  argv: string[];
  /** For `run`: the container's name, once its command has started. */
  started?: string;
  /** For `run`: the environment the command got. */
  env?: Record<string, string>;
}

export interface FakeRuntime {
  /** Path to use as agents.<name>.container.runtime. */
  path: string;
  state: string;
  calls(): FakeRuntimeCall[];
  /** Calls whose first argument is `subcommand`. */
  callsOf(subcommand: string): FakeRuntimeCall[];
  /** Pid of the named container's command (its process group leader), or null when it isn't running. */
  containerPid(name: string): number | null;
  /** Make every later call fail the way a stopped daemon does. */
  stopDaemon(): void;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function installFakeRuntime(dir: string, name = 'docker'): FakeRuntime {
  const state = join(dir, 'runtime state');
  mkdirSync(state, { recursive: true });
  const path = join(dir, name);
  // A wrapper so the runtime is one executable path, with its state directory fixed whatever
  // environment it is called from (the executor, reconcile, doctor).
  writeFileSync(path, `#!/bin/sh\nFAKE_RUNTIME_STATE=${shQuote(state)} exec ${shQuote(process.execPath)} ${shQuote(SCRIPT)} "$@"\n`, { mode: 0o755 });
  const calls = (): FakeRuntimeCall[] => {
    const file = join(state, 'calls.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeRuntimeCall);
  };
  return {
    path,
    state,
    calls,
    callsOf: (sub) => calls().filter((c) => c.argv[0] === sub),
    containerPid(n) {
      try {
        return Number(readFileSync(join(state, `${n}.pid`), 'utf8'));
      } catch {
        return null;
      }
    },
    stopDaemon: () => writeFileSync(join(state, 'daemon-down'), ''),
  };
}
