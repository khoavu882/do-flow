'use strict';
// slug-safety.test.js — a feature slug becomes a directory name and a state key, so the resolver and
// the branch-name verb refuse one that could name a path (feature 045, IC-009; FR-013).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BASH = path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash');
const PATHS = path.join(BASH, 'do-paths.sh');
const GIT_STATE = path.join(BASH, 'do-git-state.sh');

function repo(branch = 'main') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-slug-')));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  if (branch !== 'main') git('checkout', '-q', '-b', branch);
  return root;
}

function run(script, args, cwd) {
  const res = spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8' });
  let data = null;
  try { data = JSON.parse(res.stdout); } catch { /* asserted by the caller */ }
  return { status: res.status, data, stdout: res.stdout };
}

const UNSAFE = ['../x', 'a/b', '..', 'a..b', '-flag', '.hidden', 'has space', 'semi;colon'];
const SAFE = [
  '041-cross-scope-inventory', '042-agentic-orchestration', '043-orchestrator-model-policy',
  '044-decision-register', '045-register-followups', 'ABC-123-x', 'v1.2.3-fix', 'a_b',
];

test('do-paths refuses an unsafe --slug with exit 2 and an invalid-slug error before any path is built', () => {
  const root = repo();
  for (const slug of UNSAFE) {
    const res = run(PATHS, ['--json', `--slug=${slug}`], root);
    assert.equal(res.status, 2, `--slug=${slug}`);
    assert.equal(res.data.error, 'invalid-slug', slug);
    assert.match(res.data.message, /not a valid feature slug/);
    assert.equal(res.data.feature_dir, undefined, 'no path was built');
  }
});

test('do-paths refuses it under --require feature and --paths-only as well', () => {
  const root = repo();
  assert.equal(run(PATHS, ['--json', '--require', 'feature', '--slug=../x'], root).status, 2);
  assert.equal(run(PATHS, ['--paths-only', '--slug=a/b'], root).status, 2);
});

test('do-paths accepts every slug shape the repository uses', () => {
  const root = repo();
  for (const slug of SAFE) {
    const res = run(PATHS, ['--json', `--slug=${slug}`], root);
    assert.equal(res.status, 0, slug);
    assert.equal(res.data.feature_slug, slug);
    assert.equal(res.data.feature_dir, `agent-docs/doflow/${slug}`);
  }
});

test('do-paths applies the same rule to a slug derived from the branch', () => {
  for (const slug of SAFE) {
    const res = run(PATHS, ['--json'], repo(`feat/${slug}`));
    assert.equal(res.status, 0, slug);
    assert.equal(res.data.feature_slug, slug);
  }
  const bad = repo('fix/issue#12');
  const res = run(PATHS, ['--json'], bad);
  assert.equal(res.status, 2);
  assert.equal(res.data.error, 'invalid-slug');
  // The git-state helper needs the repository, not a feature, so such a branch is still reported.
  const state = run(GIT_STATE, ['--state'], bad);
  assert.equal(state.status, 0);
  assert.equal(state.data.branch, 'fix/issue#12');
});

test('git-state --branch-name refuses an unsafe slug with exit 2 and accepts the safe ones', () => {
  const root = repo();
  for (const slug of UNSAFE) {
    const res = run(GIT_STATE, ['--branch-name', '--class=feature', `--slug=${slug}`], root);
    assert.equal(res.status, 2, `--slug=${slug}`);
    assert.equal(res.data.error, 'invalid-slug', slug);
  }
  for (const slug of SAFE) {
    const res = run(GIT_STATE, ['--branch-name', '--class=feature', `--slug=${slug}`], root);
    assert.equal(res.status, 0, slug);
    assert.equal(res.data.name, `feat/${slug}`);
  }
});

// ── every runtime verb that reads --slug refuses it the same way, before touching any state ──────────

const DOFLOW = path.join(__dirname, '..', '..', 'bin', 'doflow.js');
const VALIDATE = path.join(BASH, 'validate-artifacts.sh');

