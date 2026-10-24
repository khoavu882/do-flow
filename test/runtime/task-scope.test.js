'use strict';
// task-scope.test.js — task records are namespaced by feature (feature 045, IC-001 / IC-002), for
// every feature a slug resolves to, with or without a decision register (115 C-1, D-2).
//
// A task id such as `A.1` repeats across features. Two scratch features share that id here; each keeps
// its records under its own slug and never reads the other's. A flat record from before that rule is
// read in place only when the namespaced file does not exist (115 D-3, worktree-records.e2e.test.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

const { resolveFeature, resolveTaskScope, clearTaskScopeCache, setRecordSlug } = require('../../src/runtime/task-scope.ts');

// The call's record slug and the per-root cache are process-wide; every test leaves them as it found them.
test.afterEach(() => { setRecordSlug(undefined); clearTaskScopeCache(); });

test('resolveFeature memoizes the raw result per root and slug until the cache is cleared', () => {
  const root = suiteTempDir('doflow-task-scope-resolve-feature-');
  const featureResolve = require('../../src/runtime/feature-resolve.ts');
  const original = featureResolve.resolveActiveFeature;
  const first = { paths: { feature_slug: 'feat-cache' } };
  let calls = 0;
  featureResolve.resolveActiveFeature = () => { calls += 1; return first; };
  clearTaskScopeCache();
  try {
    assert.equal(resolveFeature({ projectRoot: root, slug: 'feat-cache' }), first);
    assert.equal(resolveFeature({ projectRoot: root, slug: 'feat-cache' }), first);
    assert.equal(calls, 1);
    clearTaskScopeCache();
    assert.equal(resolveFeature({ projectRoot: root, slug: 'feat-cache' }), first);
    assert.equal(calls, 2);
  } finally {
    featureResolve.resolveActiveFeature = original;
    clearTaskScopeCache();
  }
});

const WITH = '046-with-register';
const WITHOUT = '047-no-register';

/** A scratch project with two features: one carrying a register file, one without. */
function project(label) {
  const real = suiteTempDir(`doflow-task-scope-${label}-`);
  fs.writeFileSync(path.join(real, 'a.js'), 'const x = 1;\n');
  const feature = (slug, withRegister) => {
    const dir = path.join(real, 'agent-docs', 'doflow', slug);
    fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# req\n');
    if (withRegister) {
      fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'decisions', 'register.json'), '{"decisions":[]}\n');
    }
  };
  feature(WITH, true);
  feature(WITHOUT, false);
  return real;
}

