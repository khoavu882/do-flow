'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const capture = require('../../bench/retrieval/lib/verbs/capture.ts');
const runVerb = require('../../bench/retrieval/lib/verbs/run.ts');
const verifyVerb = require('../../bench/retrieval/lib/verbs/verify.ts');
const environment = require('../../bench/retrieval/lib/environment.ts');
const sealLib = require('../../bench/retrieval/lib/seal.ts');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const runner = require('../../bench/retrieval/runner.ts');
const { tempDir } = require('../helper/tmp.ts');

const gitIn = (dir: any, ...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const tokenize = (text: any) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
const SRC = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function world(t: any, { commitDev = true }: any = {}) {
  const repo = tempDir(t, 'doflow-capture-');
  gitIn(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.ts'), SRC);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit, seed: 7, repoRoot: repo, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const task: any = {
    id: 'DC-001', split: 'dev', corpus: 'code', class: 'conceptual-discovery', query: 'where is it',
    qrels: [{ id: 'q1', path: 'src/a.ts', startLine: 1, endLine: 2, rel: 2 }], expect: { result: ['RETRIEVED'] }, truthSource: ['x:1'], author: 'w',
  };
  const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: 1, split: 'dev', tasks: [task] }, { snapshot, manifest, repoRoot: repo, tokenize });
  taskFile.tasks[0].queryOverlap = 0.1;
  fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tasks/dev.json'), sealLib.toFileText(taskFile));
  snap.refreshTaskSha({ repoRoot: repo, snapshotFile: path.join(outDir, 'snapshot.json') });
  if (commitDev) { gitIn(repo, 'add', '-A'); gitIn(repo, 'commit', '-q', '-m', 'bench data'); }
  return { repo, outDir, snapshotPath: path.join(outDir, 'snapshot.json'), tmp: path.join(tempDir(t, 'doflow-capture-tmp-'), 'work') };
}

function deps(calls: any = []) {
  return {
    runConfig: ({ config, corpus, task }: any) => {
      calls.push(`${config}:${corpus}:${task.id}`);
      const q = task.qrels[0];
      return {
        result: 'RETRIEVED', freshness: 'NOT_APPLICABLE', payloadBytes: 4, wallMs: 1, providers: [{ id: 'native.rg', state: 'reached' }],
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

const go = (w: any, args: any, d: any) => capture.capture({ args, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: {}, home: w.repo, deps: d, now: new Date('2026-10-12T00:00:00Z') });

test('capture runs the dev split for A and B on both corpora and writes baseline.json with a capture block', (t) => {
  const w = world(t);
  const calls: any[] = [];
  const out: any = go(w, {}, deps(calls));
  assert.deepEqual(out, { path: 'bench/retrieval/baseline.json', classes: 13 });
  assert.ok(calls.some((c) => c.startsWith('A:code')) && calls.some((c) => c.startsWith('B:code')));
  const base = JSON.parse(fs.readFileSync(path.join(w.outDir, 'baseline.json'), 'utf8'));
  assert.deepEqual(Object.keys(base), ['schemaVersion', 'snapshotId', 'commit', 'split', 'tasksSha256', 'capture', 'corpora', 'perTask']);
  assert.deepEqual(Object.keys(base.capture), ['capturedAt', 'machineId', 'runnerBlob', 'seed', 'node', 'os', 'arch']);
  assert.equal(base.capture.capturedAt, '2026-10-12T00:00:00.000Z');
  assert.equal(base.capture.seed, 7);
  assert.match(base.capture.machineId, /^[0-9a-f]{12}$/);
  assert.match(base.capture.runnerBlob, /^[0-9a-f]{40}$/);
  assert.equal(base.capture.runnerBlob, capture.runnerBlob());
  assert.equal(base.corpora.code.configs.A.classes['conceptual-discovery'].n, 1);
  assert.equal(base.perTask.length, 2);
  assert.equal(base.tasksSha256, sealLib.sha256Hex(fs.readFileSync(path.join(w.outDir, 'tasks/dev.json'))));
});

test('capture refuses an uncommitted, modified or missing dev task file (exit 2)', (t) => {
  const untracked = world(t, { commitDev: false });
  assert.throws(() => go(untracked, {}, deps()), (e: any) => e.exitCode === 2 && /not committed/.test(e.message));
  const dirty = world(t);
  fs.appendFileSync(path.join(dirty.outDir, 'tasks/dev.json'), ' ');
  assert.throws(() => go(dirty, {}, deps()), /not committed/);
  const missing = world(t);
  gitIn(missing.repo, 'rm', '-q', '-f', 'bench/retrieval/tasks/dev.json');
  assert.throws(() => go(missing, {}, deps()), /missing or not committed/);
  assert.equal(fs.existsSync(path.join(dirty.outDir, 'baseline.json')), false);
});

test('capture refuses when verify fails, with exit 2 whatever the drift code', (t) => {
  const w = world(t);
  const m = JSON.parse(fs.readFileSync(path.join(w.outDir, 'manifest.json'), 'utf8'));
  m.entries[0].blob = '0'.repeat(40);
  fs.writeFileSync(path.join(w.outDir, 'manifest.json'), JSON.stringify(m));
  gitIn(w.repo, 'add', '-A');
  gitIn(w.repo, 'commit', '-q', '-m', 'drift');
  const calls: any[] = [];
  assert.throws(() => go(w, {}, deps(calls)), (e: any) => e.exitCode === 2 && /verify failed \(exit 3\)/.test(e.message));
  assert.deepEqual(calls, []);
});

test('--from reuses a saved dev run after checking snapshotId and tasksSha256', (t) => {
  const w = world(t);
  const saved = path.join(tempDir(t, 'doflow-capture-saved-'), 'run.json');
  const calls: any[] = [];
  const out: any = runVerb.execute({ args: { config: 'A,B', corpus: 'all', split: 'dev', out: saved }, snapshotPath: w.snapshotPath, repoRoot: w.repo, tmp: w.tmp, env: {}, home: w.repo, deps: deps(calls) });
  assert.equal(out.exitCode, 0);
  const before = calls.length;
  const res: any = go(w, { from: saved }, deps(calls));
  assert.equal(res.classes, 13);
  assert.equal(calls.length, before, '--from runs no adapter');
  const stale = JSON.parse(fs.readFileSync(saved, 'utf8'));
  stale.tasksSha256 = '0'.repeat(64);
  fs.writeFileSync(saved, JSON.stringify(stale));
  assert.throws(() => go(w, { from: saved }, deps()), /different dev tasks/);
  stale.tasksSha256 = out.report.tasksSha256;
  stale.snapshotId = 9;
  fs.writeFileSync(saved, JSON.stringify(stale));
  assert.throws(() => go(w, { from: saved }, deps()), /snapshot 9/);
});

test('through the runner the verb is discovered and refusals exit 2', (t) => {
  const w = world(t, { commitDev: false });
  const err: any = [];
  assert.equal(runner.main(['capture', '--snapshot', w.snapshotPath], { repoRoot: w.repo, out: () => {}, err: (m: any) => err.push(m) }), 2);
  assert.match(err.join('\n'), /not committed/);
});
