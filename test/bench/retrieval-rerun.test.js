'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const rerun = require('../../bench/retrieval/lib/verbs/rerun.ts');
const capture = require('../../bench/retrieval/lib/verbs/capture.ts');
const verifyVerb = require('../../bench/retrieval/lib/verbs/verify.ts');
const environment = require('../../bench/retrieval/lib/environment.ts');
const sealLib = require('../../bench/retrieval/lib/seal.ts');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const runner = require('../../bench/retrieval/runner.ts');
const { tempDir } = require('../helper/tmp');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const tokenize = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
const NODE_TOOL = { id: 'git', versionCommand: [process.execPath, '--version'], versionLine: process.version, state: 'present' };
const SRC = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function world(t) {
  const repo = tempDir(t, 'doflow-rerun-');
  gitIn(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.ts'), SRC);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit, seed: 7, repoRoot: repo, outDir, tools: [NODE_TOOL], env: { node: process.version, os: process.platform, arch: process.arch } });
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const task = {
    id: 'DC-001', split: 'dev', corpus: 'code', class: 'conceptual-discovery', query: 'where is it',
    qrels: [{ id: 'q1', path: 'src/a.ts', startLine: 1, endLine: 2, rel: 2 }], expect: { result: ['RETRIEVED'] }, truthSource: ['x:1'], author: 'w',
  };
  const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: 1, split: 'dev', tasks: [task] }, { snapshot, manifest, repoRoot: repo, tokenize });
  taskFile.tasks[0].queryOverlap = 0.1;
  fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tasks/dev.json'), sealLib.toFileText(taskFile));
  snap.refreshTaskSha({ repoRoot: repo, snapshotFile: path.join(outDir, 'snapshot.json') });
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'bench data');
  return { repo, outDir, snapshotPath: path.join(outDir, 'snapshot.json'), tmp: path.join(tempDir(t, 'doflow-rerun-tmp-'), 'work') };
}

function deps({ wallMs = 1, unreachedA = false } = {}) {
  return {
    runConfig: ({ config, task }) => {
      const q = task.qrels[0];
      if (config === 'A' && unreachedA) {
        return { result: 'UNREACHED', freshness: 'UNKNOWN', candidates: [], providers: [{ id: 'semble.search', state: 'unreached', cause: 'binary absent' }], payloadBytes: 0, wallMs };
      }
      return {
        result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', payloadBytes: 4, wallMs, providers: [{ id: 'native.rg', state: 'reached' }],
        candidates: [{ path: q.path, startLine: q.startLine, endLine: q.endLine, heading: null, rank: 1, provider: 'p', snippet: 'abcd', snippetBytes: 4 }],
      };
    },
    buildIndexes: () => ({ buildMs: 1, incrementalMs: 1, diskBytes: 1, peakRssMB: { unmeasured: 'x' } }),
    materialiseExport: environment.materialiseExport,
    verifySnapshot: verifyVerb.verifySnapshot,
    preconditions: () => ({ check: () => ({ ok: true }) }),
    latency: { warmups: 1, runs: 2 },
  };
}

function captured(t, d = deps()) {
  const w = world(t);
  capture.capture({ args: {}, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: {}, home: w.repo, deps: d });
  return w;
}

const baselineOf = (w) => path.join(w.outDir, 'baseline.json');
const editBaseline = (w, fn) => { const b = JSON.parse(fs.readFileSync(baselineOf(w), 'utf8')); fn(b); fs.writeFileSync(baselineOf(w), JSON.stringify(b, null, 2)); };
const go = (w, d = deps(), extra = {}) => rerun.rerun({ snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: {}, home: w.repo, deps: d, ...extra });

test('an unchanged rerun matches the baseline exactly', (t) => {
  const w = captured(t);
  const out = go(w);
  assert.equal(out.exitCode, 0);
  assert.ok(out.diffs.length > 10);
  assert.ok(out.diffs.every((d) => d.ok));
  assert.deepEqual(Object.keys(out.diffs[0]), ['corpus', 'config', 'class', 'metric', 'baseline', 'current', 'tolerance', 'ok']);
  assert.equal(out.latency.compared, true);
  assert.equal(out.verify.manifest.ok, true);
});

test('a perturbed baseline value fails on exact match and passes inside a rerun tolerance', (t) => {
  const w = captured(t);
  editBaseline(w, (b) => { b.corpora.code.configs.A.classes['conceptual-discovery'].metrics.recallAt10.value = 0.99; });
  const out = go(w);
  assert.equal(out.exitCode, 1);
  const bad = out.diffs.filter((d) => !d.ok);
  assert.deepEqual(bad.map((d) => [d.corpus, d.config, d.class, d.metric, d.baseline, d.current]), [['code', 'A', 'conceptual-discovery', 'recallAt10', 0.99, 1]]);

  fs.writeFileSync(path.join(w.outDir, 'thresholds.json'), JSON.stringify({ rerun: { tolerances: [{ config: 'A', metric: 'recallAt10', abs: 0.02 }, { config: 'B', metric: 'recallAt10', abs: 0 }] } }));
  const within = go(w);
  assert.equal(within.exitCode, 0);
  assert.equal(within.diffs.find((d) => d.config === 'A' && d.metric === 'recallAt10').tolerance, 0.02);
  editBaseline(w, (b) => { b.corpora.code.configs.A.classes['conceptual-discovery'].metrics.recallAt10.value = 0.9; });
  assert.equal(go(w).exitCode, 1, 'outside the tolerance');
});

