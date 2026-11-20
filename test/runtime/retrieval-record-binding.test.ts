'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');
const { readPlan, planPath, resolveRetrievalBinding } = require('../../src/runtime/retrieval-record.ts');
const { bindEvidence } = require('../../src/runtime/retrieval-record.ts');
const { deriveOutcome } = require('../../src/runtime/retrieval-record.ts');
const retrievalPlan = require('../../src/runtime/retrieval-plan.ts');

function call(options: any): any {
  const lines: any = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { code: handleRetrievalPlanCommand(options), out: lines.join('\n') }; }
  finally { console.log = log; process.exitCode = 0; }
}

function declare(root: any, taskId: any, needs: any) {
  assert.equal(call({ taskId, action: 'declare', need: needs, stateRoot: root, repoRoot: path.resolve(__dirname, '../..'), json: true }).code, 0);
  return readPlan(root, taskId);
}

function add(root: any, taskId: any, evidence: any) {
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  ledger.load(taskId);
  const id = ledger.addEvidence({ taskId, kind: 'structural', provenance: 'extracted', locator: { file: 'src/a.ts', line: 1 }, ...evidence });
  ledger.save(taskId);
  return id;
}

test('reusable retrieval binding resolves only a declared query and includes the active attempt ref', (t) => {
  const root = tempDir(t, 'doflow-retrieval-binding-helper-');
  const plan = declare(root, 't-helper-binding', ['trace-dependency']);
  const resolved = resolveRetrievalBinding({ projectRoot: root, taskId: 't-helper-binding', intent: 'trace-dependency' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.plan.planId, plan.planId);
  assert.equal(resolved.queryRef, plan.needs[0].queryRef);
  assert.equal(resolved.need.intent, 'trace-dependency');
  assert.equal(resolved.attemptRef, null);
  const missing = resolveRetrievalBinding({ projectRoot: root, taskId: 't-helper-binding', intent: 'unplanned-need' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /is not a declared need/);
});

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
  const plan: any = { planId: 'current', attemptRef: 't#2', needs: [
    { intent: 'search', capability: 'code.exact-search', queryRef: 'current#search' },
  ] };
  const evidence: any = [
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

test('the report lists at most five unbound ids and states the total', (t) => {
  const root = tempDir(t, 'doflow-retrieval-unbound-cap-');
  const plan = declare(root, 't-unbound-cap', ['locate-known-symbol']);
  const need = plan.needs[0];
  const ids: any = [];
  for (let i = 0; i < 7; i += 1) {
    ids.push(add(root, 't-unbound-cap', { content: `unbound ${i}`, source: { provider: need.provider, capability: need.capability } }));
  }
  const report = call({ taskId: 't-unbound-cap', action: 'report', stateRoot: root, json: true });
  const output = JSON.parse(report.out);
  assert.equal(output.unbound.count, 7);
  assert.equal(output.unbound.ids.length, 5);
  assert.deepEqual(output.unbound.ids, ids.slice(0, 5));
  assert.deepEqual(output.unbound.causes, { 'no-query-ref': 7 });
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

test('superseded evidence refreshes derived links and no longer supports the need', (t) => {
  const root = tempDir(t, 'doflow-retrieval-superseded-');
  const plan = declare(root, 't-superseded', ['inspect-history']);
  const need = plan.needs[0];
  const first = add(root, 't-superseded', { content: 'first', source: {
    provider: need.provider, capability: need.capability, queryRef: need.queryRef, attemptRef: null,
  } });
  const second = add(root, 't-superseded', { content: 'replacement', source: {
    provider: need.provider, capability: need.capability, attemptRef: null,
  } });
  const firstReport = call({ taskId: 't-superseded', action: 'report', stateRoot: root, json: true });
  assert.equal(firstReport.code, 0, firstReport.out);
  assert.deepEqual(JSON.parse(firstReport.out).needs[0].evidenceIds, [first]);

  const ledger: any = new EvidenceLedger({ repoRoot: root });
  ledger.load('t-superseded');
  ledger.supersedeEvidence(first, second);
  ledger.save('t-superseded');
  const persisted: any = new EvidenceLedger({ repoRoot: root });
  persisted.load('t-superseded');
  assert.equal(persisted.getEvidence(first).status, 'superseded');

  const nextReport = call({ taskId: 't-superseded', action: 'report', stateRoot: root, json: true });
  assert.equal(nextReport.code, 1, nextReport.out);
  const output = JSON.parse(nextReport.out).needs[0];
  assert.equal(output.result, 'UNREACHED');
  assert.deepEqual(output.evidenceIds, []);
  assert.deepEqual(output.attempts.find((attempt: any) => attempt.recordedBy === 'derived').evidenceIds, []);
});

test('superseded absence evidence no longer counts as a derived EMPTY attempt (DEC-024)', (t) => {
  const root = tempDir(t, 'doflow-retrieval-superseded-absence-');
  const plan = declare(root, 't-superseded-absence', ['inspect-history']);
  const need = plan.needs[0];
  const first = add(root, 't-superseded-absence', { result: 'EMPTY', freshness: { status: 'FRESH' }, source: {
    provider: need.provider, capability: need.capability, queryRef: need.queryRef, attemptRef: null,
  } });
  assert.equal(call({ taskId: 't-superseded-absence', action: 'report', stateRoot: root, json: true }).code, 0);
  const replacement = add(root, 't-superseded-absence', { content: 'replacement', source: {
    provider: need.provider, capability: need.capability, attemptRef: null,
  } });
  const ledger: any = new EvidenceLedger({ repoRoot: root });
  ledger.load('t-superseded-absence');
  ledger.supersedeEvidence(first, replacement);
  ledger.save('t-superseded-absence');
  const result = call({ taskId: 't-superseded-absence', action: 'report', stateRoot: root, json: true });
  assert.equal(result.code, 1, result.out);
  const reported = JSON.parse(result.out).needs[0];
  assert.equal(reported.result, 'UNREACHED');
  assert.equal(deriveOutcome(reported).result, 'UNREACHED');
});

test('an absent plan during report or attempt update is refused', () => {
  for (const apply of [retrievalPlan.applyReport, retrievalPlan.applyAttempt]) {
    assert.throws(() => apply(null, 't-removed'), /retrieval plan for task t-removed was removed during the update; re-declare it/);
  }
});

test('a null-provider report attempt is primary and never a fallback (IC-013)', (t) => {
  const root = tempDir(t, 'doflow-retrieval-null-provider-');
  const plan = declare(root, 't-null-provider', ['locate-known-symbol']);
  const file = planPath(root, 't-null-provider');
  const changed = readPlan(root, 't-null-provider');
  changed.needs[0].provider = null;
  fs.writeFileSync(file, JSON.stringify(changed));
  const result = call({ taskId: 't-null-provider', action: 'report', need: 'locate-known-symbol', stateRoot: root, json: true });
  assert.equal(result.code, 0, result.out);
  const reported = JSON.parse(result.out).needs[0];
  const attempt = reported.attempts[0];
  assert.equal(attempt.provider, null);
  assert.equal(attempt.role, 'primary');
  assert.equal(reported.viaFallback, false);
});

test('declare moves a torn plan aside but refuses a valid future version', (t) => {
  const root = tempDir(t, 'doflow-retrieval-declare-corrupt-');
  const taskId = 't-corrupt-plan';
  const file = planPath(root, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{bad');
  const recovered = call({ taskId, action: 'declare', need: 'locate-known-symbol', stateRoot: root, json: true });
  assert.equal(recovered.code, 0, recovered.out);
  assert.ok(fs.readdirSync(path.dirname(file)).some((name: any) => name.startsWith(`${taskId}.json.corrupt-`)));
  fs.writeFileSync(file, JSON.stringify({ version: 2 }));
  const future = call({ taskId, action: 'declare', need: 'locate-known-symbol', stateRoot: root, json: true });
  assert.equal(future.code, 2, future.out);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('query refs from undeclared needs in the active plan are replaced-plan unbound evidence', (t) => {
  const root = tempDir(t, 'doflow-retrieval-replaced-need-');
  const plan = declare(root, 't-replaced-need', ['trace-dependency', 'estimate-blast-radius']);
  const removedNeed = plan.needs.find((need: any) => need.intent === 'estimate-blast-radius');
  const evidenceId = add(root, 't-replaced-need', { content: 'from removed need', source: {
    provider: removedNeed.provider, capability: removedNeed.capability,
    queryRef: removedNeed.queryRef, attemptRef: null,
  } });
  const file = planPath(root, 't-replaced-need');
  const changed = readPlan(root, 't-replaced-need');
  changed.needs = changed.needs.filter((need: any) => need.intent !== 'estimate-blast-radius');
  fs.writeFileSync(file, JSON.stringify(changed));

  const report = call({ taskId: 't-replaced-need', action: 'report', stateRoot: root, json: true });
  assert.equal(report.code, 1, report.out);
  const output = JSON.parse(report.out);
  assert.equal(output.unbound.causes['replaced-plan'], 1);
  assert.deepEqual(output.unbound.ids, [evidenceId]);
  assert.equal(output.unbound.count, 1);
});

test('report does not construct the capability router when provider freshness is already cached', (t) => {
  const root = tempDir(t, 'doflow-retrieval-cached-provider-');
  const plan = declare(root, 't-cached-provider', ['inspect-history']);
  const need = plan.needs[0];
  add(root, 't-cached-provider', { content: 'found', source: {
    provider: need.provider, capability: need.capability, queryRef: need.queryRef, attemptRef: null,
  } });
  const report = call({ taskId: 't-cached-provider', action: 'report', stateRoot: root,
    repoRoot: path.join(root, 'missing-registry-root'), json: true });
  assert.equal(report.code, 0, report.out);
});
