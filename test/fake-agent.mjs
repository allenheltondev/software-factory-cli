#!/usr/bin/env node
// Test-only stand-in for a coding-agent CLI, driven by the fake adapter (test/fake-adapter.ts).
// Never used at runtime.
//
//   node fake-agent.mjs --mode <mode> [--prompt-file <path>] [--received <path>] [--pids-file <path>]
//
// The prompt comes from --prompt-file, or stdin when that is absent. --received copies the
// prompt it got to a file so tests can compare it with the rendered prompt.
//
// Modes:
//   success   write FAKE_AGENT.md in the working directory and commit it; exit 0
//   fail      write partial.txt (uncommitted) and modify README.md; exit 3
//   hang      start a child process, write both pids to --pids-file, and wait forever
//   stubborn  like hang, but both processes ignore SIGTERM and SIGINT (POSIX escalation to SIGKILL)
//   orphan    start a child process, write both pids to --pids-file, and exit 0 leaving the child
//   env       print selected environment variables; exit 0
//   wait      find that the issue needs another repository's pull request first: commit
//             nothing, explain, and end with "UPDRAFT-WAITING-ON: <--waiting-on>"; exit 0
//   review    act as a reviewer: write REVIEW_NOTES.md and try to commit it (none of which may
//             ever be published), print findings, and end with a verdict line; exit 0.
//             --verdict <v> picks it: ready-to-merge, changes-requested, or one of the broken
//             ones (none, both, twice, garbage, trailing). Without it the verdict is
//             changes-requested on a first review and ready-to-merge once the prompt carries an
//             earlier review. Before the verdict it writes an UPDRAFT-FINDINGS line: 1 for
//             changes requested, 0 when ready, or --findings <value> as given ("none": no line).
//             --stderr-logs writes a kiro-cli-style log record to stderr just before and after
//             the verdict, and the verdict without a newline.
//             --acceptance assesses the acceptance criteria the prompt lists (docs/acceptance.md):
//             on a first review the last one is unmet and the rest verified, once the prompt
//             carries an earlier review all are verified. In success mode, --acceptance reports
//             every listed criterion as implemented.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = opt('--mode') ?? 'success';
const promptFile = opt('--prompt-file');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : readFileSync(0, 'utf8');
const received = opt('--received');
if (received) writeFileSync(received, prompt);

const say = (line) => process.stdout.write(`${line}\n`);
say(`fake agent: mode ${mode} in ${process.cwd()}`);
say(`fake agent: prompt has ${prompt.length} characters`);

