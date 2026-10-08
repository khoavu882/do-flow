'use strict';
// verify-worktree.e2e.test.js — `doflow-run verify` bounds a change from a linked worktree whose
// own checkout holds no feature folder, takes a declared --scope for a change with no plan, and
// says where it looked when nothing bounds the change. Every case runs the real bin/doflow.js
// against real scratch git repositories (a repository, a linked worktree of it, a bare clone's
// worktree) in a scratch HOME; nothing outside the scratch root is read or written.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');

const SLUG = '900-demo';
const FOLDER_REL = `agent-docs/doflow/${SLUG}/`;
const PLAN_LINE = '- [ ] A.1 [US1] demo — owner: x; files: src/a.js\n';
const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const CASE_TIMEOUT_MS = 180_000;

const scratch = createScratch('doflow-verify-worktree-');
after(() => scratch.remove());

function spawnEnv() {
  const env = scratch.env({ GIT_CONFIG_GLOBAL: '/dev/null' });
  if (IS_WIN) env.USERPROFILE = scratch.home;
  return env;
}

function git(cwd, ...args) {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, env: spawnEnv(), encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function doflow(cwd, args) {
  return spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env: spawnEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** The feature folder's files: requirement, design, a register and a plan holding `planText`. */
function writeFeatureFolder(checkout, planText = PLAN_LINE, { register = true } = {}) {
  const folder = path.join(checkout, FOLDER_REL);
  write(path.join(folder, 'intention', 'requirement.md'), '# requirement\n');
  write(path.join(folder, 'design', 'design.md'), '# design\n');
  if (register) write(path.join(folder, 'decisions', 'register.json'), `${JSON.stringify({ version: 1, slug: SLUG, nextId: 1, decisions: [] })}\n`);
  write(path.join(folder, 'plan.md'), planText);
}

/** A repository `main` with committed src/a.js and src/b.js, `agent-docs/` and `.doflow/` ignored,
 * and, unless `folder` is false, an uncommitted feature folder. Returns its real path. */
function makeMain(root, { folder = true, register = true, branch = 'main' } = {}) {
  const main = path.join(root, 'm');
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', branch);
  write(path.join(main, 'src', 'a.js'), 'a\n');
  write(path.join(main, 'src', 'b.js'), 'b\n');
  write(path.join(main, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  if (folder) writeFeatureFolder(main, PLAN_LINE, { register });
  return fs.realpathSync(main);
}

/** A fresh root under the scratch directory, so every case builds its own repositories. */
let rootCounter = 0;
function newRoot() {
  const root = path.join(scratch.dir, `case-${rootCounter += 1}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function addWorktree(main, root, name = 'wt') {
  const wt = path.join(root, name);
  git(main, 'worktree', 'add', '-q', '-b', `feat/${SLUG}`, wt);
  return fs.realpathSync(wt);
}

/** Every file under `dir` except `.git`, with its mtime, as a sorted list of `path@mtimeMs`. */
function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}@${fs.statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

function tier(report, id) {
  const found = report.tiers.find((t) => t.id === id);
  assert.ok(found, `tier ${id} is present`);
  return found;
}

function json(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout is JSON: ${result.stdout}`);
  return JSON.parse(result.stdout);
}

test('plan found from a linked worktree: resolved without copying the folder, and nothing is written', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root);
  const wt = addWorktree(main, root);
  const before = { main: snapshot(main), wt: snapshot(wt) };

  const result = doflow(wt, ['verify', '--task-id', SLUG, '--action', 'contract', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const contract = json(result);
  const scope = tier(contract, 'change-scope');
  assert.strictEqual(scope.resolution, 'RESOLVED');
  assert.deepStrictEqual(scope.bound.allowedPaths, ['src/a.js', FOLDER_REL]);
  assert.strictEqual(scope.bound.sources[0].origin, 'main-checkout');
  assert.strictEqual(scope.bound.sources[0].root, main);
  assert.ok(contract.scope.searched.length >= 2, 'both places looked in are named');

  const human = doflow(wt, ['verify', '--task-id', SLUG, '--action', 'contract']);
  assert.strictEqual(human.status, 0, human.stderr);
  assert.ok(human.stdout.split('\n').includes(`      bound: plan ${FOLDER_REL}plan.md (main checkout ${main})`), human.stdout);

  assert.deepStrictEqual(snapshot(main), before.main, 'the main checkout is unchanged');
  assert.deepStrictEqual(snapshot(wt), before.wt, 'the worktree is unchanged');
  assert.ok(!fs.existsSync(path.join(wt, 'agent-docs')), 'no folder was copied into the worktree');
});

test('the current checkout\'s folder wins over the main checkout\'s', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root);
  const wt = addWorktree(main, root);
  writeFeatureFolder(wt, '- [ ] A.1 [US1] demo — owner: x; files: src/b.js\n');

  const result = doflow(wt, ['verify', '--task-id', SLUG, '--action', 'contract', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const scope = tier(json(result), 'change-scope');
  assert.strictEqual(scope.resolution, 'RESOLVED');
  assert.ok(scope.bound.allowedPaths.includes('src/b.js'));
  assert.ok(!scope.bound.allowedPaths.includes('src/a.js'));
  assert.strictEqual(scope.bound.sources[0].origin, 'current-checkout');
});

test('an explicit --plan-path bounds the change and its doflow-verification block applies', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root);
  const plan = path.join(main, FOLDER_REL, 'plan.md');
  fs.writeFileSync(plan, `${PLAN_LINE}\n\`\`\`doflow-verification\n{"test": "node -e 0"}\n\`\`\`\n`);
  const wt = addWorktree(main, root);

  const result = doflow(wt, ['verify', '--task-id', SLUG, '--plan-path', plan, '--action', 'contract', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const contract = json(result);
  const scope = tier(contract, 'change-scope');
  assert.strictEqual(scope.resolution, 'RESOLVED');
  assert.strictEqual(scope.bound.sources[0].origin, 'plan-path');
  const broad = tier(contract, 'broad-tests');
  assert.ok(broad.checks.length > 0, 'broad-tests has a check');
  assert.strictEqual(broad.checks[0].command, 'node -e 0');
});

test('nothing resolves: exit 1, not PASS, and the reason says where it looked and what to pass', { timeout: CASE_TIMEOUT_MS }, () => {
  const variants = [];

  const noFolder = newRoot();
  variants.push({ name: 'main without a folder', cwd: makeMain(noFolder, { folder: false }), bare: false });

  const nonGit = newRoot();
  variants.push({ name: 'a directory that is not a repository', cwd: fs.realpathSync(nonGit), bare: false });

  const bareRoot = newRoot();
  const source = makeMain(bareRoot);
  const bare = path.join(bareRoot, 'bare.git');
  git(bareRoot, 'clone', '-q', '--bare', source, bare);
  git(bare, 'worktree', 'add', '-q', '-b', `feat/${SLUG}`, path.join(bareRoot, 'bw'));
  variants.push({ name: 'a worktree of a bare clone', cwd: fs.realpathSync(path.join(bareRoot, 'bw')), bare: true });

  for (const variant of variants) {
    const result = doflow(variant.cwd, ['verify', '--task-id', SLUG, '--json']);
    assert.strictEqual(result.status, 1, `${variant.name}: ${result.stdout}${result.stderr}`);
    const report = json(result);
    assert.notStrictEqual(report.status, 'PASS', variant.name);
    const reason = tier(report, 'change-scope').reason;
    for (const needle of ['Looked in:', '--plan-path', '--slug', '--scope <path>[,<path>...]']) {
      assert.ok(reason.includes(needle), `${variant.name}: reason names ${needle}: ${reason}`);
    }
    assert.strictEqual(reason.includes('the repository is bare'), variant.bare, `${variant.name}: ${reason}`);
  }
});

test('a bug fix with a declared scope is bounded by it: inside passes, outside fails and is named', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root, { folder: false });
  git(main, 'checkout', '-q', '-b', 'fix/901-bug');
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'a changed\n');

  const inside = doflow(main, ['verify', '--task-id', '901-bug', '--scope', 'src/a.js', '--json']);
  assert.strictEqual(tier(json(inside), 'change-scope').status, 'PASS', inside.stdout);

  fs.writeFileSync(path.join(main, 'src', 'b.js'), 'b changed\n');
  const outside = doflow(main, ['verify', '--task-id', '901-bug', '--scope', 'src/a.js', '--json']);
  const scopeTier = tier(json(outside), 'change-scope');
  assert.strictEqual(scopeTier.status, 'FAIL');
  assert.ok(scopeTier.reason.includes('src/b.js'), scopeTier.reason);
});

test('no plan and no scope: the change-scope tier is UNRESOLVED and shows the command to declare one', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root, { folder: false });
  git(main, 'checkout', '-q', '-b', 'fix/901-bug');
  fs.writeFileSync(path.join(main, 'src', 'a.js'), 'a changed\n');

  const result = doflow(main, ['verify', '--task-id', '901-bug', '--json']);
  const scopeTier = tier(json(result), 'change-scope');
  assert.strictEqual(scopeTier.status, 'UNRESOLVED');
  assert.ok(scopeTier.reason.includes('doflow-run verify --task-id 901-bug --scope'), scopeTier.reason);
});

