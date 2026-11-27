'use strict';

// The tracked local gate: `npm run gate`. Clones the repository this is run in (`git clone --shared`,
// so the history is there for the tests that read it) into a fresh temp directory, checks out HEAD's
// commit detached and runs, there and in order, the checks a release leans on: install, typecheck,
// the suite, the Console suite, the shell suites CI blocks on (read from cross-os-tests.yml, in its
// order), a Linux run of the worker tests in a container (skipped, and said so, when docker is not there),
// `bash -n` over the shell scripts and a conflict-marker scan. It
// refuses to run on any Node but the one release.yml pins, so a pass here cannot be a pass that CI
// would not repeat. It never edits the working tree. Contract: IC-003 of row 181.
// Exit 0 all green, 1 the first red step (named), 2 usage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workflowNodePins } = require('../src/release/release-workflow.ts');
const { linuxRun } = require('./linux-run.ts');
const { parseShellSuites } = require('./shell-suites.ts');

const USAGE = 'usage: node scripts/gate.ts [--keep]';
// A conflict marker git leaves behind: seven < or > at the start of a line, then a space or the end.
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

function parseArgs(argv: string[]): { keep: boolean } | null {
  if (argv.length === 0) return { keep: false };
  return argv.length === 1 && argv[0] === '--keep' ? { keep: true } : null;
}

/** The refusal line when the running Node is not the pinned release Node, else null. */
function nodeRefusal(running: string, pin: string): string | null {
  return running === pin ? null : `gate: Node ${running} is not the release Node ${pin}; switch Node and rerun`;
}

/** The files, relative to `dir`, that hold a conflict marker. Files with a NUL byte are binary and skipped. */
function findConflictMarkers(dir: string, files: string[]): string[] {
  return files.filter((file) => {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(dir, file));
    } catch {
      return false; // a symlink or submodule entry that is not a readable file
    }
    return !content.includes(0) && CONFLICT_MARKER.test(content.toString('utf8'));
  });
}

/**
 * Builds in `dir` (an empty directory) a shared clone of the repository at `root` with HEAD's commit
 * checked out detached. The clone reads the source's objects through alternates and never touches the
 * source's refs, index or worktree. `root` may be a linked worktree.
 */
function exportHead(root: string, dir: string): boolean {
  const run = (args: string[], cwd?: string) => spawnSync('git', args, { cwd, stdio: 'inherit' }).status === 0;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0) return false;
  return run(['clone', '--shared', '--no-checkout', '--quiet', root, dir])
    && run(['checkout', '--quiet', '--detach', head.stdout.trim()], dir);
}

type Step = { name: string, run: () => boolean | { skipped: string } };

/** The last line: red at the failed step, else green, naming each skipped step and why it did not run. */
function summaryLine(failed: string | null, skipped: string[]): string {
  if (failed) return `gate: red at ${failed}`;
  return skipped.length ? `gate: green (skipped: ${skipped.join('; ')})` : 'gate: green';
}

function main(argv: string[]): number {
  const options = parseArgs(argv);
  if (!options) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const git = (args: string[], cwd?: string) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    process.stdout.write('gate: not inside a git repository\n');
    return 1;
  }
  const root: string = top.stdout.trim();
  process.stdout.write(`gate: repository ${root}\n`);

  const releasePath = path.join(root, '.github', 'workflows', 'release.yml');
  const pin = fs.existsSync(releasePath) ? workflowNodePins(fs.readFileSync(releasePath, 'utf8'))[0]?.value : undefined;
  if (!pin) {
    process.stdout.write('gate: no Node pin found in .github/workflows/release.yml\n');
    return 1;
  }
  const refusal = nodeRefusal(process.versions.node, pin);
  if (refusal) {
    process.stdout.write(`${refusal}\n`);
    return 1;
  }
  process.stdout.write(`gate: Node ${pin} (the release Node)\n`);

  const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-gate-'));
  const sh = (command: string, args: string[], cwd = dir) =>
    spawnSync(command, args, { cwd, stdio: 'inherit' }).status === 0;
  const tracked = (): string[] => git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], root).stdout.split('\0').filter(Boolean);
  const steps: Step[] = [
    { name: 'export HEAD', run: () => exportHead(root, dir) },
    { name: 'npm install', run: () => sh('npm', ['install']) },
    { name: 'npm run typecheck', run: () => sh('npm', ['run', 'typecheck']) },
    { name: 'npm test', run: () => sh('npm', ['test']) },
    { name: 'console npm test', run: () => sh('npm', ['test'], path.join(dir, 'console')) },
    { name: 'shell suites CI blocks on', run: () => {
      const workflow = path.join(dir, '.github', 'workflows', 'cross-os-tests.yml');
      const { suites, unreadable } = fs.existsSync(workflow) ? parseShellSuites(fs.readFileSync(workflow, 'utf8')) : { suites: [], unreadable: [] };
      unreadable.forEach((line: string) => process.stdout.write(`gate: cannot read a shell suite in .github/workflows/cross-os-tests.yml, ${line}\n`));
      if (!suites.length) process.stdout.write('gate: no shell suite found in .github/workflows/cross-os-tests.yml\n');
      return unreadable.length === 0 && suites.length > 0 && suites.every((suite: string) => {
        process.stdout.write(`gate: bash ${suite}\n`);
        return sh('bash', [suite]);
      });
    } },
    { name: 'linux worker tests', run: () => {
      const result = linuxRun(dir, pin);
      return result === 'ok' ? true : result === 'failed' ? false : result;
    } },
    { name: 'bash -n over tracked *.sh', run: () => tracked().filter((file) => file.endsWith('.sh'))
      .every((file) => sh('bash', ['-n', file])) },
    { name: 'conflict-marker scan', run: () => {
      const hits = findConflictMarkers(dir, tracked());
      hits.forEach((file) => process.stdout.write(`gate: conflict marker in ${file}\n`));
      return hits.length === 0;
    } },
  ];

  let failed: string | null = null;
  const skipped: string[] = [];
  try {
    for (const step of steps) {
      process.stdout.write(`gate: ${step.name} ...\n`);
      const ok = step.run();
      if (typeof ok === 'object') {
        skipped.push(`${step.name} — ${ok.skipped}`);
        process.stdout.write(`gate: ${step.name} SKIPPED (${ok.skipped}; no Linux run happened)\n`);
        continue;
      }
      process.stdout.write(`gate: ${step.name} ${ok ? 'ok' : 'FAILED'}\n`);
      if (!ok) {
        failed = step.name;
        break;
      }
    }
  } finally {
    if (options.keep) process.stdout.write(`gate: export kept at ${dir}\n`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`${summaryLine(failed, skipped)}\n`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, nodeRefusal, summaryLine, findConflictMarkers, exportHead };
