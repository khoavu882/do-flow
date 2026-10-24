'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const LEGACY = path.join(REPO, 'test/runtime/fixtures/retrieval-legacy');

function project(t: any, git = true) {
  const root = tempDir(t, 'doflow-evidence-attempts-');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = { x: 1 };\n');
  if (git) {
    const g = (...args: any[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    g('init', '-q'); g('config', 'user.email', 'test@example.com'); g('config', 'user.name', 'Test');
    g('add', '-A'); g('commit', '-qm', 'init');
  }
  return root;
}

function run(cwd: any, args: any) {
  const r = spawnSync('node', [DOFLOW, ...args], { cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(cwd: any, args: any) {
  const r = run(cwd, [...args, '--json']);
  try { return { ...r, data: JSON.parse(r.stdout) }; }
  catch { throw new Error(`expected JSON for '${args.join(' ')}':\n${r.stdout}\n${r.stderr}`); }
}

function declare(root: any, taskId: any, needs: any) {
  return json(root, ['retrieval-plan', '--task-id', taskId, '--action', 'declare', ...needs.flatMap((n: any) => ['--need', n])]);
}

function add(root: any, taskId: any, { provider = 'native.rg', capability = 'code.exact-search', kind = 'exact-search', need, extra = [] }: any = {}) {
  return json(root, ['evidence', '--task-id', taskId, '--action', 'add', '--kind', kind, '--provenance', 'extracted',
    '--provider', provider, '--capability', capability, '--locator', 'a.js:1', ...(need ? ['--need', need] : []), ...extra]);
}

function readiness(root: any, taskId: any) {
  return json(root, ['readiness', '--task-id', taskId, '--task-class', 'refactor']);
}

test('two needs on one provider bind disjoint evidence', (t) => {
  const root = project(t), id = 'f3-disjoint';
  const plan = declare(root, id, ['inspect-history', 'locate-known-symbol']);
  assert.equal(plan.status, 0, plan.stderr);
  for (const need of ['inspect-history', 'locate-known-symbol']) {
    const added = add(root, id, { need, extra: ['--content', need] });
    assert.equal(added.status, 0, added.stderr);
  }
  const report = json(root, ['retrieval-plan', '--task-id', id, '--action', 'report']);
  assert.equal(report.status, 0, report.stderr);
  assert.notDeepEqual(report.data.needs[0].evidenceIds, report.data.needs[1].evidenceIds);
  assert.equal(report.data.needs[0].evidenceIds.length, 1);
  assert.equal(report.data.needs[1].evidenceIds.length, 1);
});

test('UNREACHED primary and fallback evidence resolve on attempt two', (t) => {
  const root = project(t), id = 'f3-fallback';
  const plan = declare(root, id, ['inspect-history']);
  assert.equal(plan.status, 0, plan.stderr);
  const need = plan.data.needs[0];
  const attempt = json(root, ['retrieval-plan', '--task-id', id, '--action', 'attempt', '--need', need.intent,
    '--provider', need.provider, '--status', 'UNREACHED', '--reason', 'provider-unavailable', '--note', 'provider unavailable']);
  assert.equal(attempt.status, 0, attempt.stderr);
  const fallbackProvider = need.provider === 'native.rg' ? 'semble.search' : 'native.rg';
  const added = add(root, id, { provider: fallbackProvider, capability: need.capability, need: need.intent });
  assert.equal(added.status, 0, added.stderr);
  const report = json(root, ['retrieval-plan', '--task-id', id, '--action', 'report']);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(report.data.needs[0].resolvedBy, 2);
  assert.equal(report.data.needs[0].viaFallback, true);
});

test('STALE graph absence blocks readiness and a live absence clears it', (t) => {
  const root = project(t), id = 'f3-stale-graph';
  const graph = path.join(root, 'graphify-out/graph.json');
  fs.mkdirSync(path.dirname(graph), { recursive: true }); fs.writeFileSync(graph, '{}');
  const old = (Date.now() - 200000) / 1000; fs.utimesSync(graph, old, old);
  assert.equal(declare(root, id, ['trace-dependency']).status, 0);
  const stale = json(root, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'graphify.query', '--capability', 'code.relationships', '--absence', '--need', 'trace-dependency',
    '--establishes', 'architecture_mapped', '--content', 'no dependents']);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.data.evidence[0].freshness.status, 'STALE');
  let report = readiness(root, id);
  assert.equal(report.data.requirements.find((x: any) => x.id === 'architecture_mapped').reasonCode, 'stale-absence-unverified');
  const live = json(root, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'native.rg', '--capability', 'code.relationships', '--absence', '--need', 'trace-dependency',
    '--establishes', 'architecture_mapped', '--content', 'no dependents']);
  assert.equal(live.status, 0, live.stderr);
  report = readiness(root, id);
  assert.equal(report.data.requirements.find((x: any) => x.id === 'architecture_mapped').satisfied, true);
});

for (const [name, edit] of [['uncommitted edit', 'module.exports = { x: 2 };\n'], ['second edit to dirty file', 'module.exports = { x: 3 };\n']]) {
  test(`${name} after a FRESH absence makes readiness stale`, (t) => {
    const root = project(t), id = `f3-${name.startsWith('second') ? 'dirty2' : 'dirty1'}`;
    // The second-edit flow records the absence while the file is already dirty, so only a change
    // to the dirty file itself (same size, newer mtime) can make the absence stale.
    if (name.startsWith('second')) fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = { x: 2 };\n');
    assert.equal(declare(root, id, ['locate-known-symbol']).status, 0);
    const added = json(root, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
      '--provider', 'native.rg', '--capability', 'code.exact-search', '--absence', '--need', 'locate-known-symbol',
      '--establishes', 'architecture_mapped', '--content', 'no result']);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(added.data.evidence[0].freshness.status, 'FRESH');
    const future = Math.floor(Date.now() / 1000) + 10;
    fs.writeFileSync(path.join(root, 'a.js'), edit);
    fs.utimesSync(path.join(root, 'a.js'), future, future);
    const report = readiness(root, id);
    assert.equal(report.data.requirements.find((x: any) => x.id === 'architecture_mapped').reasonCode, 'stale-absence-unverified');
  });
}

test('absence outside git is UNKNOWN and does not clear readiness', (t) => {
  const root = project(t, false), id = 'f3-outside-git';
  assert.equal(declare(root, id, ['locate-known-symbol']).status, 0);
  const added = json(root, ['evidence', '--task-id', id, '--action', 'add', '--kind', 'structural', '--provenance', 'extracted',
    '--provider', 'native.rg', '--capability', 'code.exact-search', '--absence', '--need', 'locate-known-symbol',
    '--establishes', 'architecture_mapped', '--content', 'no result']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.data.evidence[0].freshness.status, 'UNKNOWN');
  assert.equal(readiness(root, id).data.requirements.find((x: any) => x.id === 'architecture_mapped').satisfied, false);
});

test('unbound evidence in a query-bound plan reports unbound-retrieval-evidence', (t) => {
  const root = project(t), id = 'f3-unbound';
  assert.equal(declare(root, id, ['trace-dependency']).status, 0);
  const added = add(root, id, { kind: 'structural', capability: 'code.relationships', extra: ['--establishes', 'architecture_mapped'] });
  assert.equal(added.status, 0, added.stderr);
  const req = readiness(root, id).data.requirements.find((x: any) => x.id === 'architecture_mapped');
  assert.equal(req.satisfied, false);
  assert.equal(req.reasonCode, 'unbound-retrieval-evidence');
});

test('frozen legacy plan reports with unchanged exit behavior', (t) => {
  const root = project(t), id = 'legacy-1';
  const planDir = path.join(root, '.doflow/state/retrieval');
  const evidenceDir = path.join(root, '.doflow/state/evidence');
  fs.mkdirSync(planDir, { recursive: true }); fs.mkdirSync(evidenceDir, { recursive: true });
  fs.copyFileSync(path.join(LEGACY, 'plan.json'), path.join(planDir, `${id}.json`));
  fs.copyFileSync(path.join(LEGACY, 'ledger.json'), path.join(evidenceDir, `${id}.json`));
  const report = json(root, ['retrieval-plan', '--task-id', id, '--action', 'report']);
  assert.equal(report.status, 0, report.stderr);
  const { stateFile: _stateFile, reportedAt: _reportedAt, ...stable } = report.data;
  assert.deepEqual(stable, JSON.parse(fs.readFileSync(path.join(LEGACY, 'report.json'), 'utf8')));
});

test('--score is rejected with exit 2', (t) => {
  const res = run(project(t), ['evidence', '--task-id', 'f3-score', '--action', 'add', '--kind', 'exact-search',
    '--provenance', 'extracted', '--provider', 'native.rg', '--capability', 'code.exact-search', '--locator', 'a.js:1', '--score', '0.85']);
  assert.equal(res.status, 2);
});

test('--status RETRIEVED is rejected with exit 2', (t) => {
  const res = run(project(t), ['retrieval-plan', '--task-id', 'f3-status', '--action', 'attempt', '--need', 'locate-known-symbol',
    '--provider', 'native.rg', '--status', 'RETRIEVED']);
  assert.equal(res.status, 2);
});
