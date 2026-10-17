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
const verifyVerb = require('../../bench/retrieval/lib/verbs/verify.js');
const tasksLib = require('../../bench/retrieval/lib/tasks.js');
const environment = require('../../bench/retrieval/lib/environment.js');
const snap = require('../../bench/retrieval/lib/snapshot.js');

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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const okBody = { effectiveProfile: 'hybrid', attempts: [{ provider: 'native.rg', complete: true }],
  gaps: [{ source: 'live-validation', reason: 'stale' }, { source: 'live-validation', reason: 'moved' }],
  results: [{ locator: { file: 'src/a.ts', line: 4, endLine: 5 }, provider: 'native.rg', snippet: 'live' }] };

test('F4: C wallMs is the measured coordinator time, not a constant 0', () => {
  const answer = adaptersC.runC({ corpus: 'code', task: { class: 'conceptual-discovery', query: 'q' }, exportRoot: '/repo', admittedPaths: ['src/a.ts'],
    executeCodeRetrieval: () => { sleep(25); return { exit: 0, response: okBody }; } });
  assert.ok(answer.wallMs >= 20 && answer.wallMs < 5000, `wallMs ${answer.wallMs} must cover the 25 ms coordinator call`);
  assert.equal(adaptersC.mapCodeResponse({ exit: 0, response: okBody }).wallMs, 0, 'a bare mapping measures nothing; runC supplies the clock');
});

test('F4 control: bridge failure paths report their real elapsed time too', () => {
  const task = { class: 'conceptual-discovery', query: 'q' };
  const slow = (out) => () => { sleep(25); return out; };
  const common = { corpus: 'code', task, exportRoot: '/repo', admittedPaths: ['src/a.ts'] };
  const crashed = adaptersC.runC({ ...common, spawn: slow({ status: 1, stdout: '' }) });
  const garbled = adaptersC.runC({ ...common, spawn: slow({ status: 0, stdout: 'not json' }) });
  for (const answer of [crashed, garbled]) { assert.equal(answer.result, 'UNREACHED'); assert.ok(answer.wallMs >= 20, `wallMs ${answer.wallMs}`); }
  assert.match(crashed.providers[0].cause, /exited 1/);
  assert.match(garbled.providers[0].cause, /invalid JSON/);
});

test('mapCodeResponse reports raw, rejected and delivered candidate counts', () => {
  const mapped = adaptersC.mapCodeResponse({ exit: 0, response: okBody }, 3);
  assert.equal(mapped.wallMs, 3);
  assert.deepEqual(mapped.rawValidity, { raw: 3, delivered: 1, rejected: 2, gaps: 2 });
});

