'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { findOnPath } = require('../../src/runtime/worker/readiness.ts');
const dispatcher = require('../../bench/retrieval/lib/adapters.ts');
const adaptersC = require('../../bench/retrieval/lib/adapters-c.ts');
const run = require('../../bench/retrieval/lib/verbs/run.ts');
const preconditions = require('../../bench/retrieval/lib/verbs/holdout-preconditions.ts');
const protocol = require('../../bench/retrieval/lib/hybrid-protocol.ts');
const gate = require('../../bench/retrieval/lib/hybrid-gate.ts');
const seal = require('../../bench/retrieval/lib/seal.ts');
const verifyVerb = require('../../bench/retrieval/lib/verbs/verify.ts');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const environment = require('../../bench/retrieval/lib/environment.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const report = require('../../bench/retrieval/lib/report.ts');

const PASS = 'a sufficiently long test-only passphrase';
// FU-w5wv06: H1's control retrieves through native.rg, which spawns `rg` by name; without it the test cannot run.
// findOnPath is a PATH lookup that starts no process (the same helper test/e2e/dispatch-loop.e2e.test.js loads).
const RG_SKIP = findOnPath('rg', process.env) ? false : 'ripgrep (rg) not on PATH: native.rg cannot serve the control';
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
  assert.equal(requests[0].query, '"odd literal"'); assert.equal(requests[0].profile, 'lexical-only');
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
  comparisons: { code: [{ metric: 'fileRecallAt10', class: 'conceptual-discovery', a: 'C', b: 'B', diff: 0.2, ci95: [0.05, 0.4] }] },
  aggregates: { code: { B: { 'conceptual-discovery': { underpowered: false } }, C: { 'conceptual-discovery': { underpowered: false } } } } });
  assert.equal(compared.rows.find((row) => row.id === 'T-002').verdict, 'PASS');
  assert.equal(compared.verdict, 'UNRESOLVED', 'missing required threshold rows keep the overall gate unresolved');
});

