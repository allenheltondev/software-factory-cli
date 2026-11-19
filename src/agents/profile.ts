/**
 * Model-aware agent profiles: the model and reasoning effort an agent entry will ask its CLI for.
 *
 * An agent (`agents.<name>`) is already a profile: several entries can share an adapter and login
 * (`claude-fast`, `claude-deep`, ...) and differ only in `args`. This module gives that a model
 * and effort view without a second source of truth:
 * - `model` / `effort` in the config are optional shorthands, mapped to the adapter's own CLI flags;
 * - otherwise the view is read from the existing `args` (`--model x`, `-c model_reasoning_effort=...`).
 * Nothing here calls a provider: values are only handed to the installed, signed-in CLI, and there
 * is no list of model names (they change per CLI version and plan; see docs/agents/profiles.md).
 *
 * Pure: no I/O.
 */
import type { AgentConfig } from '../config/schema.js';

export type ProfileSource = 'model/effort setting' | 'args' | 'cli default';

export interface ProfileSetting {
  /** The requested value; null when nothing is configured (the CLI picks its own default). */
  value: string | null;
  source: ProfileSource;
}

export interface AgentProfile {
  model: ProfileSetting;
  effort: ProfileSetting;
  /** Contradictory or duplicate settings; each message names what to change. */
  problems: string[];
}

type ProfileInput = Pick<AgentConfig, 'args' | 'model' | 'effort'>;

/** Occurrences of an option in `args`: `--name value` or `--name=value` (and short aliases). */
function optionValues(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) {
        if (i + 1 < args.length) out.push(args[i + 1]!);
        i++;
        break;
      }
      if (n.startsWith('--') && a.startsWith(`${n}=`)) {
        out.push(a.slice(n.length + 1));
        break;
      }
    }
  }
  return out;
}

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Values of `-c key=value` / `--config key=value` overrides for `key`, TOML quotes removed. */
function codexConfigValues(args: readonly string[], key: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let spec: string | null = null;
    if (a === '-c' || a === '--config') spec = args[++i] ?? null;
    else if (a.startsWith('--config=')) spec = a.slice('--config='.length);
    if (spec === null) continue;
    const eq = spec.indexOf('=');
    if (eq > 0 && spec.slice(0, eq).trim() === key) out.push(unquote(spec.slice(eq + 1)));
  }
  return out;
}

interface Mapping {
  modelFromArgs: (args: readonly string[]) => string[];
  effortArgs: (effort: string) => string[];
  effortFromArgs: (args: readonly string[]) => string[];
  /** How the effort is written in args, for messages. */
  effortHint: string;
}

const MAPPINGS: Record<string, Mapping> = {
  claude: {
    modelFromArgs: (a) => optionValues(a, ['--model']),
    effortArgs: (e) => ['--effort', e],
    effortFromArgs: (a) => optionValues(a, ['--effort']),
    effortHint: '--effort',
  },
  codex: {
    modelFromArgs: (a) => optionValues(a, ['--model', '-m']),
    effortArgs: (e) => ['-c', `model_reasoning_effort=${JSON.stringify(e)}`],
    effortFromArgs: (a) => codexConfigValues(a, 'model_reasoning_effort'),
    effortHint: '-c model_reasoning_effort=...',
  },
  kiro: {
    modelFromArgs: (a) => optionValues(a, ['--model']),
    effortArgs: (e) => ['--effort', e],
    effortFromArgs: (a) => optionValues(a, ['--effort']),
    effortHint: '--effort',
  },
};

/** What a model or effort value may not be: empty, a flag lookalike, or something a process cannot be given. */
export function settingProblem(value: string): string | null {
  if (value.trim() === '') return 'must not be empty';
  if (value.startsWith('-')) return 'must not start with "-" (it would be read as another option)';
  if (/[\0\r\n]/.test(value)) return 'must be a single line without control characters';
  return null;
}

function resolve(what: 'model' | 'effort', configured: string | undefined, fromArgs: string[], hint: string, problems: string[]): ProfileSetting {
  const distinct = [...new Set(fromArgs)];
  const shown = distinct.map((v) => `"${v}"`).join(', ');
  if (distinct.length > 1) problems.push(`args set ${what} more than once with different values (${shown}); keep one`);
  if (configured !== undefined) {
    if (fromArgs.length) {
      problems.push(
        distinct.length === 1 && distinct[0] === configured
          ? `${what} is set both as "${what}" and in args (${hint}); keep one of them`
          : `${what} "${configured}" contradicts args (${shown}); keep one of them`,
      );
    }
    return { value: configured, source: 'model/effort setting' };
  }
  // The CLI honors the last occurrence.
  const last = fromArgs[fromArgs.length - 1];
  return last === undefined ? { value: null, source: 'cli default' } : { value: last, source: 'args' };
}

/** The model/effort an agent entry asks for, and what is wrong with how it says so. */
export function agentProfile(adapter: string, agent: ProfileInput): AgentProfile {
  const args = agent.args ?? [];
  const map = MAPPINGS[adapter];
  const problems: string[] = [];
  for (const [what, v] of [['model', agent.model], ['effort', agent.effort]] as const) {
    const p = v === undefined ? null : settingProblem(v);
    if (p) problems.push(`${what} ${p}`);
  }
  if (!map) {
    const own = (v: string | undefined): ProfileSetting => (v === undefined ? { value: null, source: 'cli default' } : { value: v, source: 'model/effort setting' });
    return { model: own(agent.model), effort: own(agent.effort), problems };
  }
  const model = resolve('model', agent.model, map.modelFromArgs(args), '--model', problems);
  const effort = resolve('effort', agent.effort, map.effortFromArgs(args), map.effortHint, problems);
  return { model, effort, problems };
}

/**
 * agents.<name>.args plus the flags for `model` / `effort`, for the adapter to place. Values are
 * single argv elements (never shell-split), so a model name with spaces or a prefix such as
 * "provider/name" arrives intact. Legacy entries with only `args` come back unchanged.
 */
export function effectiveArgs(adapter: string, agent: ProfileInput): string[] {
  const args = [...(agent.args ?? [])];
  if (!MAPPINGS[adapter]) return args;
  if (agent.model !== undefined) args.push('--model', agent.model);
  if (agent.effort !== undefined) args.push(...MAPPINGS[adapter]!.effortArgs(agent.effort));
  return args;
}

/** One line for run logs and `updraft agents`: no secrets, and honest that this is what was requested, not what the CLI resolved. */
export function describeProfile(agentName: string, adapter: string, p: AgentProfile): string {
  const part = (what: string, s: ProfileSetting) => `${what} ${s.value === null ? 'CLI default (not set by Updraft)' : `"${s.value}" (${s.source})`}`;
  return `profile: ${agentName} (adapter ${adapter}); ${part('model', p.model)}; ${part('effort', p.effort)}; as configured, not necessarily what the CLI resolved`;
}
