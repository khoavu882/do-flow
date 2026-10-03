'use strict';
// task-scope.test.js — task records are namespaced by feature, but only for a feature that has a
// decision register (feature 045, IC-001 / IC-002; FR-006, FR-007).
//
// A task id such as `A.1` repeats across features. Two scratch features share that id here; the one
// with a register keeps its records under its own slug and never reads the other's, and the one
// without keeps the flat layout exactly, so a folder from before the register behaves as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

const { resolveTaskScope, clearTaskScopeCache, setDefaultSlug } = require('../../src/runtime/task-scope');

// The `--slug` default and the per-root cache are process-wide; every test leaves them as it found them.
test.afterEach(() => { setDefaultSlug(null); clearTaskScopeCache(); });

const WITH = '046-with-register';
const WITHOUT = '047-no-register';

/** A scratch project with two features: one carrying a register file, one without. */
function project(label) {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `doflow-scope-${label}-`)));
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

test('a register feature namespaces its records; a feature without one keeps the flat file', () => {
  const root = project('layout');
  addEvidence(root, 'A.1', WITH, 'a.js');
  addEvidence(root, 'A.1', WITHOUT, 'a.js');

  assert.ok(fs.existsSync(path.join(evidenceDir(root), WITH, 'A.1.json')), 'namespaced file written');
  assert.ok(fs.existsSync(path.join(evidenceDir(root), 'A.1.json')), 'flat file written for the legacy feature');
  assert.deepEqual(fs.readdirSync(evidenceDir(root)).sort(), [WITH, 'A.1.json'].sort());
});

test('the register feature never sees the other feature\'s records for the same task id', () => {
  const root = project('isolation');
  addEvidence(root, 'A.1', WITHOUT, 'a.js');   // legacy feature writes flat A.1

  const list = (slug) => json(root, ['evidence', '--task-id', 'A.1', '--slug', slug, '--action', 'list']);
  assert.equal(list(WITH).data.evidenceCount, 0, 'namespaced read must not fall back to the flat file');
  assert.equal(list(WITHOUT).data.evidenceCount, 1, 'legacy feature still reads its flat record');

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
  assert.ok(fs.existsSync(path.join(state, 'evidence', 'A.1_claims.json')));
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

  const { ResearchRequestStore } = require('../../src/runtime/research-request');
  assert.equal(new ResearchRequestStore({ projectRoot: root, slug: WITH }).file('A.1'),
    path.join(state, 'research', WITH, 'A.1.json'));
  assert.equal(new ResearchRequestStore({ projectRoot: root, slug: WITHOUT }).file('A.1'),
    path.join(state, 'research', 'A.1.json'));
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
    { namespace: null, slug: WITHOUT, reason: 'no-register' });

  // No feature folder anywhere above, and a resolver that cannot name one: null, never a throw.
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-scope-bare-')));
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
  const { EvidenceLedger } = require('../../src/runtime/evidence-ledger');
  setDefaultSlug(WITH);
  assert.equal(resolveTaskScope({ projectRoot: root, taskId: 'A.1' }).namespace, WITH);
  const ledger = new EvidenceLedger({ repoRoot: root });
  assert.equal(ledger.fileFor('A.1'), path.join(evidenceDir(root), WITH, 'A.1.json'));
  setDefaultSlug(null);
  assert.equal(new EvidenceLedger({ repoRoot: root }).fileFor('A.1'), path.join(evidenceDir(root), 'A.1.json'));
});