test('R6: RULE-003 holds for compared thresholds: an underpowered or unmeasured class never passes T-002', () => {
  const thresholds = { thresholds: [{ id: 'T-002', metric: 'fileRecallAt10', class: 'conceptual-discovery', corpus: 'code',
    comparator: '>=', value: 0.1, relativeTo: 'B', requireCiLowerAboveZero: true }] };
  const comparisons = { code: [{ metric: 'fileRecallAt10', class: 'conceptual-discovery', a: 'B', b: 'C', diff: -0.2, ci95: [-0.4, -0.05] }] };
  const row = (C, B) => gate.evaluate({ thresholds, comparisons, aggregates: { code: { B: { 'conceptual-discovery': B }, C: { 'conceptual-discovery': C } } } })
    .rows.find((r) => r.id === 'T-002');
  assert.deepEqual(row({ underpowered: false }, { underpowered: false }), { id: 'T-002', verdict: 'PASS', observations: 1, ciLowerAboveZero: true }, 'B-vs-C rows are sign-flipped to C minus B');
  assert.equal(row({ underpowered: true }, { underpowered: false }).verdict, 'UNRESOLVED');
  assert.equal(row({ underpowered: false, state: 'unreached' }, { underpowered: false }).verdict, 'UNRESOLVED');
  assert.equal(row({ underpowered: false }, undefined).verdict, 'UNRESOLVED');
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
  assert.deepEqual(mapped.rawValidity, { raw: 3, delivered: 1, rejected: 2, gaps: 2, semanticReached: 0 });
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
  assert.deepEqual(code.C.classes['conceptual-discovery'].rawValidity, { answered: 3, raw: 12, rejected: 9, delivered: 3, semanticReached: 0 });
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

// A verify outcome as this machine produces it against the 074 snapshot pins (semble 0.6.1, graphify 0.9.71, rtk 0.50.0).
function driftedVerify(w, actual = { semble: '0.7.0', graphify: 'graphify 0.9.92', rtk: 'rtk 1.0.1' }) {
  const legacy = { semble: '0.6.1', graphify: 'graphify 0.9.71', rtk: 'rtk 0.50.0', jq: 'jq-1.7.1' };
  return () => {
    const real = verifyVerb.verifySnapshot({ snapshotPath: w.snapshotPath, repoRoot: w.repo });
    const tools = Object.entries(legacy).map(([id, expected]) => ({ id, expected, actual: actual[id] || expected, state: 'present', ok: (actual[id] || expected) === expected }));
    const drift = tools.filter((row) => !row.ok);
    return { ...real, exitCode: drift.length ? 4 : 0, codes: drift.length ? [4] : [], message: drift.map((row) => `tool ${row.id}: pinned "${row.expected}", found "${row.actual}"`).join('; ') || undefined,
      result: { ...real.result, tools }, snapshot: { ...real.snapshot, tools: Object.entries(legacy).map(([id, versionLine]) => ({ id, versionCommand: [id, '--version'], versionLine, state: 'present' })) } };
  };
}

test('hybrid-c-v1 grades semble/graphify/rtk against its own DEC-017 pins; the legacy A/B verdict is unchanged', (t) => {
  assert.deepEqual(protocol.TOOL_PINS, { semble: '0.7.0', graphify: 'graphify 0.9.92', rtk: 'rtk 1.0.1' });
  const w = devWorld(t);
  const deps = { ...runDeps(() => ({ ok: true, elapsedMs: 1, chunks: 1, artifactBytes: 1, freshness: 'FRESH' })), verifySnapshot: driftedVerify(w) };
  const hybrid = runHybrid(w, deps);
  assert.equal(hybrid.exitCode, 0, hybrid.lines && hybrid.lines.join('\n'));
  assert.equal(hybrid.report.protocol, protocol.ID);
  const legacy = run.execute({ args: { split: 'dev', corpus: 'all' }, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, deps });
  assert.equal(legacy.exitCode, 4, 'legacy A/B still refuses on the 074 pins');
  assert.match(legacy.error, /tool rtk: pinned "rtk 0\.50\.0", found "rtk 1\.0\.1"/);
  const graded = protocol.applyToolPins(driftedVerify(w)());
  assert.deepEqual(graded.snapshot.tools.map((tool) => `${tool.id} ${tool.versionLine}`), ['semble 0.7.0', 'graphify graphify 0.9.92', 'rtk rtk 1.0.1', 'jq jq-1.7.1']);
});

test('hybrid-c-v1 pin controls: an off-pin tool still refuses with exit 4, and manifest drift keeps exit 3', (t) => {
  const w = devWorld(t);
  const old = protocol.applyToolPins(driftedVerify(w, { semble: '0.7.0', graphify: 'graphify 0.9.92' })());
  assert.equal(old.exitCode, 4);
  assert.equal(old.message, 'tool rtk: pinned "rtk 1.0.1", found "rtk 0.50.0"');
  const missing = driftedVerify(w)();
  const manifest = protocol.applyToolPins({ ...missing, exitCode: 3, codes: [3], message: 'manifest does not match the pinned commit' });
  assert.equal(manifest.exitCode, 3); assert.equal(manifest.message, 'manifest does not match the pinned commit');
  const absent = protocol.applyToolPins({ ...missing, result: { ...missing.result, tools: missing.result.tools.map((row) => (row.id === 'semble' ? { ...row, actual: 'absent', state: 'absent' } : row)) } });
  assert.equal(absent.exitCode, 4); assert.match(absent.message, /tool semble: pinned "0\.7\.0", found "absent"/);
  const deps = { ...runDeps(() => ({ ok: true })), verifySnapshot: driftedVerify(w, { semble: '0.7.0', graphify: 'graphify 0.9.92', rtk: 'rtk 0.99.0' }) };
  assert.equal(runHybrid(w, deps).exitCode, 4);
});

// R4 (a): C's index state must never enter A's graph/semble input, whatever order the setup runs in.
function isolationDeps({ cIndexInto } = {}) {
  const seen = { order: [], graphInput: [], configRoots: [] };
  const stateOf = (root) => fs.existsSync(path.join(root, '.doflow', 'index'));
  const base = runDeps((x) => {
    seen.order.push('C-build');
    const target = cIndexInto ? cIndexInto(x.exportRoot) : x.exportRoot;
    fs.mkdirSync(path.join(target, '.doflow', 'index', 'code', 'semble', 's', 'mirror', 'src'), { recursive: true });
    fs.writeFileSync(path.join(target, '.doflow', 'index', 'code', 'semble', 's', 'mirror', 'src', 'a.ts'), 'mirror copy\n');
    seen.cRoot = x.exportRoot;
    return { ok: true, elapsedMs: 1, chunks: 1, artifactBytes: 1, freshness: 'FRESH' };
  });
  return { seen, deps: { ...base,
    buildIndexes: (x) => { seen.order.push('A-graph'); seen.graphInput.push({ root: x.exportRoot, contaminated: stateOf(x.exportRoot) }); return base.buildIndexes(x); },
    runConfig: (x) => { seen.configRoots.push({ config: x.config, corpus: x.corpus, root: x.exportRoot, contaminated: stateOf(x.exportRoot) }); return base.runConfig(x); } } };
}

test('R4a: with C built first, A graph input and A/B query roots exclude .doflow/index; C queries its own indexed tree', (t) => {
  const w = devWorld(t);
  const { seen, deps } = isolationDeps();
  const out = runHybrid(w, deps);
  assert.equal(out.exitCode, 0, out.lines && out.lines.join('\n'));
  assert.deepEqual(seen.order, ['C-build', 'A-graph'], 'the C build still runs before A graph setup');
  assert.equal(seen.graphInput.length, 1);
  assert.equal(seen.graphInput[0].contaminated, false, 'A graph input has no C index state');
  assert.notEqual(seen.graphInput[0].root, seen.cRoot);
  const code = seen.configRoots.filter((r) => r.corpus === 'code');
  for (const r of code.filter((x) => x.config !== 'C')) assert.equal(r.contaminated, false, `${r.config} query root has no C index state`);
  for (const r of code.filter((x) => x.config === 'C')) { assert.equal(r.root, seen.cRoot); assert.equal(r.contaminated, true); }
  assert.ok(code.some((r) => r.config === 'C'));
});

test('R4a control: the probe reports contamination when C index state lands in the tree A indexes', (t) => {
  const w = devWorld(t);
  const { seen, deps } = isolationDeps({ cIndexInto: (cRoot) => path.join(path.dirname(cRoot), 'tree') });
  assert.equal(runHybrid(w, deps).exitCode, 0);
  assert.equal(seen.graphInput[0].contaminated, true, 'a shared-tree C build would reach A graph input');
});

test('R4a: C graph-routed classes delegate to A, so they run on the tree A indexed', () => {
  for (const cls of ['impact-refactor', 'verification-failure']) assert.equal(adaptersC.delegatesToA({ class: cls }), true);
  for (const cls of ['exact-lookup', 'conceptual-discovery']) assert.equal(adaptersC.delegatesToA({ class: cls }), false);
});

// R4 (b): a multiword exact literal must reach the production exact route, as B's `rg -F` does.
function literalWorld(t) {
  const root = tempDir(t, 'doflow-hybrid-c-literal-');
  const files = {
    'src/a.ts': 'export function other() {}\nconst x = loadRegistry;\n',
    'src/b.ts': 'export function loadRegistry() {}\n',
    'src/c.ts': 'function helper() { return loadRegistry(); }\nfunction more() {}\n',
  };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); }
  return { root, paths: Object.keys(files) };
}

