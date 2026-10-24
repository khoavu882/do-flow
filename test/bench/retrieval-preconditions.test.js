'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pre = require('../../bench/retrieval/lib/verbs/holdout-preconditions.ts');
const sealLib = require('../../bench/retrieval/lib/seal.ts');
const { tempDir } = require('../helper/tmp.ts');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const PASS = 'a long enough passphrase for tests';
const APPROVED = (extra = {}) => ({ status: 'approved', approvedOn: '2026-10-12', ...extra });
const thresholdsFile = (over = {}) => ({
  schemaVersion: 1,
  minN: { ranking: 10, outcome: 3, ...APPROVED() },
  thresholds: [{ id: 'T-001', metric: 'falseAbsence', ...APPROVED() }, { id: 'T-002', metric: 'recallAt10', ...APPROVED() }],
  rules: [{ id: 'RULE-001', text: 't', ...APPROVED() }],
  costCaps: { maxTokensPerRun: 1, ...APPROVED() },
  rerun: { tolerances: [], ...APPROVED() },
  ...over,
});

function world(t, { thresholds = thresholdsFile(), commit = true } = {}) {
  const repo = tempDir(t, 'doflow-pre-');
  gitIn(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'bench', 'retrieval'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README'), 'r');
  if (thresholds) fs.writeFileSync(path.join(repo, 'bench/retrieval/thresholds.json'), JSON.stringify(thresholds, null, 2));
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  if (!commit) fs.writeFileSync(path.join(repo, 'bench/retrieval/thresholds.json'), JSON.stringify({ ...thresholds, edited: true }));
  const taskFile = { schemaVersion: 1, snapshotId: 1, split: 'holdout', tasks: [{ id: 'HC-001', class: 'exact-lookup' }] };
  const sealed = sealLib.sealTasks({ taskFile, passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1, sealedBy: 'w', classes: ['exact-lookup'] });
  return {
    repo, thresholds,
    sealMeta: { code: { generation: 1, seal: sealed.seal, envelope: sealed.envelope, label: 'bench/retrieval/holdout/code.g1.sealed.json' } },
    base() { return { args: { config: 'A,B' }, repoRoot: repo, snapshot: { snapshotId: 1 }, thresholds, sealMeta: this.sealMeta, env: { DOFLOW_HOLDOUT_KEY: PASS }, home: repo }; },
  };
}

const addResult = (repo, name) => {
  fs.mkdirSync(path.join(repo, 'bench/retrieval/results'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'bench/retrieval/results', name), '{}');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', name);
};

test('all six preconditions pass on a clean, approved, sealed state', (t) => {
  const w = world(t);
  assert.deepEqual(pre.check(w.base()), { ok: true });
  assert.deepEqual(pre.check({ ...w.base(), args: {} }), { ok: true }, 'the default configuration is A,B');
});

test('(a) --config must be A,B', (t) => {
  const w = world(t);
  for (const config of ['A', 'B', 'B,A']) {
    const r = pre.check({ ...w.base(), args: { config } });
    assert.deepEqual([r.ok, r.exitCode, r.precondition], [false, 2, 'a']);
  }
});

test('(b) every entry must be approved with a date; the message names the entries', (t) => {
  const proposed = world(t, { thresholds: thresholdsFile({ thresholds: [{ id: 'T-001', status: 'proposed' }, { id: 'T-002', ...APPROVED() }] }) });
  const r = pre.check(proposed.base());
  assert.deepEqual([r.ok, r.precondition], [false, 'b']);
  assert.match(r.message, /T-001/);
  assert.doesNotMatch(r.message, /T-002/);
  const noDate = world(t, { thresholds: thresholdsFile({ rerun: { tolerances: [], status: 'approved' } }) });
  assert.match(pre.check(noDate.base()).message, /rerun/);
  const nested = world(t, { thresholds: thresholdsFile({ costCaps: { status: 'proposed' } }) });
  assert.match(pre.check(nested.base()).message, /costCaps/);
  assert.equal(pre.check({ ...proposed.base(), thresholds: null }).precondition, 'b');
});

test('(c) the thresholds file must be tracked and identical to HEAD', (t) => {
  const dirty = world(t, { commit: false });
  const r = pre.check(dirty.base());
  assert.deepEqual([r.ok, r.precondition], [false, 'c']);
  assert.match(r.message, /differs from HEAD/);
  const untracked = world(t, { thresholds: null });
  fs.writeFileSync(path.join(untracked.repo, 'bench/retrieval/thresholds.json'), JSON.stringify(thresholdsFile()));
  const u = pre.check({ ...untracked.base(), thresholds: thresholdsFile() });
  assert.deepEqual([u.precondition, /not tracked/.test(u.message)], ['c', true]);
});

test('(d) the key must decrypt and the plaintext must match its seal', (t) => {
  const w = world(t);
  const wrong = pre.check({ ...w.base(), env: { DOFLOW_HOLDOUT_KEY: 'x'.repeat(30) } });
  assert.deepEqual([wrong.ok, wrong.precondition], [false, 'd']);
  assert.equal(wrong.message, 'holdout key does not decrypt bench/retrieval/holdout/code.g1.sealed.json');
  assert.equal(pre.check({ ...w.base(), env: {} }).precondition, 'd', 'no key at all');
  const tampered = w.base();
  tampered.sealMeta = { code: { ...w.sealMeta.code, seal: { ...w.sealMeta.code.seal, plaintextSha256: '0'.repeat(64) } } };
  assert.match(pre.check(tampered).message, /does not match its seal digest/);
});

test('(e) an existing result for this generation, corpus and configuration refuses, on disk or in history', (t) => {
  const w = world(t);
  addResult(w.repo, 'holdout-1-g1-code-A.json');
  const r = pre.check(w.base());
  assert.deepEqual([r.ok, r.precondition], [false, 'e']);
  assert.match(r.message, /holdout-1-g1-code-A\.json/);
  gitIn(w.repo, 'rm', '-q', 'bench/retrieval/results/holdout-1-g1-code-A.json');
  gitIn(w.repo, 'commit', '-q', '-m', 'delete the result');
  assert.equal(fs.existsSync(path.join(w.repo, 'bench/retrieval/results/holdout-1-g1-code-A.json')), false);
  assert.equal(pre.check(w.base()).precondition, 'e', 'a deleted result still counts: git log --all remembers it');
  const other = world(t);
  addResult(other.repo, 'holdout-1-g2-code-A.json');
  addResult(other.repo, 'holdout-2-g1-code-B.json');
  assert.deepEqual(pre.check(other.base()), { ok: true }, 'another generation or snapshot does not block');
});

test('(f) counts the configuration runs of the generation across corpora; comparison files are not runs', (t) => {
  const w = world(t);
  for (const name of ['holdout-1-g1-guidance-A.json', 'holdout-1-g1-guidance-B.json', 'holdout-1-g1-guidance-A-vs-B.json', 'holdout-1-g2-guidance-A.json']) addResult(w.repo, name);
  assert.deepEqual(pre.check(w.base()), { ok: true }, '2 used in generation 1, plus 2 for this run, is 4 of 6');
  // With one result per corpus and configuration under (e), a generation holds at most four runs, so
  // (f) is a backstop for hand-added files and cannot fire through the flow alone.
  assert.equal(pre.MAX_RUNS, 6);
});
