'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tasksLib = require('../../bench/retrieval/lib/tasks.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const { sha256Hex } = require('../../bench/retrieval/lib/seal.ts');
const { tempDir } = require('../helper/tmp.ts');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const A_TS = 'alpha\nbeta\ngamma\ndelta\n';
const G_MD = '# Heading One\nfirst body\n# Heading Two\nsecond body\n';
const tokenize = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2);

function fixture(t) {
  const dir = tempDir(t, 'doflow-tasks-');
  gitIn(dir, 'init', '-q');
  const files = { 'src/a.ts': A_TS, 'src/b.ts': 'one\ntwo\n', 'core/shared/guidance/g.md': G_MD, 'bench/retrieval/fixtures/x.patch': 'patch\n' };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'c');
  const commit = gitIn(dir, 'rev-parse', 'HEAD');
  const outDir = path.join(dir, 'out');
  const snapshot = snap.writeInitial({ commit, seed: 1, repoRoot: dir, outDir, tools: [], env: { node: 'v', os: 'o', arch: 'a' } });
  return { dir, snapshot, manifest: snap.loadManifest(path.join(outDir, 'manifest.json')) };
}

const anchor = (lines, s, e) => sha256Hex(lines.slice(s - 1, e).join('\n'));
const A_LINES = ['alpha', 'beta', 'gamma', 'delta'];
const qrel = (over = {}) => ({ id: 'q1', path: 'src/a.ts', startLine: 2, endLine: 3, rel: 2, anchorSha: anchor(A_LINES, 2, 3), ...over });
const task = (over = {}) => ({
  id: 'DC-001', split: 'dev', corpus: 'code', class: 'conceptual-discovery', query: 'where is the thing',
  qrels: [qrel()], expect: { result: ['RETRIEVED'] }, queryOverlap: 0.1, truthSource: ['src/a.ts:2'], author: 'worker:test', ...over,
});
const file = (tasks, over = {}) => ({ schemaVersion: 1, snapshotId: 1, split: 'dev', tasks, ...over });
const codes = (findings) => findings.map((f) => f.code);

test('a valid task file has no findings', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  assert.deepEqual(tasksLib.validateTaskFile(file([task()]), { split: 'dev', snapshot, manifest, repoRoot: dir }), []);
});

test('ids, split, corpus and class rules', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const v = (tasks, over = {}, split = 'dev') => codes(tasksLib.validateTaskFile(file(tasks, { split, ...over }), { split, snapshot, manifest, repoRoot: dir }));
  assert.ok(v([task(), task()]).includes('E_ID_DUP'));
  assert.ok(v([task({ id: 'HC-001' })]).includes('E_ID_FORMAT'));
  assert.ok(v([task({ id: 'DG-001' })]).includes('E_ID_FORMAT'), 'letter must match the corpus');
  assert.ok(v([task({ split: 'holdout' })]).includes('E_SPLIT'));
  assert.ok(v([task()], { split: 'holdout' }).includes('E_SCHEMA'), 'file split must match');
  assert.ok(v([task({ class: 'impact-refactor', corpus: 'guidance', id: 'DG-001' })]).includes('E_CLASS_NA'));
  assert.ok(v([task({ class: 'nope' })]).includes('E_CLASS'));
  assert.ok(v([task()], { snapshotId: 2 }).includes('E_SCHEMA'));
});

test('required fields per class', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const fields = (over) => tasksLib.validateTaskFile(file([task(over)]), { split: 'dev', snapshot, manifest, repoRoot: dir, checkTrueNegatives: false })
    .filter((f) => f.code === 'E_FIELD').map((f) => f.message);
  assert.deepEqual(fields({ class: 'exact-lookup' }), ['exact-lookup needs literal']);
  assert.deepEqual(fields({ class: 'impact-refactor' }), ['impact-refactor needs dependencies']);
  assert.deepEqual(fields({ class: 'unavailable-provider' }), ['unavailable-provider needs setup.disable']);
  assert.deepEqual(fields({ class: 'stale-index' }), ['stale-index needs setup.patch']);
  assert.deepEqual(fields({ class: 'dirty-tree', setup: { patch: 'bench/retrieval/fixtures/x.patch' } }), []);
  assert.deepEqual(fields({ class: 'oversized-context' }), ['oversized-context needs expect.budgetBytes', 'oversized-context needs expect.mustInclude']);
  assert.deepEqual(fields({ class: 'oversized-context', expect: { result: ['RETRIEVED'], budgetBytes: 100, mustInclude: ['q9'] } }), ['expect.mustInclude names an id that is not a qrel']);
  assert.deepEqual(fields({ class: 'verification-failure' }), ['verification-failure needs expect.mustSurvive', 'verification-failure needs setup.command']);
  assert.deepEqual(fields({ class: 'verification-failure', expect: { result: ['RETRIEVED'], mustSurvive: { exitCode: 1, lines: ['x'] } }, setup: { command: ['node', '-e', '1'] } }), []);
});

