'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sealVerb = require('../../bench/retrieval/lib/verbs/seal.ts');
const sealLib = require('../../bench/retrieval/lib/seal.ts');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const runner = require('../../bench/retrieval/runner.ts');
const { tempDir } = require('../helper/tmp');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const PASS = 'a long enough passphrase for tests';
const tokenize = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
const GUIDANCE_CLASSES = ['exact-lookup', 'conceptual-discovery', 'stale-index', 'dirty-tree', 'oversized-context'];

function world(t, { dev } = {}) {
  const repo = tempDir(t, 'doflow-sealverb-');
  gitIn(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'core/shared/guidance'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'core/shared/guidance/g.md'), '## Alpha\nalpha body line\n## Beta\nbeta body line\n');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.ts'), 'x\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit, seed: 1, repoRoot: repo, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  if (dev) {
    fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'tasks/dev.json'), JSON.stringify({ tasks: dev.map((id) => ({ id })) }));
  }
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const keyDir = tempDir(t, 'doflow-sealverb-key-');
  const keyFile = path.join(keyDir, 'holdout.key');
  fs.writeFileSync(keyFile, `${PASS}\n`);
  fs.chmodSync(keyFile, 0o600);
  return { repo, outDir, snapshotPath: path.join(outDir, 'snapshot.json'), snapshot, manifest, keyFile, plainDir: tempDir(t, 'doflow-sealverb-plain-') };
}

function guidanceFile(w, { classes = GUIDANCE_CLASSES, author = 'worker:holdout-1' } = {}) {
  const tasks = classes.map((cls, i) => ({
    id: `HG-${String(i + 1).padStart(3, '0')}`, split: 'holdout', corpus: 'guidance', class: cls, query: `question number ${i} about alpha`,
    ...(cls === 'exact-lookup' ? { literal: 'alpha' } : {}),
    qrels: [{ id: 'q1', path: 'core/shared/guidance/g.md', startLine: 1, endLine: 2, heading: 'Alpha', rel: 2 }],
    expect: { result: ['RETRIEVED'], ...(cls === 'oversized-context' ? { budgetBytes: 100, mustInclude: ['q1'] } : {}) },
    ...(cls === 'stale-index' || cls === 'dirty-tree' ? { setup: { patchText: 'diff --git a/x b/x\n' } } : {}),
    truthSource: ['core/shared/guidance/g.md:1'], author,
  }));
  const { taskFile } = tasksLib.fillTaskFile({ schemaVersion: 1, snapshotId: 1, split: 'holdout', tasks }, { snapshot: w.snapshot, manifest: w.manifest, repoRoot: w.repo, tokenize });
  for (const task of taskFile.tasks) if (task.class === 'conceptual-discovery') task.queryOverlap = 0.1;
  const file = path.join(w.plainDir, 'holdout.json');
  fs.writeFileSync(file, JSON.stringify(taskFile));
  return file;
}

const seal = (w, inFile, extra = {}) => sealVerb.sealCorpus({
  corpus: 'guidance', inFile, keyFile: w.keyFile, snapshotPath: w.snapshotPath, repoRoot: w.repo, env: {}, home: w.plainDir, ...extra,
});

test('a valid holdout is sealed as generation 1, then 2, with counts and no task text', (t) => {
  const w = world(t);
  const file = guidanceFile(w);
  const out = seal(w, file, { now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(out.exitCode, 0);
  assert.equal(out.generation, 1);
  assert.equal(out.taskCount, 5);
  assert.deepEqual(out.classCounts['exact-lookup'], 1);
  assert.equal(out.classCounts['impact-refactor'], 0, 'n/a classes carry 0');
  assert.match(out.plaintextSha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(out).includes('question number'), 'no task text in the output');

  const dir = path.join(w.outDir, 'holdout');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['guidance.g1.seal.json', 'guidance.g1.sealed.json']);
  const digest = sealLib.readSeal(dir, 'guidance', 1);
  assert.equal(digest.sealedBy, 'worker:holdout-1');
  assert.equal(digest.plaintextSha256, out.plaintextSha256);
  assert.equal(sealLib.decrypt(sealLib.readEnvelope(dir, 'guidance', 1), PASS).taskFile.canary, digest.canary);
  assert.ok(!fs.readFileSync(path.join(dir, 'guidance.g1.sealed.json'), 'utf8').includes('question number'));
  assert.equal(fs.existsSync(file), true, 'the plaintext stays unless --delete-plaintext');

  const again = seal(w, file, { deletePlaintext: true });
  assert.equal(again.generation, 2);
  assert.equal(fs.existsSync(file), false, '--delete-plaintext removes the input');
});

test('refusals exit 2: input inside the repo, no key, unknown corpus', (t) => {
  const w = world(t);
  const inside = path.join(w.repo, 'holdout-plain.json');
  fs.copyFileSync(guidanceFile(w), inside);
  assert.throws(() => seal(w, inside), (e) => e.exitCode === 2 && /inside the repository/.test(e.message));
  assert.throws(() => seal(w, guidanceFile(w), { keyFile: undefined }), (e) => e.exitCode === 2 && /no holdout key/.test(e.message));
  assert.throws(() => seal(w, guidanceFile(w), { corpus: 'both' }), /--corpus must be/);
  assert.throws(() => seal(w, undefined), /--in/);
  assert.equal(fs.existsSync(path.join(w.outDir, 'holdout')), false, 'nothing written on a refusal');
});

test('findings exit 1 and write nothing: dev id reuse, a missing applicable class, a wrong corpus, a bad anchor', (t) => {
  const w = world(t, { dev: ['HG-001'] });
  const out = seal(w, guidanceFile(w, { classes: GUIDANCE_CLASSES.slice(0, 4) }));
  assert.equal(out.exitCode, 1);
  const codes = out.findings.map((f) => f.code);
  assert.ok(codes.includes('E_ID_DUP'), 'HG-001 is a dev id');
  assert.ok(codes.includes('E_CLASS_MISSING'), 'oversized-context has no task');
  assert.equal(fs.existsSync(path.join(w.outDir, 'holdout')), false);

  const w2 = world(t);
  const file = guidanceFile(w2);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.tasks[0].qrels[0].anchorSha = 'f'.repeat(64);
  parsed.tasks[1].corpus = 'code';
  fs.writeFileSync(file, JSON.stringify(parsed));
  const bad = seal(w2, file);
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.findings.some((f) => f.code === 'E_QREL_ANCHOR'));
  assert.ok(bad.findings.some((f) => f.code === 'E_CORPUS'));
  assert.ok(bad.findings.every((f) => !/question number/.test(f.message)), 'findings never quote task text');
});

test('through the runner: JSON output has the seal summary and exit 1 lists findings', (t) => {
  const w = world(t);
  const lines = [];
  const code = runner.main(['seal', '--corpus', 'guidance', '--in', guidanceFile(w), '--key-file', w.keyFile, '--snapshot', w.snapshotPath, '--json'],
    { repoRoot: w.repo, out: (m) => lines.push(m), err: () => {} });
  assert.equal(code, 0);
  const obj = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(obj), ['verb', 'ok', 'exitCode', 'snapshotId', 'corpus', 'generation', 'taskCount', 'classCounts', 'plaintextSha256']);
  const refused = [];
  assert.equal(runner.main(['seal', '--corpus', 'guidance', '--in', path.join(w.repo, 'x.json'), '--key-file', w.keyFile, '--snapshot', w.snapshotPath], { repoRoot: w.repo, out: () => {}, err: (m) => refused.push(m) }), 2);
});
