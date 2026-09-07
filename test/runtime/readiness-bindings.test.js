'use strict';
// readiness-bindings.test.js — review R1 (P1): READY must not certify a failed baseline or an
// unexamined architecture. The review reproduced, through this same public CLI, a refactor task
// reaching READY on an *inferred* test-result whose content said "Baseline tests failed: 12
// failures." and an *inferred* structural item saying "Architecture has not been inspected yet."
// — evidence-category coverage reported as verified prerequisites. These tests pin the three
// mechanisms that closed it: requirement bindings (`establishes`), typed observations
// ({command, exitCode} graded against the template's expected exit), and claim roles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, "../..");
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-bindings-'));
  const real = fs.realpathSync(dir);
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  const git = (...args) => execFileSync('git', ['-C', real, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return real;
}

function run(cwd, args) {
  return spawnSync('node', [DOFLOW, ...args], { cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8' });
}

function json(cwd, args) {
  const res = run(cwd, [...args, '--json']);
  try {
    return { ...res, data: JSON.parse(res.stdout) };
  } catch {
    throw new Error(`expected JSON on stdout for '${args.join(' ')}':\n${res.stdout}\n${res.stderr}`);
  }
}

const SOURCE = ['--provider', 'npm', '--capability', 'behavior.verify'];

test("R1 reproduction: the review's exact ledger no longer reads READY", (t) => {
  const cwd = project(t);
  const id = 'r1-repro';
  // The review's two items, as recorded in its reproduction: both inferred, both kind-matched.
  const batch = path.join(cwd, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify([
    { kind: 'test-result', provenance: 'inferred', source: { provider: 'claude', capability: 'reasoning' },
      content: 'Baseline tests failed: 12 failures.' },
    { kind: 'structural', provenance: 'inferred', source: { provider: 'claude', capability: 'reasoning' },
      content: 'Architecture has not been inspected yet.' },
  ]));
  assert.equal(json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--batch', batch]).status, 0);

  const res = json(cwd, ['readiness', '--task-id', id, '--task-class', 'refactor',
    '--invariants', 'exports of a.js unchanged']);
  assert.equal(res.data.state, 'NEEDS_EVIDENCE');
  for (const reqId of ['architecture_mapped', 'baseline_tests', 'blast_radius']) {
    const req = res.data.requirements.find((r) => r.id === reqId);
    assert.equal(req.satisfied, false, `${reqId} must not be satisfied by inferred, unbound items`);
    assert.match(req.reason, /extracted|Missing fresh evidence/,
      `${reqId}'s reason must say why the items do not count`);
  }
});

test('a bound observation that failed cannot establish a passing baseline', (t) => {
  const cwd = project(t);
  const id = 'r1-failed-baseline';
  const batch = path.join(cwd, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify([
    { kind: 'test-result', provenance: 'extracted', source: { provider: 'npm', capability: 'behavior.verify' },
      establishes: ['baseline_tests'], observation: { command: 'npm test', exitCode: 1 },
      content: '12 failing' },
  ]));
  assert.equal(json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--batch', batch]).status, 0);

  const res = json(cwd, ['readiness', '--task-id', id, '--task-class', 'refactor']);
  const req = res.data.requirements.find((r) => r.id === 'baseline_tests');
  assert.equal(req.satisfied, false);
  assert.match(req.reason, /exited 1/);
  assert.match(req.reason, /failed run does not establish a passing baseline/i);
});

test('the honest path: bound extracted evidence with a passing observation reads READY', (t) => {
  const cwd = project(t);
  const id = 'r1-honest';
  const batch = path.join(cwd, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify([
    { kind: 'test-result', provenance: 'extracted', source: { provider: 'npm', capability: 'behavior.verify' },
      establishes: ['baseline_tests'], observation: { command: 'npm test', exitCode: 0 } },
    // One extracted read may establish two requirements — by declaring both, not by category.
    { kind: 'structural', provenance: 'extracted', source: { provider: 'graphify', capability: 'code.relationships' },
      locator: 'a.js:1', establishes: ['architecture_mapped', 'blast_radius'],
      content: 'a.js has no dependents' },
  ]));
  assert.equal(json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--batch', batch]).status, 0);

  const res = json(cwd, ['readiness', '--task-id', id, '--task-class', 'refactor',
    '--invariants', 'exports of a.js unchanged']);
  assert.equal(res.data.state, 'READY', res.data.summary);
  const mapped = res.data.requirements.find((r) => r.id === 'architecture_mapped');
  const blast = res.data.requirements.find((r) => r.id === 'blast_radius');
  assert.deepEqual(mapped.evidenceIds, blast.evidenceIds, 'the dual-bound item satisfies both by name');
});

test('reproduction is established by an executed failure — the expected failure IS the evidence', (t) => {
  const cwd = project(t);
  const id = 'r1-repro-by-failure';
  const batch = path.join(cwd, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify([
    { kind: 'runtime-observation', provenance: 'extracted', source: { provider: 'node', capability: 'behavior.verify' },
      establishes: ['reproduction'], observation: { command: 'node a.js --repro', exitCode: 1 },
      content: 'throws TypeError as reported' },
  ]));
  assert.equal(json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--batch', batch]).status, 0);
  const res = json(cwd, ['readiness', '--task-id', id, '--task-class', 'bug']);
  const req = res.data.requirements.find((r) => r.id === 'reproduction');
  assert.equal(req.satisfied, true, 'a bug reproduction succeeds by observing the expected failure');
});

test('root_cause needs a supported claim in the root-cause role, not any supported claim', (t) => {
  const cwd = project(t);
  const id = 'r1-role';
  // A supported claim about something unrelated to the defect's cause.
  const other = json(cwd, ['claim', '--task-id', id, '--action', 'add', '--statement', 'a.js is the only module']);
  const ev = json(cwd, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'exact-search',
    '--provenance', 'extracted', '--provider', 'grep', '--capability', 'code.exact-search',
    '--locator', 'a.js:1', '--content', 'module.exports']);
  json(cwd, ['claim', '--task-id', id, '--action', 'link',
    '--claim-id', other.data.claim.id, '--evidence-id', ev.data.evidence[0].id, '--relation', 'supports']);

  const before = json(cwd, ['readiness', '--task-id', id, '--task-class', 'bug']);
  const reqBefore = before.data.requirements.find((r) => r.id === 'root_cause');
  assert.equal(reqBefore.satisfied, false);
  assert.match(reqBefore.reason, /root-cause/);

  const cause = json(cwd, ['claim', '--task-id', id, '--action', 'add', '--role', 'root-cause',
    '--statement', 'x is exported after first require']);
  json(cwd, ['claim', '--task-id', id, '--action', 'link',
    '--claim-id', cause.data.claim.id, '--evidence-id', ev.data.evidence[0].id, '--relation', 'supports']);
  const after = json(cwd, ['readiness', '--task-id', id, '--task-class', 'bug']);
  assert.equal(after.data.requirements.find((r) => r.id === 'root_cause').satisfied, true);
});

test('write boundary: an extracted test-result without its observation is refused', (t) => {
  const cwd = project(t);
  const res = run(cwd, ['evidence', '--task-id', 'wb1', '--action', 'add', '--kind', 'test-result',
    '--provenance', 'extracted', ...SOURCE, '--locator', 'a.js', '--content', 'all green']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /requires an observation/);
});

test('write boundary: an observation on an inferred item is refused — inference did not run anything', (t) => {
  const cwd = project(t);
  const res = run(cwd, ['evidence', '--task-id', 'wb2', '--action', 'add', '--kind', 'test-result',
    '--provenance', 'inferred', ...SOURCE, '--content', 'tests probably pass',
    '--observed-command', 'npm test', '--observed-exit', '0']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot carry an observation/);
});

test('write boundary: an observation anchors an item, so the locator becomes optional there', (t) => {
  const cwd = project(t);
  const res = json(cwd, ['evidence', '--task-id', 'wb3', '--action', 'add', '--kind', 'test-result',
    '--provenance', 'extracted', ...SOURCE, '--establishes', 'baseline_tests',
    '--observed-command', 'npm test', '--observed-exit', '0']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.data.evidence[0].observation.command, 'npm test');
  assert.equal(res.data.evidence[0].observation.exitCode, 0);
  assert.deepEqual(res.data.evidence[0].establishes, ['baseline_tests']);
});