test('a changed tool version exits 4 before any adapter runs', (t) => {
  const w = captured(t);
  const s = JSON.parse(fs.readFileSync(w.snapshotPath, 'utf8'));
  s.tools[0].versionLine = 'v0.0.0';
  fs.writeFileSync(w.snapshotPath, JSON.stringify(s));
  const calls = [];
  const d = deps();
  const inner = d.runConfig;
  d.runConfig = (x) => { calls.push(x.task.id); return inner(x); };
  const out = go(w, d);
  assert.equal(out.exitCode, 4);
  assert.deepEqual(calls, []);
  assert.match(out.message, /tool git/);
});

test('unreached rows match only unreached with the same cause', (t) => {
  const w = captured(t, deps({ unreachedA: true }));
  assert.equal(go(w, deps({ unreachedA: true })).exitCode, 0, 'same state and cause');
  const recovered = go(w, deps());
  assert.equal(recovered.exitCode, 1);
  const bad = recovered.diffs.filter((d) => !d.ok);
  assert.deepEqual(bad.map((d) => [d.config, d.class, d.metric]), [['A', 'conceptual-discovery', 'state']]);
  assert.match(bad[0].note, /baseline unreached \(binary absent\), current measured/);
  editBaseline(w, (b) => { b.corpora.code.configs.A.classes['conceptual-discovery'].cause = 'timed out'; });
  assert.equal(go(w, deps({ unreachedA: true })).exitCode, 1, 'a different cause is a different row');
});

test('latency is compared only on the baseline machine, and only gates with a tolerance entry', (t) => {
  const w = captured(t);
  const other = go(w, deps({ wallMs: 500 }), { machine: 'someone-else' });
  assert.equal(other.latency.compared, false);
  assert.match(other.latency.reason, /machineId differs/);
  assert.equal(other.exitCode, 0, 'a different machine is not a failure');
  const same = go(w, deps({ wallMs: 500 }));
  assert.equal(same.latency.compared, true);
  assert.equal(same.exitCode, 0, 'no latency tolerance entry, so it is informational');
  assert.ok(same.latency.diffs.some((d) => d.metric === 'p50Ms' && d.baseline === 1 && d.current === 500 && d.ok && d.note === 'not gated (no tolerance)'));
  assert.ok(same.latency.diffs.every((d) => d.tolerance === null ? d.note === 'not gated (no tolerance)' : true));
  const runRes = rerun.run({ snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, deps: deps({ wallMs: 500 }) });
  assert.ok(runRes.lines.includes('latency not gated: thresholds.json has no latency tolerances'));
  fs.writeFileSync(path.join(w.outDir, 'thresholds.json'), JSON.stringify({ rerun: { tolerances: [{ config: 'B', metric: 'p95Ms', abs: 10 }] } }));
  const gated = go(w, deps({ wallMs: 500 }));
  assert.equal(gated.exitCode, 1);
  assert.ok(gated.latency.diffs.some((d) => !d.ok && d.metric === 'p95Ms' && d.config === 'B'));
});

test('a missing baseline or a baseline for other tasks is refused with exit 2', (t) => {
  const w = world(t);
  assert.throws(() => go(w), (e) => e.exitCode === 2 && /run capture first/.test(e.message));
  capture.capture({ args: {}, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: {}, home: w.repo, deps: deps() });
  editBaseline(w, (b) => { b.tasksSha256 = '0'.repeat(64); });
  assert.throws(() => go(w), /different snapshot or dev task file/);
});

test('through the runner the verb is discovered and a missing baseline exits 2 without running anything', (t) => {
  const w = world(t);
  const err = [];
  const lines = [];
  const code = runner.main(['rerun', '--json', '--snapshot', w.snapshotPath], { repoRoot: w.repo, out: (m) => lines.push(m), err: (m) => err.push(m) });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /run capture first/);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).slice(0, 4), ['verb', 'ok', 'exitCode', 'snapshotId']);
});

test('human-readable rerun output reports aggregates within tolerance summary', (t) => {
  const w = captured(t);
  const runRes = rerun.run({ snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, deps: deps() });
  assert.equal(runRes.exitCode, 0);
  assert.ok(runRes.lines.some((l) => /^\d+ of \d+ aggregates within tolerance$/.test(l)));
});