/** The ids of the acceptance criteria the prompt lists. */
const criteria = () => [...prompt.matchAll(/^## Criterion \d+ of \d+: (AC-[0-9a-f]{8}(?:-\d+)?)$/gm)].map((m) => m[1]);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function startChild(stubborn, then) {
  const childCode = stubborn
    ? "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"
    : 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
  const pidsFile = opt('--pids-file');
  child.once('spawn', () => {
    if (pidsFile) writeFileSync(pidsFile, JSON.stringify({ agent: process.pid, child: child.pid }));
    say(`fake agent: working (pid ${process.pid}, child ${child.pid})`);
    then?.(child);
  });
}

function hang(stubborn) {
  if (stubborn) {
    process.on('SIGTERM', () => say('fake agent: ignoring SIGTERM'));
    process.on('SIGINT', () => say('fake agent: ignoring SIGINT'));
  }
  startChild(stubborn);
  setInterval(() => {}, 1000);
}

switch (mode) {
  case 'success': {
    writeFileSync('FAKE_AGENT.md', `# Done\n\n${prompt.split('\n')[0]}\n`);
    git('add', 'FAKE_AGENT.md');
    git('commit', '--quiet', '-m', 'fake agent: implement the issue');
    say(`fake agent: committed ${git('rev-parse', '--short', 'HEAD')}`);
    say('fake agent: all done');
    if (args.includes('--acceptance')) {
      say('```updraft-acceptance');
      say(JSON.stringify(criteria().map((id) => ({ criterion: id, status: 'implemented', evidence: 'FAKE_AGENT.md', tests: 'none run' }))));
      say('```');
    }
    process.exit(0);
    break;
  }
  case 'uncommitted': {
    // Succeeds like 'success', but forgets to commit one of its files.
    writeFileSync('FAKE_AGENT.md', `# Done\n\n${prompt.split('\n')[0]}\n`);
    git('add', 'FAKE_AGENT.md');
    git('commit', '--quiet', '-m', 'fake agent: implement the issue');
    writeFileSync('forgot-to-commit.txt', 'the tests may pass because of this file\n');
    say('fake agent: all done');
    process.exit(0);
    break;
  }
  case 'fail': {
    writeFileSync('partial.txt', 'half-finished work\n');
    writeFileSync('README.md', '# widgets\n\nedited by the fake agent\n');
    process.stderr.write('fake agent: could not finish; giving up\n');
    process.exit(3);
    break;
  }
  case 'wait': {
    say('The hook this issue needs does not exist yet; it belongs in the library.');
    say(`UPDRAFT-WAITING-ON: ${opt('--waiting-on') ?? 'octo/lib#12'}`);
    process.exit(0);
    break;
  }
  case 'hang':
    hang(false);
    break;
  case 'stubborn':
    hang(true);
    break;
  case 'orphan':
    startChild(false, (child) => {
      child.unref();
      say('fake agent: done, leaving a background process');
      process.exit(0);
    });
    break;
  case 'review': {
    writeFileSync('REVIEW_NOTES.md', 'notes the reviewer should not have left\n');
    try {
      git('add', 'REVIEW_NOTES.md');
      git('commit', '--quiet', '-m', 'fake reviewer: must be discarded');
      say(`fake reviewer: committed ${git('rev-parse', '--short', 'HEAD')}`);
    } catch {
      say('fake reviewer: could not commit');
    }
    const verdict = opt('--verdict') ?? (prompt.includes('# Earlier automated reviews') ? 'ready-to-merge' : 'changes-requested');
    say('fake reviewer: findings');
    say('Blockers:');
    say('- widget.txt:1 @octocat says this closes #1; it needs a second line');
    say('Suggestions:');
    say('- none');
    if (args.includes('--acceptance')) {
      const ids = criteria();
      const again = prompt.includes('# Earlier automated reviews');
      const assessed = ids.map((id, i) =>
        !again && i === ids.length - 1
          ? { criterion: id, status: 'unmet', note: 'not done yet' }
          : { criterion: id, status: 'verified', evidence: ['file: FAKE_AGENT.md:1'], note: 'read it' },
      );
      say('```updraft-findings');
      say(JSON.stringify({ findings: [], criteria: assessed }));
      say('```');
    }
    // --findings <value> is written as the count line as-is; "none" leaves the line out.
    const findings = opt('--findings') ?? (verdict === 'ready-to-merge' ? '0' : '1');
    if (findings !== 'none') say(`UPDRAFT-FINDINGS: ${findings}`);
    // --stderr-logs: like kiro-cli, log to stderr around an answer on stdout, and leave the verdict
    // unterminated, so a shared file descriptor glues a log record onto both ends of it.
    const line = args.includes('--stderr-logs')
      ? (v) => {
          writeSync(2, '[INFO] [KRS] <-- GenerateAssistantResponseCommand done totalEvents=139');
          writeSync(1, `UPDRAFT-VERDICT: ${v}`);
          writeSync(2, '[INFO] [KRS] <-- GenerateAssistantResponseCommand done totalEvents=140\n');
        }
      : (v) => say(`UPDRAFT-VERDICT: ${v}`);
    switch (verdict) {
      case 'none':
        break;
      case 'both':
        line('ready-to-merge');
        line('changes-requested');
        break;
      case 'twice':
        line('ready-to-merge');
        line('ready-to-merge');
        break;
      case 'garbage':
        line('looks good to me');
        break;
      case 'trailing':
        line('ready-to-merge');
        say('but please also rename the file');
        break;
      default:
        line(verdict);
    }
    process.exit(0);
    break;
  }
  case 'env':
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'FAKE_ADAPTER_ENV', 'FAKE_CONFIG_ENV']) say(`env ${k}=${process.env[k] ?? '(unset)'}`);
    process.exit(0);
    break;
  default:
    process.stderr.write(`fake agent: unknown mode ${mode}\n`);
    process.exit(64);
}
