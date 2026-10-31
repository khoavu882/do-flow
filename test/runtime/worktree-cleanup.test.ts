'use strict';

// `doflow-run worktree --action cleanup --slug <slug>` (autonomy plan 7c): one test per kept reason,
// one clean removal that copies agent-docs/doflow/<slug> back, `lease-held`, and the CLI shape.
// Every spawned process runs in a scratch HOME; no real roadmap or harness config is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { cleanupWorktree, handleWorktreeCommand } = require('../../src/runtime/roadmap/worktree-cleanup.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SLUG = '113-toy';

/** A main checkout with a develop worktree and `feat/113-toy` checked out in its own worktree. */
function fixture(t: any, { merged = true }: { merged?: boolean } = {}) {
  const dir = tempDir(t, 'doflow-worktree-cleanup-');
  const root = path.join(dir, 'main'), develop = path.join(dir, 'develop'), feature = path.join(dir, 'feature');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const env: any = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test',
    DOFLOW_CLI: CLI };
  delete env.DOFLOW_SESSION_ROLE;
  const git = (cwd: any, ...args: any[]) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Owner'); git(root, 'config', 'user.email', 'owner@example.test'); git(root, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  git(root, 'worktree', 'add', '-qb', `feat/${SLUG}`, feature);
  fs.writeFileSync(path.join(feature, 'feature.txt'), 'feature\n');
  git(feature, 'add', '.'); git(feature, 'commit', '-qm', 'feature');
  // The seed the loop reads; a merge counts only with its DoFlow-Row trailer (deriveStatus).
  fs.mkdirSync(path.join(root, 'agent-docs', 'roadmap'), { recursive: true });
  const row = (id: string, slug: string) => ({ id, slug, title: 'Toy', class: 'feature', needs: [], writeSet: ['feature.txt'] });
  fs.writeFileSync(path.join(root, 'agent-docs', 'roadmap', 'rows.json'), JSON.stringify({ schema: 1, rows: [row('113', SLUG), row('200', '200-live')] }));
  const mergeFeature = () => git(develop, 'merge', '--no-ff', '-q', `feat/${SLUG}`, '-m', 'merge: 113 Toy', '-m', 'DoFlow-Row: 113');
  if (merged) mergeFeature();
  const artifacts = path.join(feature, 'agent-docs', 'doflow', SLUG);
  fs.mkdirSync(path.join(artifacts, 'design'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'requirement.md'), 'worktree requirement\n');
  fs.writeFileSync(path.join(artifacts, 'design', 'specs.md'), 'worktree specs\n');
  const main = path.join(root, 'agent-docs', 'doflow', SLUG);
  const run = (extra: any = {}) => cleanupWorktree({ slug: SLUG, root, env, ...extra });
  return { dir, root, develop, feature, home, env, git, artifacts, main, run, mergeFeature };
}

/** A git runner that answers one git argv itself, to reach a keep that is only a race in practice. */
function intercept(match: (args: string[], seen: number) => any) {
  const seen = new Map<string, number>();
  return (bin: any, args: any, opts: any) => {
    const key = args.join(' ');
    seen.set(key, (seen.get(key) || 0) + 1);
    const answered = match(args, seen.get(key)!);
    if (answered !== undefined) { if (answered instanceof Error) throw answered; return answered; }
    return cp.execFileSync(bin, args, opts);
  };
}

test('a merged feature is removed, its ignored artifact folder is copied back first, and the branch is deleted', (t) => {
  const f = fixture(t);
  const { code, result } = f.run();
  assert.equal(code, 0);
  assert.equal(result.outcome, 'cleaned');
  assert.equal(result.artifacts.copied, 2);
  assert.equal(fs.existsSync(f.feature), false);
  assert.equal(f.git(f.root, 'branch', '--list', `feat/${SLUG}`), '');
  assert.equal(fs.readFileSync(path.join(f.main, 'requirement.md'), 'utf8'), 'worktree requirement\n');
  assert.equal(fs.readFileSync(path.join(f.main, 'design', 'specs.md'), 'utf8'), 'worktree specs\n');
  assert.equal(fs.existsSync(path.join(f.root, '.doflow', 'state', 'roadmap', 'lease.json')), false, 'the lease is released');
});