test('describeIndexBuild reports measured cost, and an unreached build with its cause rather than zeros', () => {
  assert.deepEqual(adaptersC.describeIndexBuild({ ok: true, elapsedMs: 120, chunks: 7, artifactBytes: 4096, freshness: 'FRESH' }, 999),
    { state: 'reached', buildMs: 120, chunks: 7, diskBytes: 4096, peakRssMB: { unmeasured: 'the index builder reports no resident-set size' }, freshness: 'FRESH' });
  assert.equal(adaptersC.describeIndexBuild({ ok: true, chunks: 1, artifactBytes: 1 }, 42).buildMs, 42, 'falls back to the measured wall time');
  const failed = adaptersC.describeIndexBuild({ ok: false, reason: 'local-model-required' }, 5);
  assert.equal(failed.state, 'unreached'); assert.equal(failed.cause, 'local-model-required');
  assert.deepEqual(failed.buildMs, { unmeasured: 'local-model-required' });
  assert.deepEqual(failed.diskBytes, { unmeasured: 'local-model-required' });
  assert.equal(adaptersC.describeIndexBuild({ ok: false, error: 'lifecycle-error', cause: 'boom' }, 5).cause, 'lifecycle-error: boom');
});

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
function devWorld(t) {
  const repo = tempDir(t, 'doflow-hybrid-c-run-');
  gitIn(repo, 'init', '-q');
  const files = { 'src/a.ts': Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'core/shared/guidance/g.md': '## Alpha\nalpha body\n' };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), body); }
  gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-q', '-m', 'c');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit: gitIn(repo, 'rev-parse', 'HEAD'), seed: 20261012, repoRoot: repo, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const mk = (id, corpus, i) => ({ id, split: 'dev', corpus, class: 'conceptual-discovery', query: `where is thing ${i}`,
    qrels: [corpus === 'code' ? { id: 'q1', path: 'src/a.ts', startLine: 1, endLine: 2, rel: 2 } : { id: 'q1', path: 'core/shared/guidance/g.md', startLine: 1, endLine: 2, heading: 'Alpha', rel: 2 }],
    expect: { result: ['RETRIEVED'] }, truthSource: ['x:1'], author: 'worker:t' });
  const tasks = [...[1, 2, 3].map((i) => mk(`DC-00${i}`, 'code', i)), mk('DG-001', 'guidance', 0)];
  const tokenize = (x) => String(x).toLowerCase().split(/[^a-z0-9]+/).filter((y) => y.length >= 2);
  const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: 1, split: 'dev', tasks }, { snapshot, manifest, repoRoot: repo, tokenize });
  for (const task of taskFile.tasks) task.queryOverlap = 0.1;
  fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tasks', 'dev.json'), seal.toFileText(taskFile));
  return { repo, snapshotPath: path.join(outDir, 'snapshot.json'), tmp: path.join(tempDir(t, 'doflow-hybrid-c-tmp-'), 'work') };
}
function runDeps(buildCodeIndex, withValidity = true) {
  return { buildCodeIndex, verifySnapshot: verifyVerb.verifySnapshot, materialiseExport: environment.materialiseExport, preconditions: () => ({ check: () => ({ ok: true }) }),
    buildIndexes: () => ({ buildMs: 5, incrementalMs: 1, diskBytes: 10, peakRssMB: { unmeasured: 'x' } }), latency: { warmups: 1, runs: 6 },
    runConfig: ({ config, corpus, task }) => {
      const q = task.qrels[0];
      const cand = { path: q.path, startLine: q.startLine, endLine: q.endLine, heading: corpus === 'code' ? null : 'Alpha', rank: 1, provider: 'p', snippet: 'abcd', snippetBytes: 4 };
      return { result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', candidates: [cand], providers: [{ id: 'p', state: 'reached' }], payloadBytes: 4,
        wallMs: config === 'C' ? 7 : 1, ...(config === 'C' && corpus === 'code' && withValidity ? { rawValidity: { raw: 4, delivered: 1, rejected: 3, gaps: 3 } } : {}) };
    } };
}
const runHybrid = (w, deps) => run.execute({ args: { protocol: protocol.ID, split: 'dev', corpus: 'all' }, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, deps });

test('F5: the C index build cost and per-class raw/rejected/delivered counts reach the report', (t) => {
  const w = devWorld(t);
  const built = [];
  const out = runHybrid(w, runDeps((x) => { built.push(x); return { ok: true, elapsedMs: 321, chunks: 9, artifactBytes: 2048, freshness: 'FRESH' }; }));
  assert.equal(out.exitCode, 0);
  assert.equal(built.length, 1);
  const code = out.report.corpora.code.configs;
  assert.equal(code.C.index.state, 'reached');
  assert.equal(code.C.index.buildMs, 321); assert.equal(code.C.index.chunks, 9); assert.equal(code.C.index.diskBytes, 2048);
  assert.deepEqual(code.C.classes['conceptual-discovery'].rawValidity, { tasks: 3, raw: 12, rejected: 9, delivered: 3 });
  assert.equal(code.C.classes['conceptual-discovery'].latency.p50Ms, 7, 'the measured C wall time reaches the latency block');
  assert.equal(code.A.index.buildMs, 5, 'A index block is unchanged');
  assert.equal(code.B.index, undefined); assert.equal(code.A.classes['conceptual-discovery'].rawValidity, undefined);
  assert.equal(out.report.corpora.guidance.configs.C.index, undefined);
  assert.doesNotMatch(JSON.stringify(code.C.index) + JSON.stringify(code.C.classes['conceptual-discovery'].rawValidity), /DC-0|where is thing|src\/a\.ts/);
});

test('F5 control: a failed C build is unreached with its cause, and unreported validity is omitted, not zeroed', (t) => {
  const w = devWorld(t);
  const out = runHybrid(w, runDeps(() => ({ ok: false, reason: 'local-model-required' }), false));
  const c = out.report.corpora.code.configs.C;
  assert.equal(c.index.state, 'unreached'); assert.equal(c.index.cause, 'local-model-required');
  assert.deepEqual(c.index.buildMs, { unmeasured: 'local-model-required' });
  assert.equal(c.classes['conceptual-discovery'].rawValidity, undefined);
});

test('F5 control: legacy A,B runs never build or report a C index', (t) => {
  const w = devWorld(t);
  let called = false;
  const out = run.execute({ args: { split: 'dev', corpus: 'all' }, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, deps: runDeps(() => { called = true; return { ok: true }; }) });
  assert.equal(called, false);
  assert.equal(out.report.corpora.code.configs.C, undefined);
  assert.equal(out.report.protocol, undefined);
});