test('R4b: C exact-lookup sends a multiword literal through the real coordinator as one fixed string', (t) => {
  const { root, paths } = literalWorld(t);
  const answer = adaptersC.runC({ corpus: 'code', task: { class: 'exact-lookup', literal: 'function loadRegistry' }, exportRoot: root, admittedPaths: paths });
  assert.equal(answer.result, 'RETRIEVED');
  assert.deepEqual(answer.candidates.map((c) => `${c.path}:${c.startLine}`), ['src/b.ts:1'], 'only the line holding the literal, as B finds it');
});

test('R4b control: the coordinator ignores an `intent` option, so the old unquoted request routes a multiword literal conceptual', (t) => {
  const { root, paths } = literalWorld(t);
  const options = { root, scopes: paths, query: 'function loadRegistry', top: 10, profile: 'lexical-only', intent: 'exact' };
  const modulePath = path.resolve(__dirname, '../../src/runtime/knowledge/code-retrieval.ts');
  const run = require('node:child_process').spawnSync(process.execPath, ['-e', adaptersC.BRIDGE], { input: JSON.stringify({ modulePath, options }), encoding: 'utf8' });
  const response = JSON.parse(run.stdout).response;
  assert.equal(response.queryClass, 'conceptual');
  assert.ok(response.results.length > 1, 'term matching returns lines without the literal');
});