test('a second run after a clean removal is cleaned with nothing to do', (t) => {
  const f = fixture(t);
  assert.equal(f.run().code, 0);
  const again = f.run();
  assert.equal(again.code, 0);
  assert.equal(again.result.outcome, 'cleaned');
  assert.equal(again.result.already, true);
});

test('kept not-merged: an unmerged branch with commits keeps the worktree, its ignored files and the branch', (t) => {
  const f = fixture(t, { merged: false });
  const { code, result } = f.run();
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'not-merged']);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'requirement.md')), true);
  assert.notEqual(f.git(f.root, 'branch', '--list', `feat/${SLUG}`), '');
});

test('kept not-on-develop: a trailer-merged branch that gained a commit after the merge keeps everything', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.feature, 'later.txt'), 'later\n');
  f.git(f.feature, 'add', 'later.txt'); f.git(f.feature, 'commit', '-qm', 'after the merge');
  const { code, result } = f.run();
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'not-on-develop']);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'requirement.md')), true);
  assert.notEqual(f.git(f.root, 'branch', '--list', `feat/${SLUG}`), '');
});

test('a freshly claimed row (branch tip already inside develop, no commits, no merge) is kept with its ignored files', (t) => {
  const f = fixture(t);
  const live = path.join(f.dir, 'live');
  f.git(f.root, 'worktree', 'add', '-qb', 'feat/200-live', live, 'develop');
  fs.writeFileSync(path.join(live, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(live, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(live, '.doflow', 'state', 'readiness.json'), '{}\n');
  fs.appendFileSync(path.join(f.root, '.gitignore'), '.env\n');
  f.git(f.develop, 'commit', '--allow-empty', '-qm', 'noop');
  const { code, result } = cleanupWorktree({ slug: '200-live', root: f.root, env: f.env });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'not-merged']);
  assert.equal(fs.readFileSync(path.join(live, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(fs.existsSync(path.join(live, '.doflow', 'state', 'readiness.json')), true);
  assert.notEqual(f.git(f.root, 'branch', '--list', 'feat/200-live'), '');
});

test('row-unknown: a slug that names no seed row is denied even when its branch is merged into develop', (t) => {
  const f = fixture(t);
  f.git(f.root, 'worktree', 'add', '-qb', 'feat/300-ghost', path.join(f.dir, 'ghost'), 'develop');
  const { code, result } = cleanupWorktree({ slug: '300-ghost', root: f.root, env: f.env });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'denied', 'row-unknown']);
  assert.equal(fs.existsSync(path.join(f.dir, 'ghost')), true);
});

test('facts-unreadable: an unreadable seed refuses the cleanup', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'agent-docs', 'roadmap', 'rows.json'), '{broken');
  const { code, result } = f.run();
  assert.deepEqual([code, result.outcome, result.reason, result.unreadable], [1, 'denied', 'facts-unreadable', ['seed']]);
  assert.equal(fs.existsSync(f.feature), true);
});

test('cwd-inside-worktree: a caller standing in the worktree, or below it, keeps it and copies nothing', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.feature, 'sub'));
  for (const cwd of [f.feature, path.join(f.feature, 'sub')]) {
    const { code, result } = f.run({ cwd });
    assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'cwd-inside-worktree'], cwd);
  }
  assert.equal(fs.existsSync(f.feature), true);
  assert.equal(fs.existsSync(f.main), false, 'nothing was copied back');
  assert.equal(f.run({ cwd: f.root }).code, 0, 'control: from the main checkout the same worktree is removed');
});

