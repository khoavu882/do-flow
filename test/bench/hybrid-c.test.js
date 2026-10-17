'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const dispatcher = require('../../bench/retrieval/lib/adapters.js');
const adaptersC = require('../../bench/retrieval/lib/adapters-c.js');
const run = require('../../bench/retrieval/lib/verbs/run.js');
const preconditions = require('../../bench/retrieval/lib/verbs/holdout-preconditions.js');
const protocol = require('../../bench/retrieval/lib/hybrid-protocol.js');
const gate = require('../../bench/retrieval/lib/hybrid-gate.js');
const seal = require('../../bench/retrieval/lib/seal.js');

const PASS = 'a sufficiently long test-only passphrase';
const git = (root, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-C', root, ...args], { encoding: 'utf8' }).trim();
const approved = { status: 'approved', approvedOn: '2026-10-16' };
const thresholds = { minN: { ranking: 10, outcome: 3, ...approved }, thresholds: [{ id: 'T-001', ...approved }],
  rules: [{ id: 'RULE-001', ...approved }], costCaps: { ...approved }, rerun: { tolerances: [], ...approved } };

function sealedWorld(t) {
  const repoRoot = tempDir(t, 'doflow-hybrid-c-holdout-');
  git(repoRoot, 'init', '-q');
  fs.mkdirSync(path.join(repoRoot, 'bench/retrieval'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'bench/retrieval/thresholds.json'), JSON.stringify(thresholds, null, 2));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'fixture\n');
  git(repoRoot, 'add', '-A'); git(repoRoot, 'commit', '-q', '-m', 'fixture');
  const sealMeta = {};
  for (const corpus of protocol.CORPORA) {
    const taskFile = { schemaVersion: 1, snapshotId: 9, split: 'holdout', tasks: [] };
    const sealed = seal.sealTasks({ taskFile, passphrase: PASS, corpus, snapshotId: 9, generation: 2, sealedBy: 'independent', classes: ['exact-lookup', 'conceptual-discovery'] });
    sealMeta[corpus] = { generation: 2, seal: sealed.seal, envelope: sealed.envelope,
      label: `bench/retrieval/holdout/${corpus}.g2.sealed.json` };
  }
  return { repoRoot, sealMeta };
}

test('hybrid-c-v1 is opt-in and requires the full ordered A,B,C run', () => {
  assert.deepEqual(run.parseSelection({}), { configs: ['A', 'B'], corpora: ['code', 'guidance'], split: 'dev', cls: undefined });
  assert.deepEqual(run.parseSelection({ protocol: protocol.ID }), { configs: ['A', 'B', 'C'], corpora: ['code', 'guidance'], split: 'dev', cls: undefined, protocol: protocol.ID });
  assert.throws(() => run.parseSelection({ protocol: protocol.ID, config: 'A,C,B' }), /A,B,C/);
  assert.throws(() => run.parseSelection({ protocol: protocol.ID, split: 'holdout', config: 'A,B,C', corpus: 'code' }), /both corpora/);
  assert.throws(() => dispatcher.runConfig({ config: 'C', corpus: 'code', task: {}, exportRoot: process.cwd() }), /unknown configuration/);
});