test('a plan and a declared scope together: the bound is their union and both sources print', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root);
  const wt = addWorktree(main, root);

  const result = doflow(wt, ['verify', '--task-id', SLUG, '--scope', 'src/b.js', '--action', 'contract', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  const scope = tier(json(result), 'change-scope');
  assert.deepStrictEqual(scope.bound.allowedPaths, ['src/a.js', FOLDER_REL, 'src/b.js']);
  assert.deepStrictEqual(scope.bound.sources.map((s) => s.kind), ['plan', 'declared']);

  const human = doflow(wt, ['verify', '--task-id', SLUG, '--scope', 'src/b.js', '--action', 'contract']);
  const line = human.stdout.split('\n').find((l) => l.startsWith('      bound:'));
  assert.ok(line, human.stdout);
  assert.ok(line.endsWith(' + declared src/b.js (--scope)'), line);
});

test('a bad --scope is a usage error on stderr with no report', { timeout: CASE_TIMEOUT_MS }, () => {
  const root = newRoot();
  const main = makeMain(root);

  const result = doflow(main, ['verify', '--task-id', SLUG, '--scope', '/etc/passwd']);
  assert.strictEqual(result.status, 2);
  assert.ok(result.stderr.includes('is not a repository-relative path'), result.stderr);
  assert.ok(!result.stdout.includes('Verification'), result.stdout);
  assert.strictEqual(result.stdout.trim(), '');
});