test('kept dirty: an uncommitted file in the worktree keeps the worktree and the branch', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.feature, 'notes.txt'), 'person work\n');
  const { code, result } = f.run();
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'dirty']);
  assert.equal(fs.readFileSync(path.join(f.feature, 'notes.txt'), 'utf8'), 'person work\n');
  assert.notEqual(f.git(f.root, 'branch', '--list', `feat/${SLUG}`), '');
});

test('kept head-moved: the branch moved between the verb reading it and the cleanup', (t) => {
  const f = fixture(t);
  // The verb reads the tip once, cleanupFeature reads it again; a racer moves it in between.
  const execFileSync = intercept((args, seen) => (args.includes('--verify') && args.at(-1) === `refs/heads/feat/${SLUG}` && seen === 2 ? `${'0'.repeat(40)}\n` : undefined));
  const { code, result } = f.run({ execFileSync });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'head-moved']);
  assert.equal(fs.existsSync(f.feature), true);
});

test('kept wrong-branch: the worktree no longer has the feature branch checked out', (t) => {
  const f = fixture(t);
  const execFileSync = intercept((args) => (args.includes('symbolic-ref') ? 'refs/heads/other\n' : undefined));
  const { code, result } = f.run({ execFileSync });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'wrong-branch']);
  assert.equal(fs.existsSync(f.feature), true);
});

test('kept copy-failed: an artifact copy that throws keeps the worktree and names the failure', (t) => {
  const f = fixture(t);
  const fsImpl = { ...fs, copyFileSync() { throw new Error('disk full'); } };
  const { code, result } = f.run({ fsImpl });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'copy-failed']);
  assert.match(result.artifacts.failure, /disk full/);
  assert.equal(fs.readFileSync(path.join(f.artifacts, 'requirement.md'), 'utf8'), 'worktree requirement\n');
  assert.notEqual(f.git(f.root, 'branch', '--list', `feat/${SLUG}`), '');
});

test('kept copy-conflict: a differing main-checkout file is never overwritten', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.main, { recursive: true });
  fs.writeFileSync(path.join(f.main, 'requirement.md'), 'main requirement\n');
  const { code, result } = f.run();
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'copy-conflict']);
  assert.deepEqual(result.artifacts.conflicts, ['requirement.md']);
  assert.equal(fs.readFileSync(path.join(f.main, 'requirement.md'), 'utf8'), 'main requirement\n');
  assert.equal(fs.existsSync(f.feature), true);
});

test('kept worktree-remains: the branch ref vanished while its worktree is still on disk', (t) => {
  const f = fixture(t);
  const execFileSync = intercept((args, seen) => (args.includes('--verify') && args.at(-1) === `refs/heads/feat/${SLUG}` && seen === 2 ? new Error('no such ref') : undefined));
  const { code, result } = f.run({ execFileSync });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'worktree-remains']);
  assert.equal(fs.existsSync(f.feature), true);
});

test('kept git-failed: a git error during the removal keeps the feature and names the error', (t) => {
  const f = fixture(t);
  const execFileSync = intercept((args) => (args.includes('remove') ? new Error('worktree remove failed') : undefined));
  const { code, result } = f.run({ execFileSync });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'kept', 'git-failed']);
  assert.match(result.artifacts.failure, /worktree remove failed/);
});

test('lease-held: a live roadmap lease refuses the cleanup and changes nothing', (t) => {
  const f = fixture(t);
  const dir = path.join(f.root, '.doflow', 'state', 'roadmap');
  fs.mkdirSync(dir, { recursive: true });
  const lease = `${JSON.stringify({ schema: 1, pid: process.pid, start: 'x', host: require('node:os').hostname(), runId: 'rl-20261031-abcd', acquiredAt: 'x' })}\n`;
  fs.writeFileSync(path.join(dir, 'lease.json'), lease);
  const { code, result } = f.run({ alive: () => true });
  assert.deepEqual([code, result.outcome, result.reason], [1, 'denied', 'lease-held']);
  assert.equal(result.holder.runId, 'rl-20261031-abcd');
  assert.equal(fs.existsSync(f.feature), true);
  assert.equal(fs.readFileSync(path.join(dir, 'lease.json'), 'utf8'), lease, 'the other holder\'s lease is untouched');
});