// R6: the holdout writer's privacy check is the strict consumer of every C result shape. A run over a
// sealed generation with a task in every class must clear it (the g2 run failed on rawValidity.tasks).
const REAL_THRESHOLDS = fs.readFileSync(path.resolve(__dirname, '../../bench/retrieval/thresholds.json'), 'utf8');
function holdoutWorld(t, generation = 7) {
  const repo = tempDir(t, 'doflow-hybrid-c-holdout-run-');
  gitIn(repo, 'init', '-q');
  const files = { 'src/a.ts': Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'core/shared/guidance/g.md': '## Alpha\nalpha body\n',
    'bench/retrieval/thresholds.json': REAL_THRESHOLDS };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), body); }
  gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-q', '-m', 'c');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit: gitIn(repo, 'rev-parse', 'HEAD'), seed: 20261012, repoRoot: repo, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const q = (corpus, id = 'q1', startLine = 1) => (corpus === 'code' ? { id, path: 'src/a.ts', startLine, endLine: startLine + 1, rel: 2 }
    : { id, path: 'core/shared/guidance/g.md', startLine: 1, endLine: 2, heading: 'Alpha', rel: 2 });
  const extra = {
    'exact-lookup': { literal: 'line 1' },
    'impact-refactor': (c) => ({ dependencies: [{ ...q(c, 'q2', 3), rel: 1 }] }),
    'stale-index': { setup: { patchText: 'diff --git a/x b/x\n' } },
    'dirty-tree': { setup: { patchText: 'diff --git a/x b/x\n' } },
    'unavailable-provider': { setup: { disable: ['semble.search'] } },
    'oversized-context': { expect: { result: ['RETRIEVED'], budgetBytes: 100, mustInclude: ['q1'] } },
    'verification-failure': { expect: { result: ['RETRIEVED'], mustSurvive: { exitCode: 1, lines: ['boom'] } }, setup: { command: ['false'] } },
  };
  const sealMeta = {};
  for (const corpus of protocol.CORPORA) {
    const tasks = require('../../bench/retrieval/lib/metrics.ts').classesFor(corpus).map((cls, i) => {
      const more = typeof extra[cls] === 'function' ? extra[cls](corpus) : (extra[cls] || {});
      return { id: `H${corpus === 'code' ? 'C' : 'G'}-00${i + 1}`, split: 'holdout', corpus, class: cls, query: 'where is thing', qrels: [q(corpus)],
        expect: { result: ['RETRIEVED'] }, truthSource: ['x:1'], author: 'worker:t', ...more };
    });
    const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: snapshot.snapshotId, split: 'holdout', tasks }, { snapshot, manifest, repoRoot: repo, tokenize: (x) => String(x).toLowerCase().split(/[^a-z0-9]+/).filter((y) => y.length >= 2) });
    assert.deepEqual(tasksLib.validateTaskFile(taskFile, { split: 'holdout', snapshot, manifest, repoRoot: repo, corpus }), []);
    const sealed = seal.sealTasks({ taskFile, passphrase: PASS, corpus, snapshotId: snapshot.snapshotId, generation, sealedBy: 'worker:t', classes: require('../../bench/retrieval/lib/metrics.ts').CLASSES });
    seal.writeSealed({ dir: path.join(outDir, 'holdout'), corpus, generation, envelopeText: sealed.envelopeText, sealText: sealed.sealText });
    sealMeta[corpus] = sealed.seal;
  }
  return { repo, snapshotPath: path.join(outDir, 'snapshot.json'), tmp: path.join(tempDir(t, 'doflow-hybrid-c-holdout-tmp-'), 'work'), results: path.join(outDir, 'results') };
}
// Answers shaped as the real adapters return them: C's coordinator classes carry rawValidity (adapters-c mapCodeResponse).
function holdoutDeps({ cAnswer } = {}) {
  const base = runDeps(() => ({ ok: true, elapsedMs: 9, chunks: 3, artifactBytes: 64, freshness: 'FRESH' }));
  return { ...base, preconditions: undefined, latency: { warmups: 1, runs: 2 },
    runConfig: (x) => {
      if (x.config === 'C' && cAnswer) { const own = cAnswer(x); if (own) return own; }
      const answer = base.runConfig(x);
      const coordinator = x.config === 'C' && x.corpus === 'code' && ['exact-lookup', 'conceptual-discovery'].includes(x.task.class);
      const { rawValidity, ...rest } = answer;
      return coordinator ? { ...rest, rawValidity: { raw: 4, delivered: 1, rejected: 3, gaps: 3 }, effectiveProfile: 'hybrid' } : rest;
    } };
}
const runHoldout = (w, deps) => run.execute({ args: { protocol: protocol.ID, split: 'holdout', config: 'A,B,C', corpus: 'all' }, snapshotPath: w.snapshotPath, repoRoot: w.repo,
  tmp: w.tmp, env: { DOFLOW_HOLDOUT_KEY: PASS }, home: w.repo, deps: Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)) });
