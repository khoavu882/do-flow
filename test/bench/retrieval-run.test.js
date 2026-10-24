'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const run = require('../../bench/retrieval/lib/verbs/run.ts');
const verifyVerb = require('../../bench/retrieval/lib/verbs/verify.ts');
const sealLib = require('../../bench/retrieval/lib/seal.ts');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const environment = require('../../bench/retrieval/lib/environment.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const stats = require('../../bench/retrieval/lib/stats.ts');
const { tempDir } = require('../helper/tmp');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const tokenize = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
const PASS = 'a long enough passphrase for tests';
const SRC = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the source`).join('\n') + '\n';
const GMD = '## Alpha\nalpha body\n## Beta\nbeta body\n';

function world(t, { devTaskCount = 12 } = {}) {
  const repo = tempDir(t, 'doflow-run-');
  gitIn(repo, 'init', '-q');
  for (const [f, body] of Object.entries({ 'src/a.ts': SRC, 'core/shared/guidance/g.md': GMD })) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit, seed: 20261012, repoRoot: repo, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const mkTask = (id, corpus, cls, i) => ({
    id, split: 'dev', corpus, class: cls, query: `where is thing number ${i}`,
    qrels: corpus === 'code'
      ? [{ id: 'q1', path: 'src/a.ts', startLine: 2 * (i % 10) + 1, endLine: 2 * (i % 10) + 2, rel: 2 }]
      : [{ id: 'q1', path: 'core/shared/guidance/g.md', startLine: 1, endLine: 2, heading: 'Alpha', rel: 2 }],
    expect: { result: ['RETRIEVED'] }, truthSource: ['x:1'], author: 'worker:t',
  });
  const tasks = [
    ...Array.from({ length: devTaskCount }, (_, i) => mkTask(`DC-${String(i + 1).padStart(3, '0')}`, 'code', 'conceptual-discovery', i)),
    mkTask('DG-001', 'guidance', 'conceptual-discovery', 0),
  ];
  const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: 1, split: 'dev', tasks }, { snapshot, manifest, repoRoot: repo, tokenize });
  for (const task of taskFile.tasks) task.queryOverlap = 0.1;
  fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tasks', 'dev.json'), sealLib.toFileText(taskFile));
  return { repo, outDir, snapshot, manifest, snapshotPath: path.join(outDir, 'snapshot.json'), tmp: path.join(tempDir(t, 'doflow-run-tmp-'), 'work') };
}

/** Stub adapters: A hits every qrel at rank 1; B hits only the even-numbered tasks. */
function stubDeps(calls, over = {}) {
  return {
    runConfig: ({ config, corpus, task }) => {
      calls.push(`${config}:${corpus}:${task.id}`);
      const q = task.qrels[0];
      const hit = config === 'A' || Number(task.id.slice(-3)) % 2 === 0;
      const candidate = corpus === 'code'
        ? { path: hit ? q.path : 'src/other.ts', startLine: q.startLine, endLine: q.endLine, heading: null, rank: 1, provider: 'p', snippet: 'abcd', snippetBytes: 4 }
        : { path: q.path, startLine: null, endLine: null, heading: hit ? 'Alpha' : 'Beta', rank: 1, provider: 'guidance.bm25', snippet: 'abcd', snippetBytes: 4 };
      return { result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', candidates: [candidate], providers: [{ id: config === 'A' ? 'semble.search' : 'native.rg', state: 'reached' }], payloadBytes: 4, wallMs: 1 };
    },
    buildIndexes: () => ({ buildMs: 5, incrementalMs: 1, diskBytes: 10, peakRssMB: { unmeasured: 'no /usr/bin/time' } }),
    materialiseExport: environment.materialiseExport,
    verifySnapshot: verifyVerb.verifySnapshot,
    preconditions: () => ({ check: () => ({ ok: true }) }),
    latency: { warmups: run.WARMUPS, runs: run.RUNS },
    ...over,
  };
}

const exec = (w, args, deps, extra = {}) => run.execute({ args, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: { DOFLOW_HOLDOUT_KEY: PASS }, home: w.repo, deps, ...extra });

test('flag parsing refuses a bad configuration, corpus, split or class', () => {
  assert.deepEqual(run.parseSelection({}), { configs: ['A', 'B'], corpora: ['code', 'guidance'], split: 'dev', cls: undefined });
  assert.deepEqual(run.parseSelection({ config: 'B', corpus: 'code', split: 'holdout', class: 'dirty-tree' }), { configs: ['B'], corpora: ['code'], split: 'holdout', cls: 'dirty-tree' });
  for (const bad of [{ config: 'C' }, { config: 'A,A' }, { corpus: 'docs' }, { split: 'test' }, { class: 'nope' }]) assert.throws(() => run.parseSelection(bad), /must be/);
});

test('dev run: IC-015 shape without capture, per-corpus results, A better than B, guidance A is B', (t) => {
  const w = world(t);
  const calls = [];
  const out = exec(w, { config: 'A,B', corpus: 'all', split: 'dev' }, stubDeps(calls));
  assert.equal(out.exitCode, 0);
  const rep = out.report;
  assert.deepEqual(Object.keys(rep), ['schemaVersion', 'snapshotId', 'commit', 'split', 'tasksSha256', 'corpora', 'perTask']);
  assert.ok(!('capture' in rep));
  assert.equal(rep.tasksSha256, sealLib.sha256Hex(fs.readFileSync(path.join(w.outDir, 'tasks', 'dev.json'))));

  const code = rep.corpora.code;
  const a = code.configs.A.classes['conceptual-discovery'];
  const b = code.configs.B.classes['conceptual-discovery'];
  assert.equal(a.n, 12);
  assert.equal(a.underpowered, false);
  assert.equal(a.metrics.recallAt10.value, 1);
  assert.equal(b.metrics.recallAt10.value, 0.5);
  assert.deepEqual(a.latency.runs, 30);
  assert.ok(code.configs.A.index && code.configs.A.index.buildMs === 5, 'config A carries the index build block');
  assert.equal(code.configs.B.index, undefined);
  assert.equal(code.configs.A.classes['stale-index'].n, 0);
  const cmp = code.comparisons.find((c) => c.metric === 'recallAt10' && c.class === 'conceptual-discovery');
  assert.equal(cmp.n, 12);
  assert.equal(cmp.diff, 0.5);
  assert.deepEqual(Object.keys(cmp), ['metric', 'class', 'a', 'b', 'n', 'diff', 'ci95', 'pRandomization']);
  assert.deepEqual(code.configs.A.components.map((c) => c.id), ['semble.search']);

  const guidance = rep.corpora.guidance;
  assert.equal(guidance.configs.A.sameAs, 'B');
  assert.equal(guidance.configs.A.classes['impact-refactor'].applicable, false);
  assert.ok(!calls.some((c) => c.startsWith('A:guidance')), 'guidance A is never computed separately');
  assert.equal(rep.perTask.length, 12 * 2 + 2);
  assert.deepEqual(Object.keys(rep.perTask[0]), ['id', 'corpus', 'config', 'result', 'freshness', 'metrics']);
  assert.ok(out.lines.some((l) => /code A conceptual-discovery: n=12/.test(l)));
});

test('latency: 3 warm-ups then 30 runs per configuration, interleaved in a seeded order', () => {
  const log = [];
  const tasks = [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }];
  const go = () => {
    log.length = 0;
    const samples = run.measureLatency({
      tasks, configs: ['A', 'B'], seed: 20261012, corpus: 'code', cls: 'exact-lookup', warmups: 3, runs: 30,
      call: (config, task) => { log.push(`${config}${task.id}`); return { wallMs: log.length }; },
    });
    return { samples, order: log.slice() };
  };
  const one = go();
  assert.equal(one.samples.A.length, 30);
  assert.equal(one.samples.B.length, 30);
  assert.equal(one.order.length, 2 * 3 + 2 * 30);
  const measured = one.order.slice(6);
  assert.ok(measured.slice(0, 2).every((x) => x.endsWith('T1')), 'round 1 draws task 1 for both configurations');
  assert.ok(measured.slice(2, 4).every((x) => x.endsWith('T2')), 'tasks are drawn cyclically');
  assert.deepEqual(go().order, one.order, 'same seed, same interleaving');
  assert.ok(new Set(Array.from({ length: 30 }, (_, r) => measured[2 * r][0])).size === 2, 'the first configuration of a round varies');
  assert.deepEqual(one.order.slice(0, 6).map((x) => x.slice(1)), ['T1', 'T1', 'T2', 'T2', 'T3', 'T3'], 'warm-ups also cycle');
  assert.ok(stats.mulberry32);
});

test('--class, --corpus and a single configuration narrow the run', (t) => {
  const w = world(t, { devTaskCount: 3 });
  const calls = [];
  const out = exec(w, { config: 'B', corpus: 'code', split: 'dev', class: 'conceptual-discovery' }, stubDeps(calls, { latency: { warmups: 0, runs: 0 } }));
  assert.equal(out.exitCode, 0);
  assert.deepEqual(Object.keys(out.report.corpora), ['code']);
  assert.deepEqual(Object.keys(out.report.corpora.code.configs), ['B']);
  assert.deepEqual(out.report.corpora.code.comparisons, []);
  assert.ok(calls.every((c) => c.startsWith('B:code')));
  assert.equal(out.report.perTask.length, 3);
});

test('--out writes the dev object to a file', (t) => {
  const w = world(t, { devTaskCount: 3 });
  const file = path.join(tempDir(t, 'doflow-run-out-'), 'run.json');
  const out = exec(w, { corpus: 'code', out: file }, stubDeps([], { latency: { warmups: 0, runs: 0 } }));
  assert.equal(out.exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(out.report)));
});

test('drift aborts before any work: manifest drift exits 3, tool drift exits 4', (t) => {
  const w = world(t);
  const calls = [];
  const m = JSON.parse(fs.readFileSync(path.join(w.outDir, 'manifest.json'), 'utf8'));
  m.entries[0].blob = '0'.repeat(40);
  fs.writeFileSync(path.join(w.outDir, 'manifest.json'), JSON.stringify(m));
  const out = exec(w, {}, stubDeps(calls));
  assert.equal(out.exitCode, 3);
  assert.deepEqual(calls, []);
  const w2 = world(t);
  const s = JSON.parse(fs.readFileSync(w2.snapshotPath, 'utf8'));
  s.tools = [{ id: 'git', versionCommand: [process.execPath, '--version'], versionLine: 'v0.0.0', state: 'present' }];
  fs.writeFileSync(w2.snapshotPath, JSON.stringify(s));
  assert.equal(exec(w2, {}, stubDeps(calls)).exitCode, 4);
  assert.deepEqual(calls, []);
});

test('dev task findings exit 1 and run no adapter', (t) => {
  const w = world(t, { devTaskCount: 2 });
  const file = path.join(w.outDir, 'tasks', 'dev.json');
  const dev = JSON.parse(fs.readFileSync(file, 'utf8'));
  dev.tasks[0].qrels[0].anchorSha = 'f'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(dev));
  const calls = [];
  const out = exec(w, {}, stubDeps(calls));
  assert.equal(out.exitCode, 1);
  assert.ok(out.lines.some((l) => /E_QREL_ANCHOR DC-001/.test(l)));
  assert.deepEqual(calls, []);
});

function sealHoldout(w, count = 3) {
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `HC-${String(i + 1).padStart(3, '0')}`, split: 'holdout', corpus: 'code', class: 'conceptual-discovery', query: `SECRET QUERY ${i}`,
    qrels: [{ id: 'q1', path: 'src/a.ts', startLine: 3 + i, endLine: 4 + i, rel: 2 }],
    expect: { result: ['RETRIEVED'] }, truthSource: ['x:1'], author: 'worker:h',
  }));
  const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: 1, split: 'holdout', tasks }, { snapshot: w.snapshot, manifest: w.manifest, repoRoot: w.repo, tokenize });
  for (const task of taskFile.tasks) task.queryOverlap = 0.1;
  const sealed = sealLib.sealTasks({ taskFile, passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1, sealedBy: 'worker:h', classes: ['conceptual-discovery'] });
  sealLib.writeSealed({ dir: path.join(w.outDir, 'holdout'), corpus: 'code', generation: 1, envelopeText: sealed.envelopeText, sealText: sealed.sealText });
  return sealed;
}

test('holdout: a failed precondition exits 2 before any decryption or adapter call', (t) => {
  const w = world(t);
  sealHoldout(w);
  const calls = [];
  const out = exec(w, { config: 'A,B', corpus: 'code', split: 'holdout' }, stubDeps(calls, {
    preconditions: () => ({ check: () => ({ ok: false, exitCode: 2, precondition: 'b', message: 'T-002 is proposed' }) }),
  }));
  assert.equal(out.exitCode, 2);
  assert.match(out.lines[0], /precondition \(b\) failed: T-002 is proposed/);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(w.outDir, 'results')), false);
});

test('holdout: results are aggregates only, written to results files, never to --out', (t) => {
  const w = world(t);
  const sealed = sealHoldout(w);
  const seen = [];
  const calls = [];
  const out = exec(w, { config: 'A,B', corpus: 'code', split: 'holdout' }, stubDeps(calls, {
    preconditions: () => ({ check: (ctx) => { seen.push(Object.keys(ctx).sort()); return { ok: true }; } }),
  }), { now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(seen, [['args', 'env', 'home', 'repoRoot', 'sealMeta', 'snapshot', 'thresholds']]);
  assert.deepEqual(out.results.sort(), [
    'bench/retrieval/results/holdout-1-g1-code-A-vs-B.json', 'bench/retrieval/results/holdout-1-g1-code-A.json', 'bench/retrieval/results/holdout-1-g1-code-B.json',
  ]);
  const dir = path.join(w.outDir, 'results');
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'holdout-1-g1-code-A.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'holdout-1-g1-code-B.json'), 'utf8'));
  assert.deepEqual(Object.keys(a), ['schemaVersion', 'snapshotId', 'generation', 'corpus', 'config', 'sealPlaintextSha256', 'thresholdsCommit', 'runAt', 'runIndex', 'machineId', 'classes']);
  assert.equal(a.sealPlaintextSha256, sealed.seal.plaintextSha256);
  assert.deepEqual([a.runIndex, b.runIndex], [1, 2]);
  assert.equal(a.classes['conceptual-discovery'].n, 3);
  const everything = [...fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), ...out.lines, JSON.stringify(out.aggregates)].join('\n');
  assert.ok(!/HC-\d{3}|SECRET QUERY|perTask|qrels/.test(everything), 'no task id, query or per-task value anywhere');
  assert.throws(() => exec(w, { config: 'A,B', corpus: 'code', split: 'holdout', out: '/tmp/x.json' }, stubDeps([])), /--out is not accepted/);
  assert.ok(!('report' in out), 'no dev report for a holdout run');
});

test('holdout: a missing seal or a key that does not decrypt is refused', (t) => {
  const w = world(t);
  assert.throws(() => exec(w, { config: 'A,B', corpus: 'code', split: 'holdout' }, stubDeps([])), /no sealed holdout for the code corpus/);
  sealHoldout(w);
  assert.throws(() => run.execute({ args: { config: 'A,B', corpus: 'code', split: 'holdout' }, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: { DOFLOW_HOLDOUT_KEY: 'x'.repeat(30) }, home: w.repo, deps: stubDeps([]) }), /does not decrypt/);
});

test('FX.4: with --split holdout, --config and --corpus must be given explicitly', () => {
  assert.throws(() => run.parseSelection({ split: 'holdout', corpus: 'code' }), (err) => {
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /--config/);
    return true;
  });
  assert.throws(() => run.parseSelection({ split: 'holdout', config: 'A,B' }), (err) => {
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /--corpus/);
    return true;
  });
});

test('FX.2: unreachedCount reports count of unreached tasks and comparisons include headline metrics', (t) => {
  const w = world(t, { devTaskCount: 5 });
  const devPath = path.join(w.outDir, 'tasks', 'dev.json');
  const devData = JSON.parse(fs.readFileSync(devPath, 'utf8'));
  devData.tasks.push({
    id: 'DC-099', split: 'dev', corpus: 'code', class: 'impact-refactor', query: 'what depends on thing',
    literal: 'thing',
    qrels: [{ id: 'q1', path: 'src/a.ts', startLine: 1, endLine: 2, rel: 2, anchorSha: 'placeholder' }],
    dependencies: [{ id: 'q2', path: 'src/a.ts', startLine: 5, endLine: 6, rel: 2, anchorSha: 'placeholder' }],
    expect: { result: ['RETRIEVED'] }, truthSource: ['src/a.ts:1'], author: 'worker:t', queryOverlap: 0.1,
  });
  const { taskFile } = tasksLib.fillTaskFile(devData, { snapshot: w.snapshot, manifest: w.manifest, repoRoot: w.repo, tokenize });
  fs.writeFileSync(devPath, sealLib.toFileText(taskFile));

  const calls = [];
  const deps = {
    runConfig: ({ config, corpus, task }) => {
      calls.push(`${config}:${corpus}:${task.id}`);
      if (task.class === 'conceptual-discovery' && (task.id === 'DC-001' || task.id === 'DC-002') && config === 'A') {
        return {
          result: 'UNREACHED', freshness: 'UNKNOWN', candidates: [],
          providers: [{ id: 'semble.search', state: 'unreached', cause: 'process timed out' }],
          payloadBytes: 0, wallMs: 1,
        };
      }
      if (task.class === 'impact-refactor') {
        const dep = task.dependencies[0];
        const hit = config === 'A';
        const candidate = {
          path: hit ? dep.path : 'src/other.ts',
          startLine: dep.startLine, endLine: dep.endLine, heading: null, rank: 1,
          provider: 'graphify.query', snippet: 'abcd', snippetBytes: 4,
        };
        return {
          result: 'RETRIEVED', freshness: 'UNKNOWN',
          candidates: [candidate],
          providers: [{ id: 'graphify.query', state: 'reached' }],
          payloadBytes: 4, wallMs: 1,
        };
      }
      const q = task.qrels[0];
      return {
        result: 'RETRIEVED', freshness: 'NOT_APPLICABLE',
        candidates: [{ path: q.path, startLine: q.startLine, endLine: q.endLine, heading: null, rank: 1, provider: 'native.rg', snippet: 'abcd', snippetBytes: 4 }],
        providers: [{ id: 'native.rg', state: 'reached' }],
        payloadBytes: 4, wallMs: 1,
      };
    },
    buildIndexes: () => ({ buildMs: 5, incrementalMs: 1, diskBytes: 10, peakRssMB: { unmeasured: 'no /usr/bin/time' } }),
    materialiseExport: environment.materialiseExport,
    verifySnapshot: verifyVerb.verifySnapshot,
    preconditions: () => ({ check: () => ({ ok: true }) }),
    latency: { warmups: 0, runs: 0 },
  };

  const out = exec(w, { config: 'A,B', corpus: 'code', split: 'dev' }, deps);
  assert.equal(out.exitCode, 0);

  const code = out.report.corpora.code;
  const aConceptual = code.configs.A.classes['conceptual-discovery'];
  assert.equal(aConceptual.unreachedCount, 2, 'a class with 2 unreached tasks reports unreachedCount 2');

  const cmpConceptual = code.comparisons.find((c) => c.metric === 'fileRecallAt10' && c.class === 'conceptual-discovery');
  assert.ok(cmpConceptual, 'comparison for conceptual fileRecallAt10 must exist');
  assert.ok(Array.isArray(cmpConceptual.ci95), 'comparison for conceptual fileRecallAt10 must have ci95');

  const cmpImpact = code.comparisons.find((c) => c.metric === 'missedDependencies' && c.class === 'impact-refactor');
  assert.ok(cmpImpact, 'comparison for impact missedDependencies must exist');
  assert.ok(Array.isArray(cmpImpact.ci95), 'comparison for impact missedDependencies must have ci95');
});