function json(cwd, args) {
  const res = spawnSync('node', [DOFLOW, ...args, '--json'], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
  let data = null;
  try { data = JSON.parse(res.stdout); } catch { /* the caller asserts on status */ }
  return { status: res.status, data, stdout: res.stdout, stderr: res.stderr };
}

function addEvidence(cwd, taskId, slug, locator) {
  const res = json(cwd, ['evidence', '--task-id', taskId, '--slug', slug, '--action', 'add',
    '--kind', 'historical', '--provenance', 'extracted',
    '--provider', 'git.native', '--capability', 'history.search', '--locator', locator]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return res.data;
}

const evidenceDir = (root) => path.join(root, '.doflow', 'state', 'evidence');

test('a feature namespaces its records with or without a register (115 D-2)', () => {
  const root = project('layout');
  addEvidence(root, 'A.1', WITH, 'a.js');
  addEvidence(root, 'A.1', WITHOUT, 'a.js');

  assert.ok(fs.existsSync(path.join(evidenceDir(root), WITH, 'A.1.json')), 'namespaced file written');
  assert.ok(fs.existsSync(path.join(evidenceDir(root), WITHOUT, 'A.1.json')), 'namespaced file written for the feature without a register');
  assert.deepEqual(fs.readdirSync(evidenceDir(root)).sort(), [WITH, WITHOUT].sort(), 'no flat A.1 shared by the two');
});

test('the register feature never sees the other feature\'s records for the same task id', () => {
  const root = project('isolation');
  addEvidence(root, 'A.1', WITHOUT, 'a.js');   // the feature without a register writes its own A.1

  const list = (slug) => json(root, ['evidence', '--task-id', 'A.1', '--slug', slug, '--action', 'list']);
  assert.equal(list(WITH).data.evidenceCount, 0, 'a namespaced read never reads another namespace');
  assert.equal(list(WITHOUT).data.evidenceCount, 1, 'the feature without a register reads its own record');

  addEvidence(root, 'A.1', WITH, 'a.js');
  addEvidence(root, 'A.1', WITH, 'a.js');
  assert.equal(list(WITH).data.evidenceCount, 2);
  assert.equal(list(WITHOUT).data.evidenceCount, 1, 'the legacy feature does not see the namespaced records');
});

test('claims, outcome, retrieval and research records follow the same layout', () => {
  const root = project('stores');
  const state = path.join(root, '.doflow', 'state');

  const claim = json(root, ['claim', '--task-id', 'A.1', '--slug', WITH, '--action', 'add', '--statement', 'x holds']);
  assert.equal(claim.status, 0, claim.stderr);
  assert.ok(fs.existsSync(path.join(state, 'evidence', WITH, 'A.1_claims.json')));
  assert.ok(!fs.existsSync(path.join(state, 'evidence', 'A.1_claims.json')));

  const legacy = json(root, ['claim', '--task-id', 'A.1', '--slug', WITHOUT, '--action', 'add', '--statement', 'y holds']);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.ok(fs.existsSync(path.join(state, 'evidence', WITHOUT, 'A.1_claims.json')));
  const seen = json(root, ['claim', '--task-id', 'A.1', '--slug', WITH, '--action', 'list']);
  assert.equal(JSON.stringify(seen.data).includes('y holds'), false, 'no claim from the other feature');

  addEvidence(root, 'A.1', WITH, 'a.js');
  const outcome = json(root, ['outcome', '--task-id', 'A.1', '--slug', WITH, '--action', 'record',
    '--task-class', 'bug', '--stage', 'review', '--state', 'INCONCLUSIVE']);
  assert.equal(outcome.status, 0, outcome.stderr || outcome.stdout);
  assert.ok(fs.existsSync(path.join(state, 'outcome', WITH, 'A.1.json')));
  assert.ok(!fs.existsSync(path.join(state, 'outcome', 'A.1.json')));
  assert.equal(json(root, ['outcome', '--task-id', 'A.1', '--slug', WITHOUT]).status, 1,
    'the other feature has recorded no outcome for A.1');

  const plan = json(root, ['retrieval-plan', '--task-id', 'A.1', '--slug', WITH, '--action', 'declare',
    '--need', 'locate-known-symbol', '--stage', 'design']);
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  assert.ok(fs.existsSync(path.join(state, 'retrieval', WITH, 'A.1.json')));
  assert.ok(!fs.existsSync(path.join(state, 'retrieval', 'A.1.json')));

  const { ResearchRequestStore } = require('../../src/runtime/research-request.ts');
  assert.equal(new ResearchRequestStore({ projectRoot: root, slug: WITH }).file('A.1'),
    path.join(state, 'research', WITH, 'A.1.json'));
  assert.equal(new ResearchRequestStore({ projectRoot: root, slug: WITHOUT }).file('A.1'),
    path.join(state, 'research', WITHOUT, 'A.1.json'));
});

test('the context pack of a namespaced task contains only that feature\'s evidence', () => {
  const root = project('pack');
  addEvidence(root, 'A.1', WITHOUT, 'a.js');
  const empty = json(root, ['context-pack', '--task-id', 'A.1', '--slug', WITH]);
  assert.equal(empty.data.evidenceCount, 0);
  addEvidence(root, 'A.1', WITH, 'a.js');
  const full = json(root, ['context-pack', '--task-id', 'A.1', '--slug', WITH]);
  assert.equal(full.data.evidenceCount, 1);
});

test('a task id equal to the feature slug stays flat even with a register', () => {
  const root = project('feature-level');
  addEvidence(root, WITH, WITH, 'a.js');
  assert.ok(fs.existsSync(path.join(evidenceDir(root), `${WITH}.json`)));
  assert.ok(!fs.existsSync(path.join(evidenceDir(root), WITH)), 'no namespace directory was created');
});

test('resolveTaskScope reports the namespace and the reason for every outcome', () => {
  const root = project('resolve');
  clearTaskScopeCache();
  assert.deepEqual(resolveTaskScope({ projectRoot: root, taskId: 'A.1', slug: WITH }),
    { namespace: WITH, slug: WITH, reason: 'namespaced' });
  assert.deepEqual(resolveTaskScope({ projectRoot: root, taskId: WITH, slug: WITH }),
    { namespace: null, slug: WITH, reason: 'feature-level-id' });
  assert.deepEqual(resolveTaskScope({ projectRoot: root, taskId: 'A.1', slug: WITHOUT }),
    { namespace: WITHOUT, slug: WITHOUT, reason: 'namespaced' }, 'a register is not needed (115 D-2)');

  // No feature folder anywhere above, and a resolver that cannot name one: null, never a throw.
  const bare = suiteTempDir('doflow-task-scope-bare-');
  assert.deepEqual(resolveTaskScope({ projectRoot: bare, taskId: 'A.1' }),
    { namespace: null, slug: null, reason: 'no-feature' });
  assert.deepEqual(resolveTaskScope({ projectRoot: root, taskId: 'A.1', slug: '../escape' }),
    { namespace: null, slug: null, reason: 'no-feature' });
});

test('with no --slug the feature comes from the branch', () => {
  const root = project('branch');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('checkout', '-q', '-b', `feat/${WITH}`);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
  clearTaskScopeCache();
  assert.equal(resolveTaskScope({ projectRoot: root, taskId: 'A.1' }).namespace, WITH);

  const written = json(root, ['evidence', '--task-id', 'A.2', '--action', 'add',
    '--kind', 'historical', '--provenance', 'extracted',
    '--provider', 'git.native', '--capability', 'history.search', '--locator', 'a.js']);
  assert.equal(written.status, 0, written.stderr);
  assert.ok(fs.existsSync(path.join(evidenceDir(root), WITH, 'A.2.json')));
});

// ── readiness reads the task's own feature only ────────────────────────────────────────────────────

/** Evidence that satisfies the bug template's `affected_code` requirement for task A.1. */
function addLocatingEvidence(root, slug) {
  const res = json(root, ['evidence', '--task-id', 'A.1', '--slug', slug, '--action', 'add',
    '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'semble',
    '--capability', 'code.exact-search', '--locator', 'a.js', '--establishes', 'affected_code']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
}

const affectedCode = (res) => res.data.requirements.find((r) => r.id === 'affected_code');

test('readiness for a task id shared by two features sees only its own feature\'s evidence', () => {
  const root = project('readiness');
  addLocatingEvidence(root, WITHOUT);          // the legacy feature's flat A.1
  const readiness = (...extra) => json(root, ['readiness', '--task-id', 'A.1', '--task-class', 'bug', ...extra]);

  assert.equal(affectedCode(readiness('--slug', WITHOUT)).satisfied, true, 'the legacy feature reads its own record');
  const other = affectedCode(readiness('--slug', WITH));
  assert.equal(other.satisfied, false, 'the register feature must not borrow it');
  assert.deepEqual(other.evidenceIds, []);

  addLocatingEvidence(root, WITH);
  assert.equal(affectedCode(readiness('--slug', WITH)).satisfied, true);
  assert.equal(fs.readdirSync(path.join(evidenceDir(root), WITH)).includes('A.1.json'), true);
});

test('readiness resolves the feature from the branch when no --slug is given', () => {
  const root = project('readiness-branch');
  addLocatingEvidence(root, WITHOUT);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('checkout', '-q', '-b', `feat/${WITH}`);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
  const res = json(root, ['readiness', '--task-id', 'A.1', '--task-class', 'bug']);
  assert.equal(affectedCode(res).satisfied, false, 'on the register feature\'s branch the flat record is not visible');
});

test('an ambient --slug default routes a store, and clearing it restores the branch lookup', () => {
  const root = project('ambient');
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
  setRecordSlug(WITH);
  assert.equal(resolveTaskScope({ projectRoot: root, taskId: 'A.1' }).namespace, WITH);
  const ledger = new EvidenceLedger({ repoRoot: root });
  assert.equal(ledger.fileFor('A.1'), path.join(evidenceDir(root), WITH, 'A.1.json'));
  // A call for which no slug resolved routes flat, and never falls back to the branch lookup.
  setRecordSlug(null);
  assert.equal(new EvidenceLedger({ repoRoot: root }).fileFor('A.1'), path.join(evidenceDir(root), 'A.1.json'));
  setRecordSlug(undefined);
  assert.equal(new EvidenceLedger({ repoRoot: root }).fileFor('A.1'), path.join(evidenceDir(root), 'A.1.json'));
});

// ── a well-formed --slug that names no feature folder says so on stderr ─────────────────────────────

test('an explicit slug naming no feature folder notes it on stderr; the records are kept under that slug', () => {
  const root = project('no-feature');
  const spawn = (extra) => spawnSync('node', [DOFLOW, 'evidence', '--task-id', 'A.1', '--action', 'list', '--json', ...extra],
    { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  const named = spawn(['--slug', '099-nothing']);
  assert.equal(named.status, 0);
  assert.equal(named.stderr, "doflow evidence: note: --slug '099-nothing' names no feature folder; its records are kept under that slug\n");
  assert.deepEqual(JSON.parse(named.stdout), JSON.parse(spawn([]).stdout));
  // A real feature, with or without a register, and no --slug at all, are silent.
  assert.equal(spawn(['--slug', WITH]).stderr, '');
  assert.equal(spawn(['--slug', WITHOUT]).stderr, '');
  assert.equal(spawn([]).stderr, '');
  // The bare project with no feature folder anywhere is the same situation.
  const bare = suiteTempDir('doflow-task-scope-bare2-');
  const res = spawnSync('node', [DOFLOW, 'evidence', '--task-id', 'A.1', '--slug', '099-nothing', '--action', 'list', '--json'],
    { cwd: bare, env: { ...process.env, HOME: bare }, encoding: 'utf8' });
  assert.match(res.stderr, /names no feature folder/);
});