const holdoutFiles = (w) => (fs.existsSync(w.results) ? fs.readdirSync(w.results).filter((f) => /^holdout-.*\.json$/.test(f)).sort() : []);

test('R6: a C holdout run over every class clears the holdout privacy check and writes all six results and their comparisons', (t) => {
  const w = holdoutWorld(t);
  const out = runHoldout(w, holdoutDeps());
  assert.equal(out.exitCode, 0, out.lines && out.lines.join('\n'));
  const names = holdoutFiles(w);
  for (const corpus of ['code', 'guidance']) {
    for (const config of ['A', 'B', 'C']) assert.ok(names.includes(`holdout-1-g7-${corpus}-${config}.json`), `${corpus} ${config} written`);
    for (const pair of ['A-vs-B', 'A-vs-C', 'B-vs-C']) assert.ok(names.includes(`holdout-1-g7-${corpus}-${pair}.json`), `${corpus} ${pair} written`);
  }
  for (const name of names) report.assertNoTaskDetail(JSON.parse(fs.readFileSync(path.join(w.results, name), 'utf8')), name);
  report.assertNoTaskDetail({ aggregates: out.aggregates, gate: out.gate, indexes: out.indexes }, 'holdout stdout');
  const c = JSON.parse(fs.readFileSync(path.join(w.results, 'holdout-1-g7-code-C.json'), 'utf8'));
  for (const cls of require('../../bench/retrieval/lib/metrics.ts').classesFor('code')) assert.equal(c.classes[cls].n, 1, `code C ${cls} measured`);
  assert.deepEqual(c.classes['exact-lookup'].rawValidity, { answered: 1, raw: 4, rejected: 3, delivered: 1, semanticReached: 0 });
  // H1: every C class row names where it was served; A and B rows carry no such label.
  assert.deepEqual(Object.fromEntries(Object.entries(c.classes).filter(([, row]) => row.applicable).map(([cls, row]) => [cls, row.servedBy])), {
    'exact-lookup': 'coordinator', 'conceptual-discovery': 'coordinator', 'impact-refactor': 'delegated-A', 'verification-failure': 'delegated-A',
    'stale-index': 'delegated-B', 'dirty-tree': 'delegated-B', 'unavailable-provider': 'delegated-B', 'oversized-context': 'delegated-B' });
  const guidanceC = JSON.parse(fs.readFileSync(path.join(w.results, 'holdout-1-g7-guidance-C.json'), 'utf8'));
  for (const row of Object.values(guidanceC.classes)) if (row.applicable) assert.equal(row.servedBy, 'delegated-B');
  const codeB = JSON.parse(fs.readFileSync(path.join(w.results, 'holdout-1-g7-code-B.json'), 'utf8'));
  for (const row of Object.values(codeB.classes)) assert.equal(row.servedBy, undefined);
  assert.deepEqual(out.gate.rows.map((row) => row.id), gate.REQUIRED_THRESHOLDS);
  assert.deepEqual(out.gate.rows.filter((row) => row.verdict === 'UNREACHED').map((row) => row.id), ['T-005', 'T-006']);
  assert.equal(fs.readdirSync(w.results).filter((f) => f.endsWith('.reserved.json')).length, 1, 'the reservation stays as the consumption record');
});