test('qrel checks: manifest path, range, anchor, heading, id', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const v = (qrels, over = {}) => codes(tasksLib.validateTaskFile(file([task({ qrels, ...over })]), { split: 'dev', snapshot, manifest, repoRoot: dir }));
  assert.ok(v([qrel({ path: 'src/missing.ts' })]).includes('E_QREL_PATH'));
  assert.ok(v([qrel({ path: 'core/shared/guidance/g.md' })]).includes('E_QREL_PATH'), 'a guidance path is not in the code corpus');
  assert.ok(v([qrel({ endLine: 9 })]).includes('E_QREL_RANGE'));
  assert.ok(v([qrel({ startLine: 3, endLine: 2 })]).includes('E_QREL_RANGE'));
  assert.ok(v([qrel({ anchorSha: 'f'.repeat(64) })]).includes('E_QREL_ANCHOR'));
  assert.ok(v([qrel({ id: 'x1' })]).includes('E_QREL_ID'));
  assert.ok(v([qrel(), qrel()]).includes('E_QREL_ID'));
  assert.ok(v([]).includes('E_QREL'));
  const g = task({ id: 'DG-001', corpus: 'guidance', qrels: [{ id: 'q1', path: 'core/shared/guidance/g.md', startLine: 1, endLine: 2, rel: 2, anchorSha: anchor(G_MD.split('\n').slice(0, 4), 1, 2) }] });
  assert.ok(codes(tasksLib.validateTaskFile(file([g]), { split: 'dev', snapshot, manifest, repoRoot: dir })).includes('E_QREL_HEADING'));
  g.qrels[0].heading = '# Heading One';
  assert.deepEqual(tasksLib.validateTaskFile(file([g]), { split: 'dev', snapshot, manifest, repoRoot: dir }), []);
});

test('conceptual overlap cap, truthSource, expect and patch placement', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const v = (over, split = 'dev') => codes(tasksLib.validateTaskFile(file([task(over)], { split }), { split, snapshot, manifest, repoRoot: dir }));
  assert.ok(v({ queryOverlap: 0.31 }).includes('E_OVERLAP'));
  assert.ok(!v({ queryOverlap: 0.3 }).includes('E_OVERLAP'));
  assert.ok(!v({ class: 'dirty-tree', queryOverlap: 0.9, setup: { patch: 'bench/retrieval/fixtures/x.patch' } }).includes('E_OVERLAP'), 'the cap is for conceptual tasks only');
  assert.ok(v({ truthSource: [] }).includes('E_TRUTH_SOURCE'));
  assert.ok(v({ expect: { result: [] } }).includes('E_EXPECT'));
  assert.ok(v({ expect: { result: ['BOGUS'] } }).includes('E_EXPECT'));
  assert.ok(v({ class: 'dirty-tree', setup: { patchText: 'diff' } }).includes('E_PATCH_SPLIT'));
  assert.ok(v({ class: 'dirty-tree', setup: { patch: 'elsewhere/x.patch' } }).includes('E_PATCH_PATH'));
  assert.ok(v({ class: 'dirty-tree', setup: { patch: 'bench/retrieval/fixtures/none.patch' } }).includes('E_PATCH_PATH'));
  assert.ok(v({ id: 'HC-001', split: 'holdout', class: 'dirty-tree', setup: { patch: 'bench/retrieval/fixtures/x.patch' } }, 'holdout').includes('E_PATCH_SPLIT'));
  assert.ok(!v({ id: 'HC-001', split: 'holdout', class: 'dirty-tree', setup: { patchText: 'diff' } }, 'holdout').includes('E_PATCH_SPLIT'));
});

test('a true negative needs an absent literal; a present literal is a finding', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const neg = (literal) => task({ class: 'exact-lookup', literal, qrels: [], expect: { result: ['EMPTY'] } });
  const run = (literal) => codes(tasksLib.validateTaskFile(file([neg(literal)]), { split: 'dev', snapshot, manifest, repoRoot: dir }));
  assert.deepEqual(run('zzz_not_anywhere_074'), []);
  assert.deepEqual(run('gamma'), ['E_TRUE_NEGATIVE']);
  assert.ok(codes(tasksLib.validateTaskFile(file([task({ class: 'exact-lookup', literal: 'x', qrels: [] })]), { split: 'dev', snapshot, manifest, repoRoot: dir })).includes('E_QREL'),
    'empty qrels need expect.result [EMPTY]');
});

