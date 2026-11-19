'use strict';

// 175 T5 (IC-006, O-4): the user-level result store. One entry per (project key, kind, model digest), fields rebuilt from an
// allowlist on write and on read, an entry that fails the allowlist dropped on read, a write taken under the store's lock
// and landed through a temp file and a rename. Every store lives in a temp folder; the real ~/.doflow is never read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { score } = require('../../src/runtime/advice/replay/score.ts');
const claimLedger = require('../../src/runtime/advice/replay/sources/claim-ledger.ts');
const { acquireLock } = require('../../src/runtime/task-state.ts');
const { readResults, writeResult, resultsFile, MAX_RESULTS } = require('../../src/runtime/advice/replay/results.ts');

const RESULTS_MODULE = path.join(REPO_ROOT, 'src', 'runtime', 'advice', 'replay', 'results.ts');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'advice-replay', 'claim-ledger', 'evidence');
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const KIND = ADVICE.kinds.find((entry: any) => entry.id === 'claim-support');
const SENTINELS = ['SENTINEL-CLAIM-175', 'SENTINEL-PASSAGE-175'];

const hex = (c: string) => `sha256:${c.repeat(64)}`;
const FAST_BARS = { ...ADVICE.bars, statistics: { ...ADVICE.bars.statistics, resamples: 1000 } };

/** The cases the claim-ledger source builds from the T2 fixture: their `state` holds the sentinel strings. */
function fixtureCases(t: any) {
  const root = tempDir(t, 'doflow-results-ledger-');
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  fs.cpSync(FIXTURE, path.join(root, '.doflow', 'state', 'evidence'), { recursive: true });
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: root, env: { HOME: path.join(root, 'home') } });
  return claimLedger.build({ projectRoot: root, roots, kind: KIND }).cases;
}

/** The figures `score` gives for the fixture cases, each answered as the rule answers it. */
function realMetrics(cases: any[]) {
  return score(cases.map((c: any) => ({ id: c.id, label: c.label, rule: c.rule, model: c.rule, latencyMs: 300 })),
    { options: ['yes', 'no'], bars: FAST_BARS, budgetMs: KIND.budgetMs });
}

/** A whole, valid entry: `over` replaces top-level fields. */
function entry(over: any = {}) {
  return {
    kind: 'claim-support', provider: 'local', model: 'decider:4b',
    modelDigest: hex('a'), questionDigest: hex('b'), builderDigest: hex('c'), barsDigest: hex('d'),
    caseSet: { source: 'claim-ledger', origin: 'project', projectKey: hex('e'), digest: hex('f'), eligible: 3, replayed: 3 },
    metrics: {
      n: 3, valid: 3, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} },
      accuracy: { model: 1, rule: 1 }, kappa: { model: null, rule: null, lower: null, gain: null, gainLower: null },
      worse: 0, better: 0, worseShare: 0, minority: 1, latencyMs: { first: 300, p50: 300, p95: 300, max: 300 },
    },
    runAt: '2026-11-19T08:00:00.000Z', doflowVersion: '2.4.0',
    ...over,
  };
}

function store(t: any) {
  const userState = tempDir(t, 'doflow-results-user-state-');
  return { userState, roots: { 'user-state': userState }, file: path.join(userState, 'advice', 'results.json') };
}

function plant(file: string, results: any[], schema: any = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema, results }));
}

test('175 T5 (a): a write keeps only allowlisted fields: no state, standing, case id or case text reaches the file', (t) => {
  const s = store(t);
  const cases = fixtureCases(t);
  assert.ok(cases.length >= 2 && SENTINELS.every((word) => JSON.stringify(cases).includes(word)), 'the fixture cases hold the sentinels');
  const metrics = realMetrics(cases);
  const dirty: any = entry({
    state: cases[0].state, standing: 'act', failedChecks: [], cases, caseIds: cases.map((c: any) => c.id),
    caseSet: { ...entry().caseSet, ids: cases.map((c: any) => c.id), sample: cases[0].state },
    metrics: { ...metrics, worseIds: cases.map((c: any) => c.id), note: SENTINELS[1] },
  });
  const written: string[] = [];
  const fsImpl = { ...fs, writeFileSync: (file: any, data: any, ...rest: any[]) => { written.push(String(data)); return (fs.writeFileSync as any)(file, data, ...rest); } };

  writeResult({ roots: s.roots, entry: dirty, fsImpl });

  const text = fs.readFileSync(s.file, 'utf8');
  for (const blob of [text, ...written]) {
    for (const word of [...SENTINELS, ...cases.map((c: any) => c.id), '"state"', '"standing"', 'worseIds', 'perClass', 'labelCounts', 'caseIds', '"note"', '"ids"']) {
      assert.ok(!blob.includes(word), `${word} reached a written file`);
    }
  }
  const { worseIds, perClass, labelCounts, ...kept } = metrics;
  assert.deepEqual(JSON.parse(text), { schema: 1, results: [entry({ metrics: kept })] });
  assert.deepEqual(readResults({ roots: s.roots }), [entry({ metrics: kept })]);
});