test('R6 negative control: the pre-fix rawValidity shape fails the same holdout validation', () => {
  const classes = { 'exact-lookup': { applicable: true, n: 10, metrics: {}, rawValidity: { tasks: 10, raw: 31, rejected: 0, delivered: 31 } } };
  const build = (cls) => report.buildHoldoutResult({ snapshotId: 1, generation: 7, corpus: 'code', config: 'C', sealPlaintextSha256: 'x', thresholdsCommit: 'y',
    runAt: 'z', runIndex: 1, machineId: 'm', classes: cls });
  assert.throws(() => build(classes), /may not carry "tasks" \(at \.classes\.exact-lookup\.rawValidity\)/);
  assert.doesNotThrow(() => build({ 'exact-lookup': { ...classes['exact-lookup'], rawValidity: { answered: 10, raw: 31, rejected: 0, delivered: 31 } } }));
});

test('R6 one-shot: a failure after evaluation starts writes no partial result, closes all six slots unreached, keeps the reservation, and a retry refuses', (t) => {
  const w = holdoutWorld(t);
  // The last corpus's C result carries a task id in a provider cause: every earlier configuration is valid.
  assert.throws(() => runHoldout(w, holdoutDeps({ cAnswer: ({ task }) => (task.class === 'stale-index' && task.corpus === 'guidance'
    ? { result: 'UNREACHED', freshness: 'UNKNOWN', candidates: [], providers: [{ id: 'guidance.bm25', state: 'unreached', cause: `${task.id} failed` }], payloadBytes: 0, wallMs: 1 } : null) })),
  /holdout result may not carry a task id/);
  const names = holdoutFiles(w);
  assert.deepEqual(names, ['code-A', 'code-B', 'code-C', 'guidance-A', 'guidance-B', 'guidance-C'].map((s) => `holdout-1-g7-${s}.json`),
    'every reserved slot is closed by an aggregate file; no comparison or measured partial result is written');
  for (const name of names) {
    const body = JSON.parse(fs.readFileSync(path.join(w.results, name), 'utf8'));
    report.assertNoTaskDetail(body, name);
    assert.equal(body.protocol, protocol.ID);
    for (const row of Object.values(body.classes)) if (row.applicable) assert.deepEqual([row.state, row.metrics], ['unreached', undefined], `${name} carries no measurement`);
    for (const row of Object.values(body.classes)) if (row.applicable) assert.equal(Boolean(row.servedBy), body.config === 'C', `${name} labels a C row only`);
    assert.doesNotMatch(JSON.stringify(body), /failed"|guidance\.bm25/, 'the error text stays out of the file');
  }
  assert.equal(fs.readdirSync(w.results).filter((f) => f.endsWith('.reserved.json')).length, 1);
  const retry = runHoldout(w, holdoutDeps());
  assert.equal(retry.exitCode, 2);
  assert.match(retry.lines.join('\n'), /precondition \(e\).*result already exists/);
});

test('R6 one-shot: an adapter fault mid-evaluation also closes every slot, and a dev run never writes holdout files', (t) => {
  const w = holdoutWorld(t);
  assert.throws(() => runHoldout(w, holdoutDeps({ cAnswer: ({ task, corpus }) => { if (corpus === 'code' && task.class === 'conceptual-discovery') throw new Error('injected'); return null; } })), /injected/);
  assert.equal(holdoutFiles(w).length, 6);
  const dev = devWorld(t);
  assert.equal(runHybrid(dev, runDeps(() => ({ ok: true }))).exitCode, 0);
  assert.equal(fs.existsSync(path.join(dev.repo, 'bench/retrieval/results')), false);
});

// H1 (review X1): C's delegated paths honour an injected fault exactly as the configuration they run as.
test('H1: a code unavailable-provider task with native.rg disabled is unreached for C exactly as for B; servedBy names each route', { skip: RG_SKIP }, (t) => {
  const root = tempDir(t, 'doflow-hybrid-c-disable-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'const thing = 1; // where is thing\n');
  const task = { id: 'DC-001', corpus: 'code', class: 'unavailable-provider', literal: 'where is thing', setup: { disable: ['native.rg'] } };
  const common = { corpus: 'code', exportRoot: root, admittedPaths: ['src/a.ts'], protocol: protocol.ID };
  const outcome = (answer) => ({ result: answer.result, freshness: answer.freshness, candidates: answer.candidates, providers: answer.providers });
  const b = dispatcher.runConfig({ ...common, task, config: 'B' });
  const c = dispatcher.runConfig({ ...common, task, config: 'C' });
  assert.equal(b.result, 'UNREACHED');
  assert.deepEqual(outcome(c), outcome(b), 'C changes its outcome exactly as B does');
  const enabled = dispatcher.runConfig({ ...common, task: { ...task, setup: undefined }, config: 'C' });
  assert.equal(enabled.result, 'RETRIEVED', 'control: without the fault the same task retrieves through B\'s path');
  const guidance = adaptersC.runC({ corpus: 'guidance', task: { class: 'stale-index', query: 'q', setup: { disable: ['guidance.bm25'] } }, exportRoot: root });
  assert.deepEqual([guidance.result, guidance.providers[0].id, guidance.providers[0].cause], ['UNREACHED', 'guidance.bm25', 'disabled by setup.disable']);
  assert.deepEqual(['exact-lookup', 'conceptual-discovery', 'impact-refactor', 'verification-failure', 'unavailable-provider'].map((cls) => adaptersC.servedBy('code', cls)),
    ['coordinator', 'coordinator', 'delegated-A', 'delegated-A', 'delegated-B']);
  assert.equal(adaptersC.servedBy('guidance', 'exact-lookup'), 'delegated-B');
});

// H4 (review X12): semanticReached counts answers whose semantic leg answered, from the real coordinator's attempt state.
test('H4: semanticReached counts a reached semantic leg and not an unreached or faulted one', async (t) => {
  const { executeCodeRetrieval } = require('../../src/runtime/knowledge/code-retrieval.ts');
  const root = fs.realpathSync(tempDir(t, 'doflow-hybrid-c-semantic-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function parseThing() { return 1; }\n');
  const ask = (semanticQuery, profile = 'hybrid', query = 'where is the parse thing') => executeCodeRetrieval({ root, scopes: ['src/a.ts'], query, top: 10, profile,
    modelPath: path.join(root, 'model'), providers: { semanticQuery } });
  const reached = adaptersC.mapCodeResponse(await ask(async () => ({ ok: true, freshness: 'FRESH', candidates: [] })));
  const unreached = adaptersC.mapCodeResponse(await ask(async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] })));
  const faulted = adaptersC.mapCodeResponse(await ask(async () => { throw new Error('injected semantic fault'); }));
  const exact = adaptersC.mapCodeResponse(await ask(async () => { throw new Error('exact must not call semantic'); }, 'lexical-only', '"parseThing"'));
  assert.deepEqual([reached, unreached, faulted, exact].map((a) => a.rawValidity.semanticReached), [1, 0, 0, 0]);
  assert.equal(reached.effectiveProfile, 'hybrid'); assert.equal(faulted.effectiveProfile, 'lexical-only');
  const row = run.rawValidityOf([reached, unreached, faulted]);
  assert.deepEqual([row.answered, row.semanticReached], [3, 1]);
  report.assertNoTaskDetail({ classes: { 'conceptual-discovery': { rawValidity: row } } });
});