test('devIds blocks a holdout id that is also a dev id', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const h = task({ id: 'HC-001', split: 'holdout', class: 'dirty-tree', setup: { patchText: 'd' } });
  const f = file([h], { split: 'holdout' });
  assert.deepEqual(tasksLib.validateTaskFile(f, { split: 'holdout', snapshot, manifest, repoRoot: dir, devIds: new Set(['DC-001']) }), []);
  assert.ok(codes(tasksLib.validateTaskFile(f, { split: 'holdout', snapshot, manifest, repoRoot: dir, devIds: new Set(['HC-001']) })).includes('E_ID_DUP'));
});

test('fillTaskFile computes anchorSha and queryOverlap and orders keys', (t) => {
  const { dir, snapshot, manifest } = fixture(t);
  const raw = task({ query: 'beta gamma unrelated word', qrels: [{ id: 'q1', path: 'src/a.ts', startLine: 2, endLine: 3, rel: 2 }] });
  delete raw.queryOverlap;
  const { taskFile, problems } = tasksLib.fillTaskFile(file([raw]), { snapshot, manifest, repoRoot: dir, tokenize });
  assert.deepEqual(problems, []);
  const [out] = taskFile.tasks;
  assert.equal(out.qrels[0].anchorSha, anchor(A_LINES, 2, 3));
  assert.equal(out.queryOverlap, 0.5, '2 of 4 query tokens occur in the qrel span');
  assert.deepEqual(Object.keys(out).slice(0, 5), ['id', 'split', 'corpus', 'class', 'query']);
  assert.ok(Object.keys(out).indexOf('queryOverlap') > Object.keys(out).indexOf('expect'));
  assert.deepEqual(tasksLib.validateTaskFile(file([{ ...out, class: 'dirty-tree', queryOverlap: out.queryOverlap, setup: { patch: 'bench/retrieval/fixtures/x.patch' } }]), { split: 'dev', snapshot, manifest, repoRoot: dir }), []);
  const bad = tasksLib.fillTaskFile(file([task({ qrels: [{ id: 'q1', path: 'src/a.ts', startLine: 2, endLine: 99, rel: 2 }] })]), { snapshot, manifest, repoRoot: dir, tokenize });
  assert.equal(bad.problems.length, 1);
});

test('mergeParts sorts by id and rejects duplicates and disagreeing headers', () => {
  const merged = tasksLib.mergeParts([file([{ id: 'DC-003' }]), file([{ id: 'DC-001' }, { id: 'DC-002' }])]);
  assert.deepEqual(merged.tasks.map((x) => x.id), ['DC-001', 'DC-002', 'DC-003']);
  assert.throws(() => tasksLib.mergeParts([file([{ id: 'DC-001' }]), file([{ id: 'DC-001' }])]), /duplicate task id DC-001/);
  assert.throws(() => tasksLib.mergeParts([file([]), file([], { snapshotId: 2 })]), /disagree on snapshotId/);
});

test('the CLI merges parts and deletes them, prints counts and codes but no task text', (t) => {
  const dir = tempDir(t, 'doflow-tasks-cli-');
  const parts = ['p1.json', 'p2.json'].map((n) => path.join(dir, n));
  fs.writeFileSync(parts[0], JSON.stringify(file([{ id: 'DC-002', query: 'SECRET-QUERY-TEXT' }])));
  fs.writeFileSync(parts[1], JSON.stringify(file([{ id: 'DC-001' }])));
  const lines = [];
  const out = path.join(dir, 'merged', 'dev.json');
  assert.equal(tasksLib.main(['--merge', out, ...parts], { out: (m) => lines.push(m), err: (m) => lines.push(m) }), 0);
  assert.deepEqual(parts.map((p) => fs.existsSync(p)), [false, false], 'parts are deleted after the merge');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).tasks.map((x) => x.id), ['DC-001', 'DC-002']);

  const keep = path.join(dir, 'k.json');
  fs.writeFileSync(keep, JSON.stringify(file([{ id: 'DC-009' }])));
  assert.equal(tasksLib.main(['--merge', path.join(dir, 'o2.json'), keep, '--keep-parts'], { out() {}, err() {} }), 0);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(tasksLib.main(['--merge', path.join(dir, 'o3.json'), keep, keep], { out() {}, err() {} }), 2, 'duplicate ids across parts');
  assert.equal(tasksLib.main(['--bogus'], { out() {}, err() {} }), 2);
  assert.ok(!lines.join('\n').includes('SECRET-QUERY-TEXT'));
});
