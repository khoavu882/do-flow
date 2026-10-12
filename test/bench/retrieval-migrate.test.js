'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const migrate = require('../../bench/retrieval/lib/verbs/migrate.js');
const sealLib = require('../../bench/retrieval/lib/seal.js');
const tasksLib = require('../../bench/retrieval/lib/tasks.js');
const snap = require('../../bench/retrieval/lib/snapshot.js');
const runner = require('../../bench/retrieval/runner.js');
const { tempDir } = require('../helper/tmp');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const PASS = 'a long enough passphrase for tests';
const tokenize = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);
const lines = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n') + '\n';

const V1 = { 'src/moved.ts': `${lines(3, 'head')}MOVE-1\nMOVE-2\n${lines(2, 'tail')}`, 'src/dup.ts': 'D-1\nD-2\nother\n', 'src/gone.ts': 'G-1\nG-2\n', 'src/stay.ts': 'S-1\nS-2\nS-3\n' };
const V2 = { 'src/moved.ts': `${lines(5, 'new')}${lines(3, 'head')}MOVE-1\nMOVE-2\n${lines(2, 'tail')}`, 'src/dup.ts': 'D-1\nD-2\nother\nD-1\nD-2\n', 'src/gone.ts': 'rewritten\n', 'src/stay.ts': 'S-1\nS-2\nS-3\n' };

function write(repo, files) {
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
}

function world(t) {
  const repo = tempDir(t, 'doflow-migrate-');
  gitIn(repo, 'init', '-q');
  write(repo, V1);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'v1');
  const c1 = gitIn(repo, 'rev-parse', 'HEAD');
  const outDir = path.join(repo, 'bench', 'retrieval');
  const snapshot = snap.writeInitial({ commit: c1, seed: 1, repoRoot: repo, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  const manifest = snap.loadManifest(path.join(outDir, 'manifest.json'));
  const mk = (id, qrels) => ({
    id, split: 'dev', corpus: 'code', class: 'conceptual-discovery', query: 'where is the thing', qrels,
    expect: { result: ['RETRIEVED'] }, truthSource: ['src/moved.ts:4'], author: 'worker:t',
  });
  const q = (id, p, s, e) => ({ id, path: p, startLine: s, endLine: e, rel: 2 });
  const { taskFile } = tasksLib.fillTaskFile({
    schemaVersion: 1, snapshotId: 1, split: 'dev',
    tasks: [mk('DC-001', [q('q1', 'src/moved.ts', 4, 5), q('q2', 'src/stay.ts', 1, 3)]), mk('DC-002', [q('q1', 'src/dup.ts', 1, 2)]), mk('DC-003', [q('q1', 'src/gone.ts', 1, 2)])],
  }, { snapshot, manifest, repoRoot: repo, tokenize });
  fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'tasks', 'dev.json'), sealLib.toFileText(taskFile));
  snap.refreshTaskSha({ repoRoot: repo, snapshotFile: path.join(outDir, 'snapshot.json') });
  write(repo, V2);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'v2');
  return { repo, outDir, c1, c2: gitIn(repo, 'rev-parse', 'HEAD'), snapshotPath: path.join(outDir, 'snapshot.json'), snapshot, manifest };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('relocate finds a block that occurs exactly once and nothing else', () => {
  const l = ['a', 'b', 'c', 'b', 'c'];
  const q = (s, e) => ({ startLine: s, endLine: e, anchorSha: tasksLib.anchorOf(l, s, e) });
  assert.deepEqual(migrate.relocate(['x', 'a', 'b', 'c', 'y'], q(1, 3)), { startLine: 2, endLine: 4 });
  assert.equal(migrate.relocate(l, q(2, 3)), null, 'two occurrences');
  assert.equal(migrate.relocate(['z'], q(1, 3)), null, 'no occurrence');
});