test('a feature on its own branch in the main checkout prints what 1.21.0 printed, plus one bound line when bounded', { timeout: CASE_TIMEOUT_MS }, () => {
  const lineShapes = [
    /^$/,
    new RegExp(`^DoFlow Verification Contract \\[${SLUG}\\] — risk [A-Z]+:$`),
    /^═+$/,
    /^ {2}\S+ +(RESOLVED|UNRESOLVED|SKIPPED) +(required|advisory)$/,
    /^ {6}\S.*$/,
  ];

  const withRegister = makeMain(newRoot(), { folder: true, register: true, branch: `feat/${SLUG}` });
  const bounded = doflow(withRegister, ['verify', '--task-id', SLUG, '--action', 'contract']);
  assert.strictEqual(bounded.status, 0, bounded.stderr);
  const lines = bounded.stdout.split('\n');
  const scopeIndex = lines.findIndex((l) => /^ {2}change-scope /.test(l));
  assert.ok(/ RESOLVED /.test(lines[scopeIndex]), lines[scopeIndex]);
  const boundLines = lines.filter((l) => l.startsWith('      bound:'));
  assert.strictEqual(boundLines.length, 1);
  assert.strictEqual(lines[scopeIndex + 1], boundLines[0], 'the bound line sits directly under the tier line');
  for (const line of lines.filter((l) => !l.startsWith('      bound:'))) {
    assert.ok(lineShapes.some((re) => re.test(line)), `unexpected line shape: ${JSON.stringify(line)}`);
  }

  const withoutRegister = makeMain(newRoot(), { folder: true, register: false, branch: `feat/${SLUG}` });
  const unbounded = doflow(withoutRegister, ['verify', '--task-id', SLUG, '--action', 'contract', '--json']);
  assert.strictEqual(unbounded.status, 0, unbounded.stderr);
  const scopeTier = tier(json(unbounded), 'change-scope');
  assert.strictEqual(scopeTier.resolution, 'UNRESOLVED');
  assert.ok(scopeTier.reason.includes('has no decisions/register.json'), scopeTier.reason);
  const human = doflow(withoutRegister, ['verify', '--task-id', SLUG, '--action', 'contract']);
  assert.ok(!human.stdout.split('\n').some((l) => l.startsWith('      bound:')), human.stdout);
});
