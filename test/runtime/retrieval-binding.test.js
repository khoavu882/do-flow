'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');
const { readPlan, planPath } = require('../../src/runtime/retrieval-record.ts');
const { bindEvidence } = require('../../src/runtime/retrieval-record.ts');

function call(options) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { code: handleRetrievalPlanCommand(options), out: lines.join('\n') }; }
  finally { console.log = log; process.exitCode = 0; }
}

function declare(root, taskId, needs) {
  assert.equal(call({ taskId, action: 'declare', need: needs, stateRoot: root, repoRoot: path.resolve(__dirname, '../..'), json: true }).code, 0);
  return readPlan(root, taskId);
}

function add(root, taskId, evidence) {
  const ledger = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  ledger.addEvidence({ taskId, kind: 'structural', provenance: 'extracted', locator: { file: 'src/a.ts', line: 1 }, ...evidence });
  ledger.save(taskId);
}

test('query refs bind same-provider evidence to separate needs', (t) => {
  const root = tempDir(t, 'doflow-retrieval-bindings-');
  const plan = declare(root, 't-disjoint', ['trace-dependency', 'estimate-blast-radius']);
  const provider = plan.needs[0].provider;
  const capability = plan.needs[0].capability;
  for (const need of plan.needs) assert.equal(need.provider, provider);
  for (const need of plan.needs) add(root, 't-disjoint', {
    content: need.intent,
    source: { provider, capability, queryRef: need.queryRef, attemptRef: null },
  });
  const result = call({ taskId: 't-disjoint', action: 'report', stateRoot: root, json: true });
  assert.equal(result.code, 0, result.out);
  const reported = JSON.parse(result.out);
  for (const need of reported.needs) {
    assert.deepEqual(need.evidenceIds, need.attempts[0].evidenceIds);
    assert.equal(need.attempts[0].recordedBy, 'derived');
  }
  assert.notEqual(reported.needs[0].evidenceIds[0], reported.needs[1].evidenceIds[0]);
});

test('fallback evidence derives RETRIEVED without rewriting the caller attempt', (t) => {
  const root = tempDir(t, 'doflow-retrieval-fallback-');
  const plan = declare(root, 't-fallback', ['locate-known-symbol']);
  const need = plan.needs[0];
  const primary = call({ taskId: 't-fallback', action: 'attempt', need: need.intent, provider: need.provider,
    attemptStatus: 'UNREACHED', reason: 'provider-unavailable', stateRoot: root, repoRoot: path.resolve(__dirname, '../..'), json: true });
  assert.equal(primary.code, 0, primary.out);
  const original = readPlan(root, 't-fallback').needs[0].attempts[0];
  const fallback = need.provider === 'native.rg' ? 'semble.search' : 'native.rg';
  add(root, 't-fallback', { content: 'found', source: { provider: fallback, capability: need.capability, queryRef: need.queryRef, attemptRef: null } });
  const report = call({ taskId: 't-fallback', action: 'report', stateRoot: root, json: true });
  assert.equal(report.code, 0, report.out);
  const output = JSON.parse(report.out).needs[0];
  assert.equal(output.result, 'RETRIEVED');
  assert.equal(output.resolvedBy, 2);
  assert.equal(output.viaFallback, true);
  assert.deepEqual(output.attempts[0], original, 'caller attempt remains byte-for-byte unchanged');
});

test('absence outcomes follow freshness and unmapped index providers fail closed', (t) => {
  const root = tempDir(t, 'doflow-retrieval-absence-');
  const plan = declare(root, 't-absence', ['locate-known-symbol']);
  const need = plan.needs[0];
  add(root, 't-absence', { result: 'EMPTY', freshness: { status: 'STALE' }, source: { provider: need.provider, capability: need.capability, queryRef: need.queryRef, attemptRef: null } });
  const report = call({ taskId: 't-absence', action: 'report', stateRoot: root, json: true });
  assert.equal(report.code, 0, report.out);
  assert.equal(JSON.parse(report.out).needs[0].attempts[0].reason, 'index-stale');
  assert.deepEqual(JSON.parse(report.out).unbound, { count: 0, ids: [], causes: {} });
});