// H2 (review X11): absolute rows name what they leave out; relative `corpus: '*'` rows need every covered corpus.
test('H2: an absolute gate row lists every excluded C class with its reason and keeps its verdict rule', () => {
  const thresholds = { thresholds: [{ id: 'T-001', metric: 'falseAbsence', corpus: '*', class: '*', comparator: '==', value: 0 }] };
  const measured = { applicable: true, n: 10, underpowered: false, state: 'measured', metrics: { falseAbsence: { value: 0, n: 10, count: 0 } } };
  const aggregates = {
    code: { B: { 'exact-lookup': { ...measured, underpowered: true } }, C: { 'exact-lookup': measured, 'conceptual-discovery': { ...measured, underpowered: true, metrics: { falseAbsence: { value: 0.2, n: 2, count: 2 } } },
      'stale-index': { applicable: true, n: 3, underpowered: false, state: 'unreached' } } },
    guidance: { C: { 'impact-refactor': { applicable: false, reason: 'n/a' }, 'exact-lookup': { ...measured, metrics: {} } } },
  };
  const t001 = (aggs) => gate.evaluate({ thresholds, aggregates: aggs }).rows.find((r) => r.id === 'T-001');
  const row = t001(aggregates);
  assert.equal(row.verdict, 'PASS'); assert.equal(row.observations, 1, 'which classes count is unchanged');
  assert.deepEqual(row.excluded, [
    { corpus: 'code', class: 'conceptual-discovery', reason: 'underpowered' }, { corpus: 'code', class: 'stale-index', reason: 'unreached' },
    { corpus: 'guidance', class: 'impact-refactor', reason: 'not-applicable' }, { corpus: 'guidance', class: 'exact-lookup', reason: 'metric-absent' }]);
  assert.deepEqual(t001({ code: aggregates.code }).excluded.at(-1), { corpus: 'guidance', class: '*', reason: 'missing' });
  assert.deepEqual(t001({}).excluded, [{ corpus: 'code', class: '*', reason: 'missing' }, { corpus: 'guidance', class: '*', reason: 'missing' }]);
  report.assertNoTaskDetail(row, 'gate row');
});