test('migrate writes .next files, moves a unique block, marks ambiguous and missing ones, leaves the live files', (t) => {
  const w = world(t);
  const liveBefore = ['snapshot.json', 'manifest.json', 'tasks/dev.json'].map((f) => fs.readFileSync(path.join(w.outDir, f), 'utf8'));
  const out = migrate.migrate({ to: w.c2, snapshotPath: w.snapshotPath, repoRoot: w.repo, env: {}, home: w.outDir });
  assert.equal(out.nextSnapshotId, 2);
  assert.deepEqual(out.unresolved.map((u) => [u.taskId, u.qrelId, u.path]), [['DC-002', 'q1', 'src/dup.ts'], ['DC-003', 'q1', 'src/gone.ts']]);
  assert.equal(out.holdoutUnresolved, 0);
  assert.equal(out.holdoutChecked, false);

  const next = read(path.join(w.outDir, 'snapshot.next.json'));
  assert.equal(next.snapshotId, 2);
  assert.equal(next.commit, w.c2);
  assert.notEqual(next.manifestSha256, w.snapshot.manifestSha256);
  const manifestNext = read(path.join(w.outDir, 'manifest.next.json'));
  assert.equal(snap.manifestDigest(manifestNext.entries), next.manifestSha256);
  const devNextText = fs.readFileSync(path.join(w.outDir, 'tasks', 'dev.next.json'), 'utf8');
  assert.equal(sealLib.sha256Hex(devNextText), next.taskFiles.dev.sha256);
  const dev = JSON.parse(devNextText);
  assert.equal(dev.snapshotId, 2);
  const byId = Object.fromEntries(dev.tasks.map((x) => [x.id, x]));
  assert.deepEqual([byId['DC-001'].qrels[0].startLine, byId['DC-001'].qrels[0].endLine], [9, 10], 'the moved block follows the five inserted lines');
  assert.equal(byId['DC-001'].qrels[0].unresolved, undefined);
  assert.deepEqual([byId['DC-001'].qrels[1].startLine, byId['DC-001'].qrels[1].endLine], [1, 3], 'an unchanged block stays');
  assert.equal(byId['DC-002'].qrels[0].unresolved, true);
  assert.equal(byId['DC-002'].qrels[0].path, 'src/dup.ts', 'a qrel never changes path');
  assert.equal(byId['DC-003'].qrels[0].unresolved, true);

  const liveAfter = ['snapshot.json', 'manifest.json', 'tasks/dev.json'].map((f) => fs.readFileSync(path.join(w.outDir, f), 'utf8'));
  assert.deepEqual(liveAfter, liveBefore, 'the live files are untouched');
});

test('with a key, unresolved holdout qrels are counted in memory and only the count is printed', (t) => {
  const w = world(t);
  const keyFile = path.join(tempDir(t, 'doflow-migrate-key-'), 'k');
  fs.writeFileSync(keyFile, `${PASS}\n`);
  fs.chmodSync(keyFile, 0o600);
  const task = (id, p, s, e, text) => ({
    id, split: 'holdout', corpus: 'code', class: 'conceptual-discovery', query: 'SECRET-HOLDOUT-QUERY', expect: { result: ['RETRIEVED'] }, truthSource: ['x'], author: 'w', queryOverlap: 0,
    qrels: [{ id: 'q1', path: p, startLine: s, endLine: e, rel: 2, anchorSha: tasksLib.anchorOf(text.split('\n'), s, e) }],
  });
  const taskFile = { schemaVersion: 1, snapshotId: 1, split: 'holdout', tasks: [task('HC-001', 'src/gone.ts', 1, 2, 'G-1\nG-2\n'), task('HC-002', 'src/stay.ts', 1, 3, 'S-1\nS-2\nS-3\n')] };
  const sealed = sealLib.sealTasks({ taskFile, passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1, sealedBy: 'w', classes: ['conceptual-discovery'] });
  sealLib.writeSealed({ dir: path.join(w.outDir, 'holdout'), corpus: 'code', generation: 1, envelopeText: sealed.envelopeText, sealText: sealed.sealText });

  const out = migrate.migrate({ to: w.c2, keyFile, snapshotPath: w.snapshotPath, repoRoot: w.repo, env: {}, home: w.outDir });
  assert.equal(out.holdoutUnresolved, 1);
  assert.equal(out.holdoutChecked, true);
  const logged = [];
  const code = runner.main(['migrate', '--to', w.c2, '--key-file', keyFile, '--snapshot', w.snapshotPath, '--json'], { repoRoot: w.repo, out: (m) => logged.push(m), err: (m) => logged.push(m) });
  assert.equal(code, 1, 'any unresolved qrel exits 1');
  const everything = logged.join('\n');
  assert.ok(!everything.includes('HC-00') && !everything.includes('SECRET-HOLDOUT-QUERY'), 'no holdout id or text is printed');
  const obj = JSON.parse(logged.find((l) => l.startsWith('{')));
  assert.deepEqual(Object.keys(obj), ['verb', 'ok', 'exitCode', 'snapshotId', 'nextSnapshotId', 'unresolved', 'holdoutUnresolved', 'holdoutChecked']);
  assert.equal(obj.holdoutUnresolved, 1);
});

test('migrate with nothing unresolved exits 0; a commit that is not in the repository is refused', (t) => {
  const w = world(t);
  const clean = world(t);
  gitIn(clean.repo, 'checkout', clean.c1, '--', 'src');
  gitIn(clean.repo, 'commit', '-q', '-m', 'back to v1 sources');
  const errs = [];
  const code = runner.main(['migrate', '--to', 'HEAD', '--snapshot', clean.snapshotPath], { repoRoot: clean.repo, out: () => {}, err: (m) => errs.push(m) });
  assert.deepEqual(errs, []);
  assert.equal(code, 0);
  assert.throws(() => migrate.migrate({ to: 'f'.repeat(40), snapshotPath: w.snapshotPath, repoRoot: w.repo, env: {}, home: w.outDir }), /not in this repository/);
  assert.throws(() => migrate.migrate({ snapshotPath: w.snapshotPath, repoRoot: w.repo }), /--to/);
});
