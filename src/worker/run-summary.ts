// What a live agent run left in its worktree: commits on the job branch since the base
// commit, changed files, and the agent's last output lines. Best effort: a git failure is
// noted in the summary, never thrown.
import { open } from 'node:fs/promises';
import { runGit } from '../git/git.js';
import type { RunSummary } from '../types.js';
import { verificationLines, verificationNotes } from './verify.js';

const MAX_COMMITS = 20;
const MAX_STAT_LINES = 60;
const GIT_TIMEOUT_MS = 30_000;
const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 20;
const MAX_LINE = 300;

// CSI/OSC escape sequences and other control characters (except tab).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** The last non-empty lines of a file from byte `from` on, without control sequences. */
export async function tailLines(file: string, from = 0, lines = TAIL_LINES): Promise<string[]> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(from, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const text = buf.toString('utf8').replace(/\r\n?/g, '\n');
    // The first line may be cut mid-way when the tail starts inside the output.
    const all = text.split('\n');
    if (start > from) all.shift();
    return all
      .map((l) => l.replace(ANSI, '').trimEnd())
      .filter((l) => l.trim() !== '')
      .slice(-lines)
      .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l));
  } finally {
    await fh.close();
  }
}

/**
 * The raw text of a file from byte `from` on, or only its last `maxBytes` bytes, starting at a
 * line boundary, when there is more. '' when the file can't be read.
 */
export async function readOutput(file: string, from: number, maxBytes: number): Promise<string> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(from, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    if (start === from) return text;
    const nl = text.indexOf('\n');
    return nl < 0 ? '' : text.slice(nl + 1);
  } finally {
    await fh.close();
  }
}

const MAX_ADAPTER_LINES = 60;
const MAX_ADAPTER_LINE = 1000;

/**
 * An adapter's summary lines (AgentAdapter.summarizeOutput) made safe to store and print: no
 * control sequences or blank lines, each line capped, and at most MAX_ADAPTER_LINES lines (the
 * first ones, plus the last, which adapters use for a one-line status).
 */
export function cleanSummaryLines(lines: readonly string[]): string[] {
  const clean = lines
    .flatMap((l) => l.split(/\r?\n|\r/))
    .map((l) => l.replace(ANSI, '').trimEnd())
    .filter((l) => l.trim() !== '')
    .map((l) => (l.length > MAX_ADAPTER_LINE ? `${l.slice(0, MAX_ADAPTER_LINE - 1)}…` : l));
  if (clean.length <= MAX_ADAPTER_LINES) return clean;
  const head = clean.slice(0, MAX_ADAPTER_LINES - 2);
  return [...head, `… (${clean.length - head.length - 1} more lines in run.log)`, clean[clean.length - 1]!];
}

/**
 * Entries of `git status --porcelain` in a worktree (modified, staged and untracked files; ignored
 * files don't count), or null when git can't tell. Paths with a line break are quoted by git, so
 * one line is one entry.
 */
export async function countUncommitted(worktree: string, git?: string): Promise<number | null> {
  try {
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktree, git, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) });
    return stdout.split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    return null;
  }
}

export interface SummaryInput {
  worktree: string;
  branch: string;
  baseSha: string;
  lastOutput: string[];
  git?: string;
  /**
   * The worktree was written by a contained agent, and this summary runs git on the host. Git
   * then must not look inside submodules: `git diff` against the working tree runs `git status`
   * in each populated submodule, under that nested repository's own config (core.fsmonitor and
   * filters are commands), which the agent controls. A changed submodule commit still counts;
   * uncommitted changes inside a submodule do not.
   */
  untrustedWorktree?: boolean;
}

export interface SummaryDetail {
  summary: RunSummary;
  /** Full `git diff --stat <base>` output (capped), for run.log. */
  stat: string[];
}

export async function summarizeRun(input: SummaryInput): Promise<SummaryDetail> {
  const notes: string[] = [];
  const opts = { cwd: input.worktree, git: input.git, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) };
  const git = async (args: string[], what: string): Promise<string | null> => {
    try {
      return (await runGit(args, opts)).stdout;
    } catch (err) {
      notes.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const range = `${input.baseSha}..HEAD`;
  const diff = input.untrustedWorktree ? ['diff', '--ignore-submodules=dirty'] : ['diff'];
  const count = await git(['rev-list', '--count', range], 'commits');
  const log = await git(['log', `--max-count=${MAX_COMMITS}`, '--format=%h %s', range], 'commit list');
  const stat = await git([...diff, '--stat=200', input.baseSha], 'diff --stat');
  const names = await git([...diff, '--name-only', '-z', input.baseSha], 'changed files');
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], 'untracked files');

  const statLines = (stat ?? '').split('\n').filter((l) => l.trim() !== '');
  const summary: RunSummary = {
    branch: input.branch,
    baseSha: input.baseSha,
    worktree: input.worktree,
    commits: (log ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
    commitCount: Number((count ?? '0').trim()) || 0,
    filesChanged: (names ?? '').split('\0').filter(Boolean).length,
    diffStat: statLines.length ? statLines[statLines.length - 1]!.trim() : 'no changes to tracked files',
    untracked: (untracked ?? '').split('\0').filter(Boolean).length,
    lastOutput: input.lastOutput,
    notes,
  };
  const capped = statLines.length > MAX_STAT_LINES ? [...statLines.slice(0, MAX_STAT_LINES - 1), `  … (${statLines.length - MAX_STAT_LINES + 1} more lines)`, statLines[statLines.length - 1]!] : statLines;
  return { summary, stat: capped };
}

/** run.log lines for a summary. */
export function renderSummary(d: SummaryDetail): string[] {
  const s = d.summary;
  const lines = [
    `branch: ${s.branch} (base ${s.baseSha.slice(0, 12)})`,
    `worktree: ${s.worktree}`,
    `commits since base: ${s.commitCount}`,
    ...s.commits.map((c) => `  ${c}`),
    ...(s.commitCount > s.commits.length ? [`  … ${s.commitCount - s.commits.length} more`] : []),
    `changed files (git diff --stat ${s.baseSha.slice(0, 12)}, committed and uncommitted): ${s.filesChanged}`,
    ...d.stat.map((l) => `  ${l.trim()}`),
    `untracked files: ${s.untracked}`,
    'last agent output:',
    ...(s.lastOutput.length ? s.lastOutput.map((l) => `  | ${l}`) : ['  (none)']),
    ...(s.verification
      ? [
          `verification: ${s.verification.passed ? 'passed' : 'did not pass'}`,
          ...verificationLines(s.verification).map((l) => `  ${l}`),
          ...verificationNotes(s.verification).map((n) => `note: ${n}`),
        ]
      : []),
    ...s.notes.map((n) => `note: ${n}`),
  ];
  return lines;
}
