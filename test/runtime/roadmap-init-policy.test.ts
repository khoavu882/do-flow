'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin/doflow.js');
const PACKAGED = path.join(REPO, 'core/registry/gates.json');

function project(t: any) {
  const root = tempDir(t, 'doflow-init-policy-');
  cp.execFileSync('git', ['-C', root, 'init', '-q', '-b', 'develop']);
  return root;
}
const run = (root: any, ...extra: any[]) => cp.spawnSync(process.execPath, [CLI, 'roadmap', '--action', 'init-policy', ...extra], { cwd: root, encoding: 'utf8' });

test('init-policy writes the packaged policy, stages nothing, and says to commit it on develop', (t) => {
  const root = project(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(root, 'core/registry/gates.json')), fs.readFileSync(PACKAGED));
  assert.match(result.stdout, /commit this on develop/);
  assert.equal(cp.execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim(), '?? core/registry/gates.json');
  assert.equal(cp.execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(), '', 'nothing is staged');
});

test('init-policy refuses to overwrite an existing file (exit 1) and leaves it untouched', (t) => {
  const root = project(t);
  const file = path.join(root, 'core/registry/gates.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"mine":true}\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":true}\n');
});

test('init-policy --json reports the written path', (t) => {
  const root = project(t);
  const result = run(root, '--json');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual([out.schema, out.action, out.written], [1, 'init-policy', 'core/registry/gates.json']);
});

// ── init-policy --commit ──────────────────────────────────────────────────────────────────────────

const REL = 'core/registry/gates.json';
const git = (root: any, ...args: any[]) => cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const gitOk = (root: any, ...args: any[]) => cp.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status === 0;
const seedWorkingCopy = (root: any, bytes: any = fs.readFileSync(PACKAGED)) => {
  fs.mkdirSync(path.join(root, 'core/registry'), { recursive: true });
  fs.writeFileSync(path.join(root, REL), bytes);
};

/** A repo with an identity and a develop commit; `work` is checked out unless `onDevelop`. */
function repoWithDevelop(t: any, { onDevelop = false }: any = {}) {
  const root = project(t);
  git(root, 'config', 'user.name', 'Policy Tester');
  git(root, 'config', 'user.email', 'policy@example.test');
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'base');
  if (!onDevelop) git(root, 'switch', '-qc', 'work');
  return root;
}
const commitRun = (root: any, ...extra: any[]) => run(root, '--commit', ...extra);