const VERBS = [
  ['evidence', '--task-id', 'A.1', '--action', 'add', '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'semble', '--capability', 'code.exact-search', '--locator', 'a.js'],
  ['claim', '--task-id', 'A.1', '--action', 'add', '--statement', 'x'],
  ['readiness', '--task-id', 'A.1', '--task-class', 'bug'],
  ['context-pack', '--task-id', 'A.1'],
  ['research-request', '--task-id', 'A.1', '--action', 'list'],
  ['outcome', '--task-id', 'A.1'],
  ['retrieval-plan', '--task-id', 'A.1', '--action', 'declare', '--need', 'locate-known-symbol', '--stage', 'design'],
  ['verify', '--task-id', 'A.1'],
  ['scaffold'],
  ['decision', '--action', 'init'],
  ['orchestrate', '--action', 'status', '--task-id', 'A.1'],
];

function tree(root) {
  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const p = path.join(dir, name);
      out.push(path.relative(root, p));
      if (fs.statSync(p).isDirectory()) walk(p);
    }
  }(root));
  return out;
}

test('every verb that takes --slug refuses an unsafe one with the resolver\'s JSON and writes nothing', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'a.js'), 'x\n');
  const before = tree(root);
  for (const slug of ['../../x', 'a/b', '..', 'a..b', '.hidden', 'a b']) {
    for (const verb of VERBS) {
      const res = spawnSync('node', [DOFLOW, ...verb, '--slug', slug, '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
      assert.equal(res.status, 2, `${verb[0]} --slug ${slug}: ${res.stdout}${res.stderr}`);
      const body = JSON.parse(res.stdout);
      assert.deepEqual(Object.keys(body).sort(), ['error', 'hint', 'message']);
      assert.equal(body.error, 'invalid-slug');
      assert.match(body.message, /not a valid feature slug/);
    }
  }
  assert.deepEqual(tree(root), before, 'no state was read into existence or written');
});

test('without --json the refusal is the usual one-line error on stderr, exit 2', () => {
  const root = repo();
  const res = spawnSync('node', [DOFLOW, 'evidence', '--task-id', 'A.1', '--slug', 'a/b'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^doflow evidence: invalid-slug: slug "a\/b" is not a valid feature slug/);
  assert.equal(res.stdout, '');
});

test('a well-formed slug that names no feature keeps today\'s behaviour', () => {
  const root = repo();
  const res = spawnSync('node', [DOFLOW, 'evidence', '--task-id', 'A.1', '--slug', '099-nothing', '--action', 'list', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('validate refuses an unsafe --slug with exit 2, with and without explicit paths', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'x.md'), '# x\n');
  for (const args of [['--slug=../../x'], ['--slug=a/b', 'x.md']]) {
    const json = run(VALIDATE, ['--json', ...args], root);
    assert.equal(json.status, 2, args.join(' '));
    assert.equal(json.data.error, 'invalid-slug');
    const plain = spawnSync('bash', [VALIDATE, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(plain.status, 2);
    assert.match(plain.stderr, /not a valid feature slug/);
  }
  const ok = run(VALIDATE, ['--json', '--slug=099-nothing'], root);
  assert.equal(ok.status, 0);
});

// ── the bash callers of the resolver pass the refusal through instead of failing open (IC-009) ───────

const CALLERS = [
  ['do-prereqs.sh', ['--require-plan']],
  ['render-audit.sh', []],
  ['render-puml.sh', []],
  ['render-diagrams.sh', []],
  ['do-task-brief.sh', ['--task=A.1']],
  ['do-parallel-check.sh', ['--phase=A']],
  ['do-exec-paths.sh', ['--task=A.1']],
];

test('every bash caller of do-paths refuses an unsafe --slug with exit 2 and the resolver\'s error object', () => {
  const root = repo();
  const before = tree(root);
  for (const [script, extra] of CALLERS) {
    for (const slug of ['../../x', 'a/b']) {
      const res = run(path.join(BASH, script), [...extra, `--slug=${slug}`, '--json'], root);
      assert.equal(res.status, 2, `${script} --slug=${slug}: ${res.stdout}`);
      assert.equal(res.data.error, 'invalid-slug', script);
      assert.match(res.data.message, /not a valid feature slug/);
    }
    const plain = spawnSync('bash', [path.join(BASH, script), ...extra, '--slug=../../x'], { cwd: root, encoding: 'utf8' });
    assert.equal(plain.status, 2, `${script} without --json`);
  }
  assert.deepEqual(tree(root), before, 'nothing was written');
});

test('a well-formed slug that names no feature keeps each caller\'s existing behaviour', () => {
  const root = repo();
  const prereqs = run(path.join(BASH, 'do-prereqs.sh'), ['--require-plan', '--slug=099-nothing'], root);
  assert.equal(prereqs.status, 2);
  assert.notEqual(prereqs.data.error, 'invalid-slug');
  assert.equal(run(path.join(BASH, 'render-audit.sh'), ['--json', '--slug=099-nothing'], root).status, 0);
});