test('175 T5 (a): a write refuses an allowlisted field with a value that is not its shape', (t) => {
  const s = store(t);
  for (const bad of [
    { modelDigest: 'md5:abc' },
    { model: `decider ${SENTINELS[0]}` },
    { metrics: { ...entry().metrics, n: '3' } },
    { caseSet: { ...entry().caseSet, origin: 'elsewhere' } },
    { runAt: 'yesterday' },
  ]) {
    assert.throws(() => writeResult({ roots: s.roots, entry: entry(bad) }), TypeError, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(s.file), false, 'nothing was written');
});

test('175 T5 (b): two processes writing different keys to one store at once both land, and the file parses', async (t) => {
  const scratch = createScratch('doflow-results-concurrent-');
  t.after(() => scratch.remove());
  const perChild = 15;
  const child = (tag: string) => new Promise<number>((resolve, reject) => {
    const code = `
      const path = require('node:path');
      const { writeResult } = require(${JSON.stringify(RESULTS_MODULE)});
      const roots = { 'user-state': path.join(process.env.HOME, '.doflow', 'state') };
      const base = JSON.parse(process.argv[1]);
      for (let i = 0; i < ${perChild}; i++) {
        const digest = 'sha256:' + ${JSON.stringify(tag)}.repeat(56) + String(i).padStart(8, '0');
        writeResult({ roots, entry: { ...base, modelDigest: digest } });
      }`;
    const proc = spawn(process.execPath, ['-e', code, JSON.stringify(entry())], { env: scratch.env(), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (chunk: any) => { err += chunk; });
    proc.on('error', reject);
    proc.on('close', (status: number) => (status === 0 ? resolve(status) : reject(new Error(`child ${tag} exited ${status}: ${err}`))));
  });
  await Promise.all([child('1'), child('2')]);

  const file = path.join(scratch.home, '.doflow', 'state', 'advice', 'results.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.results.length, 2 * perChild, 'every write of both processes landed');
  assert.equal(readResults({ roots: { 'user-state': path.join(scratch.home, '.doflow', 'state') } }).length, 2 * perChild);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['results.json'], 'no lock or temp file is left');
});

test('175 T5 (c): an entry with an unknown field, a bad digest or a non-number figure is dropped on read', (t) => {
  const s = store(t);
  const good = entry();
  plant(s.file, [
    good,
    entry({ modelDigest: hex('1'), standing: 'act' }),
    entry({ modelDigest: hex('2'), caseSet: { ...good.caseSet, ids: ['0123456789abcdef'] } }),
    entry({ modelDigest: hex('3'), metrics: { ...good.metrics, worseIds: ['0123456789abcdef'] } }),
    entry({ modelDigest: hex('4'), metrics: { ...good.metrics, perClass: { yes: { model: { precision: 1, recall: 1 } } } } }),
    entry({ modelDigest: 'md5:0123' }),
    entry({ modelDigest: hex('5'), questionDigest: 'sha256:XYZ' }),
    entry({ modelDigest: hex('6'), metrics: { ...good.metrics, n: '3' } }),
    entry({ modelDigest: hex('7'), metrics: { ...good.metrics, kappa: { ...good.metrics.kappa, lower: 'high' } } }),
    entry({ modelDigest: hex('8'), metrics: { ...good.metrics, minority: null } }),
    entry({ modelDigest: hex('9'), metrics: { ...good.metrics, noAnswer: { count: 0, share: 0, byReason: { [SENTINELS[0]]: 1 } } } }),
    { ...entry({ modelDigest: hex('0') }), runAt: undefined },
    'not an entry',
  ]);
  assert.deepEqual(readResults({ roots: s.roots }), [good]);
});

test('175 T5 (c): two entries for one key are both dropped on read (a writer never makes one)', (t) => {
  const s = store(t);
  plant(s.file, [entry(), entry({ runAt: '2026-11-19T09:00:00.000Z' }), entry({ modelDigest: hex('1') })]);
  assert.deepEqual(readResults({ roots: s.roots }), [entry({ modelDigest: hex('1') })]);
});

test('175 T5 (c): a missing, unparsable or other-schema store reads as no result', (t) => {
  const s = store(t);
  assert.deepEqual(readResults({ roots: s.roots }), []);
  assert.deepEqual(readResults({ roots: { 'user-state': null } }), []);
  assert.equal(resultsFile({ 'user-state': null }), null);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  fs.writeFileSync(s.file, '{ torn');
  assert.deepEqual(readResults({ roots: s.roots }), []);
  plant(s.file, [entry()], 2);
  assert.deepEqual(readResults({ roots: s.roots }), []);
  plant(s.file, [entry()]);
  fs.chmodSync(s.file, 0o000);
  try {
    if (process.getuid?.() !== 0) assert.deepEqual(readResults({ roots: s.roots }), []);
  } finally {
    fs.chmodSync(s.file, 0o600);
  }
});

test('175 T5 O-4: last write wins for one (project key, kind, model digest); two projects for one kind and digest coexist', (t) => {
  const s = store(t);
  writeResult({ roots: s.roots, entry: entry() });
  writeResult({ roots: s.roots, entry: entry({ runAt: '2026-11-19T10:00:00.000Z', doflowVersion: '2.4.1' }) });
  const other = entry({ caseSet: { ...entry().caseSet, projectKey: hex('9') } });
  writeResult({ roots: s.roots, entry: other });
  const results = readResults({ roots: s.roots });
  assert.equal(results.length, 2);
  assert.deepEqual(results.find((r: any) => r.caseSet.projectKey === hex('e')), entry({ runAt: '2026-11-19T10:00:00.000Z', doflowVersion: '2.4.1' }));
  assert.deepEqual(results.find((r: any) => r.caseSet.projectKey === hex('9')), other);
});

test(`175 T5: the store holds at most ${256} entries; the oldest runAt is dropped first`, (t) => {
  const s = store(t);
  assert.equal(MAX_RESULTS, 256);
  const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  const planted = Array.from({ length: MAX_RESULTS }, (_, i) => entry({ modelDigest: `sha256:${i.toString(16).padStart(64, '0')}`, runAt: stamp(i + 1) }));
  plant(s.file, planted.slice().reverse());
  writeResult({ roots: s.roots, entry: entry({ modelDigest: hex('f'), runAt: stamp(10_000) }) });
  const results = readResults({ roots: s.roots });
  assert.equal(results.length, MAX_RESULTS);
  assert.ok(!results.some((r: any) => r.runAt === stamp(1)), 'the oldest entry was dropped');
  assert.ok(results.some((r: any) => r.runAt === stamp(2)) && results.some((r: any) => r.modelDigest === hex('f')));
});

test('175 F-03: an entry another DoFlow version wrote (an extra field) survives a write, is ignored by the read, and the file parses', (t) => {
  const s = store(t);
  const foreign = entry({ modelDigest: hex('1'), futureField: { keep: ['me'] }, metrics: { ...entry().metrics, extraFigure: 7 } });
  const undated = { kind: 'claim-support', somethingNew: true };
  plant(s.file, [foreign, undated, 'not an entry']);
  assert.deepEqual(readResults({ roots: s.roots }), [], 'the read ignores what fails the allowlist');

  const mine = entry({ caseSet: { ...entry().caseSet, projectKey: hex('9') } });
  writeResult({ roots: s.roots, entry: mine });

  const file = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  assert.equal(file.schema, 1);
  assert.deepEqual(file.results.filter((r: any) => r && typeof r === 'object' && ('futureField' in r || 'somethingNew' in r)), [undated, foreign], 'kept exactly as written, the undated one first');
  assert.deepEqual(file.results.filter((r: any) => !('futureField' in r) && !('somethingNew' in r)), [mine]);
  assert.deepEqual(readResults({ roots: s.roots }), [mine], 'still ignored for trust');
  // A write for the foreign entry's own key replaces it: last write wins for one (project, kind, model digest).
  writeResult({ roots: s.roots, entry: entry({ modelDigest: hex('1'), runAt: '2026-11-19T10:00:00.000Z' }) });
  assert.equal(readResults({ roots: s.roots }).length, 2);
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(s.file, 'utf8'))).includes('futureField'));
});