test('facts-unreadable: a worktree list that fails refuses the cleanup and removes nothing', (t) => {
  const f = fixture(t);
  const execFileSync = intercept((args) => (args.includes('list') ? new Error('git exploded') : undefined));
  const { code, result } = f.run({ execFileSync });
  assert.deepEqual([code, result.outcome, result.reason, result.unreadable], [1, 'denied', 'facts-unreadable', ['worktrees']]);
  assert.equal(fs.existsSync(f.feature), true);
});

test('no-develop-worktree: without a develop worktree nothing is removed', (t) => {
  const f = fixture(t);
  f.git(f.root, 'worktree', 'remove', '--force', f.develop);
  const { code, result } = f.run();
  assert.deepEqual([code, result.outcome, result.reason], [1, 'denied', 'no-develop-worktree']);
  assert.equal(fs.existsSync(f.feature), true);
});

test('usage: a missing, unsafe or other action and an unsupported flag exit 2 and remove nothing', (t) => {
  const f = fixture(t);
  const out: string[] = [];
  const realLog = console.log, realErr = console.error, realExit = process.exitCode;
  console.log = (line: any) => out.push(String(line)); console.error = (line: any) => out.push(String(line));
  try {
    for (const options of [{ action: 'cleanup' }, { action: 'cleanup', slug: '../x' }, { action: 'cleanup', slug: 'a/b' }, { action: 'remove', slug: SLUG },
      { action: undefined, slug: SLUG }, { action: 'cleanup', slug: SLUG, flags: ['--action', '--slug', '--force'] }]) {
      assert.equal(handleWorktreeCommand({ ...options, cwd: f.root, env: f.env }), 2, JSON.stringify(options));
    }
  } finally { console.log = realLog; console.error = realErr; process.exitCode = realExit; }
  assert.match(out.join('\n'), /unsupported flag --force/);
  assert.equal(fs.existsSync(f.feature), true);
});

test('the doflow CLI and doflow-run dispatch cleanup: kept prints the reason with exit 1, cleaned exits 0, --force is refused', (t) => {
  const f = fixture(t, { merged: false });
  const cli = (...args: string[]) => cp.spawnSync(process.execPath, [CLI, 'worktree', ...args], { cwd: f.root, env: f.env, encoding: 'utf8' });
  const kept = cli('--action', 'cleanup', '--slug', SLUG, '--json');
  assert.equal(kept.status, 1, kept.stderr);
  assert.deepEqual([JSON.parse(kept.stdout).outcome, JSON.parse(kept.stdout).reason], ['kept', 'not-merged']);
  const text = cli('--action', 'cleanup', '--slug', SLUG);
  assert.equal(text.stdout.trim(), `kept ${SLUG}: not-merged`);
  const forced = cli('--action', 'cleanup', '--slug', SLUG, '--force');
  assert.equal(forced.status, 2, forced.stderr);
  assert.equal(fs.existsSync(f.feature), true);
  f.mergeFeature();
  const inside = cp.spawnSync(process.execPath, [CLI, 'worktree', '--action', 'cleanup', '--slug', SLUG, '--json'], { cwd: f.feature, env: f.env, encoding: 'utf8' });
  assert.equal(inside.status, 1, inside.stderr);
  assert.equal(JSON.parse(inside.stdout).reason, 'cwd-inside-worktree');
  const viaRun = cp.spawnSync(bashPath(), [RUN, 'worktree', '--action', 'cleanup', '--slug', SLUG], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(viaRun.status, 0, viaRun.stderr);
  assert.equal(viaRun.stdout.trim(), `cleaned ${SLUG}`);
  assert.equal(fs.existsSync(f.feature), false);
});