test('init-policy --commit commits only the policy on a develop that is not checked out', (t) => {
  const root = repoWithDevelop(t);
  assert.equal(run(root).status, 0);
  const before = git(root, 'rev-parse', 'develop');
  const result = commitRun(root);
  assert.equal(result.status, 0, result.stderr);
  const after = git(root, 'rev-parse', 'develop');
  assert.match(result.stdout, new RegExp(`develop ${before} -> ${after}`));
  assert.equal(git(root, 'rev-parse', 'develop^'), before);
  assert.equal(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', after), REL);
  assert.equal(git(root, 'log', '-1', '--format=%s|%an', after), 'chore(roadmap): add the autopilot gate policy|Policy Tester');
  assert.deepEqual(cp.execFileSync('git', ['-C', root, 'show', `develop:${REL}`]), fs.readFileSync(PACKAGED));
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work', 'the checked-out branch is unchanged');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'index and working tree are clean');
  assert.equal(fs.existsSync(path.join(root, REL)), false, 'the identical working copy is removed');
  assert.match(result.stdout, /removed/);
});

test('init-policy --commit with no working copy commits the packaged bytes and writes nothing', (t) => {
  const root = repoWithDevelop(t);
  const result = commitRun(root, '--json');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.deepEqual([out.schema, out.action, out.committed, out.commit, out.previous],
    [1, 'init-policy', true, git(root, 'rev-parse', 'develop'), git(root, 'rev-parse', 'develop^')]);
  assert.deepEqual(cp.execFileSync('git', ['-C', root, 'show', `develop:${REL}`]), fs.readFileSync(PACKAGED));
  assert.equal(fs.existsSync(path.join(root, REL)), false);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('init-policy --commit commits a reviewed working copy, not the packaged bytes', (t) => {
  const root = repoWithDevelop(t);
  const narrowed = JSON.parse(fs.readFileSync(PACKAGED, 'utf8'));
  narrowed.loop.maxSteps = 3;
  const bytes = `${JSON.stringify(narrowed, null, 2)}\n`;
  seedWorkingCopy(root, bytes);
  const result = commitRun(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${git(root, 'show', `develop:${REL}`)}\n`, bytes);
  assert.equal(fs.existsSync(path.join(root, REL)), false);
});

test('init-policy --commit refuses an invalid working copy (exit 1) and changes nothing', (t) => {
  const root = repoWithDevelop(t);
  const before = git(root, 'rev-parse', 'develop');
  seedWorkingCopy(root, '{"schema":1}\n');
  const result = commitRun(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /policy-invalid/);
  assert.equal(git(root, 'rev-parse', 'develop'), before);
  assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), '{"schema":1}\n');
});

test('init-policy --commit exits 1 when develop already has the policy', (t) => {
  const root = repoWithDevelop(t);
  assert.equal(commitRun(root).status, 0);
  const before = git(root, 'rev-parse', 'develop');
  const result = commitRun(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /develop already has core\/registry\/gates\.json/);
  assert.equal(git(root, 'rev-parse', 'develop'), before);
});

test('init-policy --commit exits 1 with a clear message when there is no local develop', (t) => {
  const root = repoWithDevelop(t);
  git(root, 'branch', '-m', 'develop', 'trunk');
  const result = commitRun(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no local develop branch/);
  assert.equal(fs.existsSync(path.join(root, REL)), false);
});

test('init-policy --commit does not move a develop that is checked out here; it prints the commands to run', (t) => {
  const root = repoWithDevelop(t, { onDevelop: true });
  const before = git(root, 'rev-parse', 'develop');
  const result = commitRun(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /develop is checked out at /);
  assert.match(result.stderr, /mkdir -p /);
  assert.match(result.stderr, /cp '[^']+' '[^']+'/);
  assert.match(result.stderr, /add -- core\/registry\/gates\.json/);
  assert.match(result.stderr, /commit -m 'chore\(roadmap\): add the autopilot gate policy' -- core\/registry\/gates\.json/);
  assert.equal(git(root, 'rev-parse', 'develop'), before);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('init-policy --commit does not move a develop checked out in another worktree', (t) => {
  const root = repoWithDevelop(t);
  const other = tempDir(t, 'doflow-init-policy-wt-');
  fs.rmSync(other, { recursive: true });
  git(root, 'worktree', 'add', '-q', other, 'develop');
  seedWorkingCopy(root);
  const before = git(root, 'rev-parse', 'develop');
  const result = commitRun(root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(fs.realpathSync(other)) || result.stderr.includes(other), result.stderr);
  assert.match(result.stderr, /cp /);
  assert.equal(git(root, 'rev-parse', 'develop'), before);
  assert.equal(fs.existsSync(path.join(root, REL)), true, 'the working copy is kept');
});

test('init-policy --commit with another action is a usage error (exit 2)', (t) => {
  const root = repoWithDevelop(t);
  const result = cp.spawnSync(process.execPath, [CLI, 'roadmap', '--action', 'status', '--commit'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--commit/);
});

/** In-process through the execFileSync seam; `before`/`after` fire around the update-ref spawn. */
function inProcess(root: any, hooks: { before?: (real: any) => void; after?: () => void }) {
  const { commitPolicyCommand } = require('../../src/runtime/policy-init.ts');
  const real = cp.execFileSync;
  const spy = (file: any, args: any, options: any) => {
    const isUpdate = args.includes('update-ref');
    if (isUpdate) hooks.before?.(real);
    const result = real(file, args, options);
    if (isUpdate) hooks.after?.();
    return result;
  };
  const logs: string[] = [];
  const [origLog, origErr, savedCode] = [console.log, console.error, process.exitCode];
  console.log = (...a: any[]) => { logs.push(a.join(' ')); };
  console.error = (...a: any[]) => { logs.push(a.join(' ')); };
  try {
    const code = commitPolicyCommand({ root, repoRoot: REPO, execFileSync: spy });
    return { code, out: logs.join('\n') };
  } finally { console.log = origLog; console.error = origErr; process.exitCode = savedCode; }
}

test('init-policy --commit loses a race cleanly: a develop that moved before update-ref is exit 1, nothing changed', (t) => {
  const root = repoWithDevelop(t);
  seedWorkingCopy(root);
  let moved = '';
  const { code, out } = inProcess(root, { before: (real: any) => {
    const tree = real('git', ['-C', root, 'rev-parse', 'develop^{tree}'], { encoding: 'utf8' }).trim();
    moved = real('git', ['-C', root, 'commit-tree', tree, '-p', 'develop', '-m', 'someone else'], { encoding: 'utf8' }).trim();
    real('git', ['-C', root, 'update-ref', 'refs/heads/develop', moved], { encoding: 'utf8' });
  } });
  assert.equal(code, 1, out);
  assert.match(out, /moved/);
  assert.equal(git(root, 'rev-parse', 'develop'), moved, 'the other writer\'s commit stands');
  assert.equal(gitOk(root, 'cat-file', '-e', `develop:${REL}`), false);
  assert.equal(fs.existsSync(path.join(root, REL)), true, 'the working copy is kept');
});

test('init-policy --commit keeps a working copy that changed after the commit and says so', (t) => {
  const root = repoWithDevelop(t);
  seedWorkingCopy(root);
  const { code, out } = inProcess(root, { after: () => fs.appendFileSync(path.join(root, REL), ' \n') });
  assert.equal(code, 0, out);
  assert.equal(fs.existsSync(path.join(root, REL)), true, 'a differing working copy is left alone');
  assert.match(out, /differs/);
});
