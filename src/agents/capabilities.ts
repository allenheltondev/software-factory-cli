/**
 * Capability check for model/effort profiles: does the installed CLI advertise the option the
 * profile makes Updraft pass?
 *
 * The only thing read is the CLI's own help text (`<cli> --help`, `kiro-cli chat --help`). That
 * runs no model and sends no prompt, so it cannot use tokens or plan quota. Model and effort
 * *values* are not checked: Updraft keeps no list of names, and the CLI's own listing
 * (`kiro-cli chat --list-models`, `/model` in Claude Code and Codex) is the place to look.
 * When the help text cannot be read, the result says so ("unverified") instead of guessing.
 */
import type { AgentProfile } from './profile.js';

export interface CapabilityResult {
  /** ok: every option the profile uses is advertised. unsupported: one is missing. unverified: help could not be read. */
  state: 'ok' | 'unsupported' | 'unverified';
  /** Actionable messages; empty when ok or when the profile sets neither model nor effort. */
  messages: string[];
}

/** Arguments that print an adapter's option list. */
export function helpArgs(adapter: string): string[] | null {
  switch (adapter) {
    case 'claude':
    case 'codex':
    case 'vibe':
      return ['--help'];
    case 'kiro':
      return ['chat', '--help'];
    default:
      return null;
  }
}

/** The options each adapter uses for model and effort (see MAPPINGS in profile.ts). Codex sets effort through `-c`. */
const OPTIONS: Record<string, { model: string; effort?: string }> = {
  claude: { model: '--model', effort: '--effort' },
  codex: { model: '--model', effort: '--config' },
  kiro: { model: '--model', effort: '--effort' },
  vibe: { model: '--model' },
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `flag` appears in `help` as an option (not inside a longer name such as --effort-level). */
export function helpAdvertises(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,|\\[(])${escape(flag)}(?![\\w-])`, 'm').test(help);
}

const CLI_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro CLI', vibe: 'Mistral Vibe' };

/**
 * Compare what a profile asks for with what the CLI's help text advertises. `help` is null when
 * it could not be read (CLI missing, help failed or timed out).
 */
export function checkCapabilities(adapter: string, profile: Pick<AgentProfile, 'model' | 'effort'>, help: string | null): CapabilityResult {
  const opts = OPTIONS[adapter];
  const wants: { what: 'model' | 'effort'; flag: string }[] = [];
  if (opts) {
    if (profile.model.value !== null) wants.push({ what: 'model', flag: opts.model });
    if (profile.effort.value !== null && opts.effort) wants.push({ what: 'effort', flag: opts.effort });
  }
  if (!wants.length) return { state: 'ok', messages: [] };
  const cli = CLI_NAMES[adapter] ?? adapter;
  if (help === null || help.trim() === '') {
    return {
      state: 'unverified',
      messages: [`could not read ${cli}'s help text, so it is unverified that it accepts ${wants.map((w) => w.flag).join(' and ')}; run the CLI's help yourself to check`],
    };
  }
  const messages: string[] = [];
  for (const w of wants) {
    if (helpAdvertises(help, w.flag)) continue;
    const via = adapter === 'codex' && w.what === 'effort' ? ' (used as -c model_reasoning_effort=...)' : '';
    messages.push(
      `the installed ${cli} does not advertise ${w.flag}${via}, which ${w.what} needs; the run would fail at launch. ` +
        `Upgrade ${cli}, or remove ${w.what} from this agent (the CLI then uses its own default)`,
    );
  }
  return messages.length ? { state: 'unsupported', messages } : { state: 'ok', messages: [] };
}

/** Read an adapter's help text through `run`; null when it cannot be read. Never sends a prompt. */
export async function readHelp(
  adapter: string,
  launch: { file: string; args: readonly string[] } | null | undefined,
  run: (file: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>,
): Promise<string | null> {
  const extra = helpArgs(adapter);
  if (!launch || !extra) return null;
  try {
    const r = await run(launch.file, [...launch.args, ...extra]);
    const text = `${r.stdout}\n${r.stderr}`;
    return r.code === 0 && text.trim() !== '' ? text : null;
  } catch {
    return null;
  }
}