test('H2: a corpus:* relative row passes only when every covered corpus contributes, and an observed failure still fails', () => {
  const thresholds = { thresholds: [{ id: 'T-003', metric: 'successAt1', corpus: '*', class: 'exact-lookup', comparator: '>=', value: 0, relativeTo: 'B' }] };
  const est = { underpowered: false };
  const agg = (corpora) => Object.fromEntries(corpora.map((c) => [c, { B: { 'exact-lookup': est }, C: { 'exact-lookup': est } }]));
  const cmp = (diff) => [{ metric: 'successAt1', class: 'exact-lookup', a: 'B', b: 'C', diff, ci95: [-0.1, 0.1] }];
  const t003 = (aggregates, comparisons) => gate.evaluate({ thresholds, aggregates, comparisons }).rows.find((r) => r.id === 'T-003');
  assert.equal(t003(agg(['code', 'guidance']), { code: cmp(0), guidance: cmp(0) }).verdict, 'PASS');
  const codeOnly = t003(agg(['code']), { code: cmp(0) });
  assert.equal(codeOnly.verdict, 'UNRESOLVED', 'one corpus cannot pass a threshold that covers both');
  assert.deepEqual(codeOnly.missingCorpora, ['guidance']);
  const weak = t003({ ...agg(['code']), guidance: { B: { 'exact-lookup': { underpowered: true } }, C: { 'exact-lookup': est } } }, { code: cmp(0), guidance: cmp(0) });
  assert.deepEqual([weak.verdict, weak.missingCorpora], ['UNRESOLVED', ['guidance']]);
  assert.equal(t003(agg(['code']), { code: cmp(0.5) }).verdict, 'FAIL', 'C 0.5 below B on code fails whatever guidance shows');
});

// H3 (review X10): a hybrid holdout run cannot be narrowed to one class, because it consumes the whole generation.
test('H3: --class on a hybrid-c-v1 holdout run is refused with exit 2 before any slot is reserved', (t) => {
  const w = holdoutWorld(t);
  const deps = Object.fromEntries(Object.entries(holdoutDeps()).filter(([, v]) => v !== undefined));
  let error;
  try {
    run.execute({ args: { protocol: protocol.ID, split: 'holdout', config: 'A,B,C', corpus: 'all', class: 'exact-lookup' }, snapshotPath: w.snapshotPath,
      repoRoot: w.repo, tmp: w.tmp, env: { DOFLOW_HOLDOUT_KEY: PASS }, home: w.repo, deps });
  } catch (caught) { error = caught; }
  assert.ok(error, 'the run is refused');
  assert.match(error.message, /--class is not accepted with --protocol hybrid-c-v1 --split holdout/);
  assert.equal(error.exitCode, 2);
  assert.equal(fs.existsSync(w.results), false, 'no reservation, release record or result file was written');
  assert.equal(run.parseSelection({ protocol: protocol.ID, class: 'exact-lookup' }).cls, 'exact-lookup', 'a dev hybrid run may still narrow by class');
});