test('175 F-03: kept foreign entries count toward the cap; an entry with no runAt is the first to go and the oldest dated one survives', (t) => {
  const s = store(t);
  const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  const foreign = (i: number) => entry({ modelDigest: `sha256:${i.toString(16).padStart(64, '0')}`, runAt: stamp(i + 1), futureField: i });
  const planted = [{ kind: 'claim-support', undated: true }, ...Array.from({ length: MAX_RESULTS - 1 }, (_, i) => foreign(i))];
  plant(s.file, planted);
  writeResult({ roots: s.roots, entry: entry({ modelDigest: hex('f'), runAt: stamp(10_000) }) });
  const results = JSON.parse(fs.readFileSync(s.file, 'utf8')).results;
  assert.equal(results.length, MAX_RESULTS);
  assert.ok(!results.some((r: any) => r.undated === true), 'the undated entry is pruned first');
  assert.ok(results.some((r: any) => r.futureField === 0), 'the oldest dated entry survives');
  assert.ok(results.some((r: any) => r.modelDigest === hex('f')));
});

test('175 T5: a lock that cannot be taken throws results-locked and writes nothing', (t) => {
  const s = store(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  const release = acquireLock(fs, s.file);
  try {
    assert.throws(() => writeResult({ roots: s.roots, entry: entry(), lock: { retries: 1 } }),
      (error: any) => error.code === 'results-locked' && /results\.json/.test(error.message));
  } finally {
    release();
  }
  assert.equal(fs.existsSync(s.file), false);
});