test('A and B receive the pinned code manifest paths for lexical discovery', (t) => {
  const root = tempDir(t, 'doflow-hybrid-c-export-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.writeFileSync(path.join(root, 'src/a.ts'), 'x\n');
  const paths = ['src/a.ts']; const seen = [];
  const impl = { runA: (x) => { seen.push(x.admittedPaths); return { result: 'EMPTY', freshness: 'NOT_APPLICABLE', candidates: [], providers: [], payloadBytes: 0, wallMs: 0 }; },
    runB: (x) => { seen.push(x.admittedPaths); return { result: 'EMPTY', freshness: 'NOT_APPLICABLE', candidates: [], providers: [], payloadBytes: 0, wallMs: 0 }; } };
  for (const config of ['A', 'B']) dispatcher.runConfig({ config, corpus: 'code', task: { id: 'DC-001', class: 'exact-lookup' }, exportRoot: root, admittedPaths: paths, impl });
  assert.deepEqual(seen, [paths, paths]);
});

test('C invokes production coordinator boundary with exact lexical and conceptual hybrid profiles', () => {
  const requests = [];
  const coordinator = (options) => {
    requests.push(options);
    return { exit: 0, response: { effectiveProfile: options.profile, attempts: [{ provider: 'native.rg', complete: true }], gaps: [],
      results: [{ locator: { file: 'src/a.ts', line: 4, endLine: 5 }, provider: 'native.rg', snippet: 'live source' }] } };
  };
  const common = { corpus: 'code', exportRoot: '/repo', admittedPaths: ['src/a.ts'], executeCodeRetrieval: coordinator };
  const exact = adaptersC.runC({ ...common, task: { class: 'exact-lookup', literal: 'odd literal' } });
  const conceptual = adaptersC.runC({ ...common, task: { class: 'conceptual-discovery', query: 'find parser callers' } });
  assert.equal(requests[0].intent, 'exact'); assert.equal(requests[0].profile, 'lexical-only');
  assert.equal(requests[1].profile, 'hybrid'); assert.deepEqual(requests[1].scopes, ['src/a.ts']);
  assert.equal(exact.candidates[0].path, 'src/a.ts'); assert.equal(conceptual.effectiveProfile, 'hybrid');
});

test('C impact/refactor stays on A graph routing and reports unreached when graphify is unavailable', (t) => {
  const root = tempDir(t, 'doflow-hybrid-c-graph-');
  const answer = adaptersC.runC({ corpus: 'code', task: { class: 'impact-refactor', query: 'who calls parseThing' }, exportRoot: root,
    capabilities: { 'code.impact-analysis': { providers: [{ id: 'graphify.query' }] } }, bins: { graphify: path.join(root, 'missing-graphify') } });
  assert.equal(answer.result, 'UNREACHED');
  assert.equal(answer.providers[0].id, 'graphify.query');
});

test('six holdout slots reserve atomically, survive started failures, and reject competing retries', async (t) => {
  const { repoRoot, sealMeta } = sealedWorld(t);
  const outcomes = await Promise.allSettled([Promise.resolve().then(() => protocol.reserveSixSlots({ repoRoot, snapshotId: 9, sealMeta, resultFiles: [] })),
    Promise.resolve().then(() => protocol.reserveSixSlots({ repoRoot, snapshotId: 9, sealMeta, resultFiles: [] }))]);
  const first = outcomes.find((result) => result.status === 'fulfilled').value;
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(first.slots.length, 6);
  assert.throws(() => protocol.reserveSixSlots({ repoRoot, snapshotId: 9, sealMeta, resultFiles: [] }), /already reserved/);
  assert.equal(fs.existsSync(first.reservation), true, 'started evaluation failure consumes the reservation');
  assert.equal(JSON.parse(fs.readFileSync(first.reservation, 'utf8')).slots.length, 6);
});

test('all holdout protocol invocations serialize for a snapshot and release the active lease', (t) => {
  const { repoRoot } = sealedWorld(t);
  const lease = protocol.acquireInvocationLock({ repoRoot, snapshotId: 9 });
  assert.throws(() => protocol.acquireInvocationLock({ repoRoot, snapshotId: 9 }), /already active/);
  lease.release();
  const next = protocol.acquireInvocationLock({ repoRoot, snapshotId: 9 });
  next.release();
});

test('holdout reserves before decrypt and releases only on a failed pre-evaluation check', (t) => {
  const { repoRoot, sealMeta } = sealedWorld(t);
  const base = { args: { protocol: protocol.ID, config: 'A,B,C', corpus: 'all' }, repoRoot, snapshot: { snapshotId: 9 }, thresholds, sealMeta, home: repoRoot };
  const failed = preconditions.check({ ...base, env: { DOFLOW_HOLDOUT_KEY: 'incorrect passphrase' } });
  assert.equal(failed.precondition, 'd');
  const resultsDir = path.join(repoRoot, 'bench/retrieval/results');
  assert.equal(fs.readdirSync(resultsDir).some((name) => name.endsWith('.reserved.json')), false);
  assert.equal(fs.readdirSync(resultsDir).some((name) => name.startsWith('.hybrid-c-v1-released-')), true);
  const passed = preconditions.check({ ...base, env: { DOFLOW_HOLDOUT_KEY: PASS } });
  assert.equal(passed.ok, true);
  assert.equal(fs.existsSync(passed.reservation.reservation), true);
  assert.match(JSON.stringify(passed), /slots/);
  assert.equal(preconditions.check({ ...base, args: { config: 'A,B' }, env: { DOFLOW_HOLDOUT_KEY: PASS } }).precondition, 'e',
    'legacy runs cannot race a reserved C generation');
});

test('gate output is aggregate-only and never converts absent paid measurements into a pass', () => {
  const missing = gate.evaluate({ thresholds: {} });
  assert.deepEqual(missing.rows.map((row) => [row.id, row.verdict]), gate.REQUIRED_THRESHOLDS.map((id) => [id, 'UNRESOLVED']));
  assert.equal(missing.verdict, 'UNRESOLVED');
  const report = gate.evaluate({ thresholds: { thresholds: [{ id: 'T-005', comparator: '>=', value: 0 }, { id: 'T-002', comparator: '>=', value: 0.1, relativeTo: 'B' }] },
    aggregates: { code: { C: { 'conceptual-discovery': { underpowered: false, metrics: { fileRecallAt10: { value: 0.7 } } } } } } });
  assert.equal(report.rows.find((row) => row.id === 'T-005').verdict, 'UNREACHED');
  assert.equal(report.rows.find((row) => row.id === 'T-002').verdict, 'UNRESOLVED');
  assert.equal(report.verdict, 'UNRESOLVED');
  assert.doesNotMatch(JSON.stringify(report), /HC-001|query|qrels|snippet/);
  const compared = gate.evaluate({ thresholds: { thresholds: [{ id: 'T-002', metric: 'fileRecallAt10', class: 'conceptual-discovery', corpus: 'code',
    comparator: '>=', value: 0.1, relativeTo: 'B', requireCiLowerAboveZero: true }] },
  comparisons: { code: [{ metric: 'fileRecallAt10', class: 'conceptual-discovery', a: 'C', b: 'B', diff: 0.2, ci95: [0.05, 0.4] }] } });
  assert.equal(compared.rows.find((row) => row.id === 'T-002').verdict, 'PASS');
  assert.equal(compared.verdict, 'UNRESOLVED', 'missing required threshold rows keep the overall gate unresolved');
});