test('UNKNOWN absence on an unmapped index is UNVERIFIED and exits 1', (t) => {
  const root = tempDir(t, 'doflow-retrieval-unknown-');
  const plan = declare(root, 't-unknown', ['locate-known-symbol']);
  const need = plan.needs[0];
  const file = planPath(root, 't-unknown');
  const disk = readPlan(root, 't-unknown');
  disk.providers = { 'unmapped.index': { state: 'UNKNOWN', artifact: null, refresh: 'echo do-not-run', label: null, reason: 'unmapped' } };
  disk.needs[0].provider = 'unmapped.index';
  fs.writeFileSync(file, JSON.stringify(disk));
  add(root, 't-unknown', { result: 'EMPTY', freshness: { status: 'UNKNOWN' }, source: { provider: 'unmapped.index', capability: need.capability, queryRef: need.queryRef, attemptRef: null } });
  const report = call({ taskId: 't-unknown', action: 'report', stateRoot: root, json: true });
  assert.equal(report.code, 1);
  const output = JSON.parse(report.out);
  assert.equal(output.providers['unmapped.index'].state, 'UNKNOWN');
  assert.equal(output.needs[0].result, 'UNVERIFIED');
  assert.equal(output.needs[0].attempts[0].reason, 'index-unverifiable');
  const textReport = call({ taskId: 't-unknown', action: 'report', stateRoot: root });
  assert.match(textReport.out, /Refresh: echo do-not-run/);
  assert.equal(fs.existsSync(path.join(root, 'do-not-run')), false, 'Refresh command is data and must not run');
});

test('unbound evidence names each IC-014 cause', () => {
  const plan = { planId: 'current', attemptRef: 't#2', needs: [
    { intent: 'search', capability: 'code.exact-search', queryRef: 'current#search' },
  ] };
  const evidence = [
    { id: 'old', status: 'active', source: { queryRef: 'prior#search', capability: 'code.exact-search' } },
    { id: 'attempt', status: 'active', source: { queryRef: 'current#search', attemptRef: 't#1' } },
    { id: 'unbound', status: 'active', source: { capability: 'code.exact-search' } },
  ];
  const result = bindEvidence(plan, evidence);
  assert.deepEqual(result.unbound, [
    { id: 'old', cause: 'replaced-plan' },
    { id: 'attempt', cause: 'other-attempt' },
    { id: 'unbound', cause: 'no-query-ref' },
  ]);
});

test('legacy fixture retains legacy report shape and exit behavior', (t) => {
  const root = tempDir(t, 'doflow-retrieval-legacy-');
  const taskId = 'legacy-1';
  const fixture = path.join(__dirname, 'fixtures/retrieval-legacy');
  fs.mkdirSync(path.dirname(planPath(root, taskId)), { recursive: true });
  fs.copyFileSync(path.join(fixture, 'plan.json'), planPath(root, taskId));
  const evidenceDir = path.join(root, '.doflow/state/evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.copyFileSync(path.join(fixture, 'ledger.json'), path.join(evidenceDir, `${taskId}.json`));
  const report = call({ taskId, action: 'report', stateRoot: root, json: true });
  assert.equal(report.code, 0, report.out);
  const payload = JSON.parse(report.out);
  const { stateFile: _stateFile, reportedAt: _reportedAt, revision: _revision, ...stable } = payload;
  assert.deepEqual(stable, JSON.parse(fs.readFileSync(path.join(fixture, 'report.json'), 'utf8')),
    'legacy output remains byte-equivalent after path, timestamp and revision are removed');
  assert.equal(payload.needs[0].result, 'RETRIEVED');
  assert.deepEqual(payload.needs[0].evidenceIds, ['ev_legacy_1']);
  assert.equal(Object.hasOwn(payload, 'unbound'), false);
  assert.equal(Object.hasOwn(payload.needs[0], 'attempts'), false);
});

test('unbound items report causes and index-backed unknown answers exit 1', (t) => {
  const root = tempDir(t, 'doflow-retrieval-unbound-');
  const plan = declare(root, 't-unbound', ['locate-known-symbol']);
  const need = plan.needs[0];
  add(root, 't-unbound', { content: 'unbound', source: { provider: need.provider, capability: need.capability, attemptRef: null } });
  const result = call({ taskId: 't-unbound', action: 'report', stateRoot: root, json: true });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.out);
  assert.deepEqual(payload.unbound.causes, { 'no-query-ref': 1 });
  assert.equal(payload.unbound.count, 1);
  assert.equal(payload.needs[0].result, 'UNREACHED');
});
