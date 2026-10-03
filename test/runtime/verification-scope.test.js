'use strict';
// verification-scope.test.js — the change-scope tier measures a change against a bound built from
// the feature's plan, from the merge base with the integration branch (feature 045, IC-003 / IC-004;
// FR-008, FR-009).
//
// Every scenario runs `doflow verify` in a scratch git repository. The out-of-bound change is
// committed, so `git status` is clean: only the merge-base baseline can see it, which is the point.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { buildScopeBound, taskFilesFromPlan } = require('../../src/runtime/verification/scope-bound');

const SLUG = '050-scope-demo';

const PLAN = [
  '# Plan',
  '',
  '- [ ] A.1 [P] Do the first thing — owner: core-implementer; files: src/in.js, test/in.test.js, test/fixtures/dir/',
  '- [x] B.2 Do the second — owner: core-implementer; files: `docs/guide.md`; depends A.1',
  '- not a task: files: src/ignored.js',
  '',
].join('\n');

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** A repo with `develop` as the integration branch and a feature branch checked out. */
function repo({ plan = PLAN, register = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-vscope-')));
  git(root, 'init', '-q', '-b', 'develop');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'in.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'legacy.js'), 'module.exports = 2;\n');
  if (plan !== null) {
    const dir = path.join(root, 'agent-docs', 'doflow', SLUG);
    fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# req\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), plan);
    if (register) {
      fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'decisions', 'register.json'), '{"version":1,"slug":"x","nextId":1,"decisions":[]}\n');
    }
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', `feat/${SLUG}`);
  return root;
}

function commit(root, file, content = 'changed\n') {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', file);
  git(root, 'commit', '-q', '-m', `touch ${file}`);
}

function scopeTier(root) {
  const res = spawnSync('node', [DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'LOW', '--json'], {
    cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8',
  });
  const report = JSON.parse(res.stdout);
  return report.tiers.find((t) => t.id === 'change-scope');
}

test('task lines contribute their files: list up to the semicolon; other lines contribute nothing', () => {
  assert.deepEqual(taskFilesFromPlan(PLAN),
    ['src/in.js', 'test/in.test.js', 'test/fixtures/dir/', 'docs/guide.md']);
});

test('buildScopeBound adds the feature folder and reports the plan as its source', () => {
  const root = repo();
  const bound = buildScopeBound({ projectRoot: root });
  assert.deepEqual(bound.allowedPaths, [
    'src/in.js', 'test/in.test.js', 'test/fixtures/dir/', 'docs/guide.md', `agent-docs/doflow/${SLUG}/`,
  ]);
  assert.equal(bound.source, `agent-docs/doflow/${SLUG}/plan.md`);
});

test('buildScopeBound is null with no plan, and with a plan that names no task files', () => {
  assert.equal(buildScopeBound({ projectRoot: repo({ plan: null }) }), null);
  assert.equal(buildScopeBound({ projectRoot: repo({ plan: '# Plan\n\n- [ ] A.1 no files here\n' }) }), null);
});

test('a committed change inside the bound passes', () => {
  const root = repo();
  commit(root, 'src/in.js');
  commit(root, 'test/fixtures/dir/deep/x.json');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'PASS', JSON.stringify(tier));
  assert.deepEqual(tier.scope.actual.files.sort(), ['src/in.js', 'test/fixtures/dir/deep/x.json']);
  assert.equal(tier.scope.baseline.kind, 'merge-base');
  assert.equal(tier.scope.bound.source, `agent-docs/doflow/${SLUG}/plan.md`);
});

test('a committed change outside the bound fails and every outside file is listed', () => {
  const root = repo();
  commit(root, 'src/in.js');
  commit(root, 'src/out.js');
  commit(root, 'lib/other.js');
  assert.equal(git(root, 'status', '--porcelain').trim(), '', 'the working tree is clean, so only the merge base can see these');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /src\/out\.js/);
  assert.match(tier.reason, /lib\/other\.js/);
  assert.doesNotMatch(tier.reason, /src\/in\.js/);
});

test('an uncommitted untracked file outside the bound is also reported', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'stray'));
  fs.writeFileSync(path.join(root, 'stray', 'a.txt'), 'x\n');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /stray\/a\.txt/);
});

test('with no integration branch the working tree alone is compared and the tier says so', () => {
  const root = repo();
  git(root, 'branch', '-m', 'develop', 'renamed');   // no develop, no origin: no merge base to find
  commit(root, 'src/out.js');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'PASS', 'committed work is invisible without a baseline');
  assert.match(tier.reason, /only the working tree was compared/);
  assert.equal(tier.scope.baseline.kind, 'working-tree');
});

test('a feature with no plan keeps the tier UNRESOLVED', () => {
  const root = repo({ plan: null });
  commit(root, 'src/out.js');
  assert.equal(scopeTier(root).status, 'UNRESOLVED');
});

// ── review follow-ups: register opt-in, files: field matching, path quoting, renames ──────────────

test('a feature from before the register keeps the tier UNRESOLVED even with a plan', () => {
  const root = repo({ register: false });
  assert.equal(buildScopeBound({ projectRoot: root }), null);
  commit(root, 'src/out.js');
  assert.equal(scopeTier(root).status, 'UNRESOLVED');
});

test('files: is the last field on the line, not any word that ends in it', () => {
  assert.deepEqual(taskFilesFromPlan('- [ ] A.4 mentions profiles: x and files: in prose — owner: o; files: i.js, j.js\n'), ['i.js', 'j.js']);
  assert.deepEqual(taskFilesFromPlan('- [ ] A.5 about profiles: only\n'), []);
});

test('a files: list that ends with a comma continues on the next indented line', () => {
  const plan = [
    '- [ ] A.1 wrapped — owner: o; files: a.js, b.js,',
    '    c.js, d/,',
    '    e.js; depends A.0',
    '- [ ] A.2 next — files: f.js',
    '',
  ].join('\n');
  assert.deepEqual(taskFilesFromPlan(plan), ['a.js', 'b.js', 'c.js', 'd/', 'e.js', 'f.js']);
  // A non-indented line after a trailing comma is not a continuation.
  assert.deepEqual(taskFilesFromPlan('- [ ] A.1 x — files: a.js,\nnot indented\n'), ['a.js']);
});

test('paths with spaces and non-ASCII characters are compared as written, not as git quotes them', () => {
  const plan = '- [ ] A.1 t — owner: o; files: docs/my file.md, docs/é.md\n';
  const root = repo({ plan });
  commit(root, 'docs/my file.md');
  commit(root, 'docs/é.md');
  assert.equal(scopeTier(root).status, 'PASS');
  commit(root, 'docs/other file.md');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /docs\/other file\.md/);
  assert.doesNotMatch(tier.reason, /"/);
});

test('a moved file reports the file it left as well as the one it became', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  git(root, 'mv', 'lib/legacy.js', 'docs/guide.md');   // destination is in bound, source is not
  git(root, 'commit', '-q', '-m', 'move');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /lib\/legacy\.js/);
  assert.doesNotMatch(tier.reason, /docs\/guide\.md/);
});
