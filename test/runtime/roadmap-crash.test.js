'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { mergeRoadmapRow, readOpenIntents, classifyMerge } = require('../../src/runtime/roadmap/merge.ts');

test('pure crash classification uses heads before phases and never treats unknown liveness as dead', () => {
  const intent = { phase: 'built', developHead: 'old', featureHead: 'feature', commit: 'merge' };
  const facts = { developHead: 'old', featureHead: 'feature', clean: true, builtValid: true };
  assert.deepEqual(classifyMerge(null, { ...facts, approvedHead: 'feature' }), { action: 'intent' });
  assert.equal(classifyMerge(null, { ...facts, approvedHead: 'moved' }).reason, 'head-moved');
  assert.deepEqual(classifyMerge({ ...intent, phase: 'intent' }, facts), { action: 'build' });
  assert.deepEqual(classifyMerge(intent, facts), { action: 'ff' });
  assert.deepEqual(classifyMerge(intent, { ...facts, builtValid: false }), { action: 'build' });
  assert.deepEqual(classifyMerge({ ...intent, commit: 'old' }, { ...facts, builtValid: false }), { action: 'build' });
  assert.deepEqual(classifyMerge(intent, { ...facts, developHead: 'merge' }), { action: 'render' });
  assert.deepEqual(classifyMerge({ ...intent, phase: 'ff-started' }, { ...facts, developHead: 'merge', clean: false }), { action: 'render' });
  assert.equal(classifyMerge(intent, { ...facts, developHead: 'other' }).reason, 'develop-moved');
  assert.equal(classifyMerge(intent, { ...facts, featureHead: 'other' }).reason, 'head-moved');
  assert.equal(classifyMerge(intent, { ...facts, clean: false }).reason, 'develop-dirty');
  const interrupted = { ...intent, phase: 'ff-started' };
  assert.deepEqual(classifyMerge(interrupted, { ...facts, ffAlive: false }), { action: 'ff' });
  assert.deepEqual(classifyMerge(interrupted, { ...facts, clean: false, ffAlive: false, lockStale: true }), { action: 'repair' });
  assert.equal(classifyMerge(interrupted, { ...facts, clean: false, ffAlive: 'unknown' }).reason, 'develop-dirty');
  assert.equal(classifyMerge(interrupted, { ...facts, ffAlive: true }).reason, 'develop-dirty');
  assert.equal(classifyMerge(interrupted, { ...facts, clean: false, ffAlive: false, lockStale: false }).reason, 'develop-dirty');
  assert.equal(classifyMerge({ ...intent, phase: 'ff-done' }, facts).reason, 'develop-moved');
  assert.deepEqual(classifyMerge({ ...intent, phase: 'rendered' }, { ...facts, developHead: 'merge' }), { action: 'cleanup' });
  assert.deepEqual(classifyMerge({ ...intent, phase: 'cleaned' }, { ...facts, developHead: 'merge' }), { action: 'done' });
});

// A separate fixture keeps this suite independently runnable (no test-file imports).
function fixture(t) {
  const root = tempDir(t, 'doflow-roadmap-crash-'), develop = path.join(root, 'dev'), feature = path.join(root, 'feature');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' };
  const git = (cwd, ...args) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Owner'); git(root, 'config', 'user.email', 'owner@example.test');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  fs.writeFileSync(path.join(root, 'base'), 'base'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  git(root, 'worktree', 'add', '-qb', 'develop', develop); git(root, 'worktree', 'add', '-qb', 'feat/113-toy', feature);
  fs.writeFileSync(path.join(feature, 'new'), 'feature bytes\n');
  git(feature, 'add', '.'); git(feature, 'commit', '-qm', 'feature');
  const row = { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['new'] };
  fs.mkdirSync(path.join(root, 'agent-docs/roadmap'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows: [row] }));
  const options = { root, row, runId: 'rl-crash', developWorktree: develop, featureWorktree: feature,
    approvedHead: git(feature, 'rev-parse', 'HEAD'), gate: { id: 'gate-b', digest: `sha256:${'b'.repeat(64)}` },
    env, now: () => 1792400000000, postMergeCheck: () => ({ ok: true }) };
  return { root, develop, feature, git, options, file: path.join(root, '.doflow/state/roadmap/intents/113.json') };
}

for (const phase of ['intent', 'built', 'ff-started', 'ff-done', 'rendered', 'cleaned']) {
  test(`P0-P5 crash after ${phase} resumes to exactly one merge and one render`, async (t) => {
    const f = fixture(t); let writes = 0;
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => { if (to.endsWith('ROADMAP.md')) writes++; return fs.renameSync(from, to); };
    await assert.rejects(mergeRoadmapRow({ ...f.options, fsImpl, onPhase: (at) => { if (at === phase) throw new Error('crash'); } }), /crash/);
    if (['intent', 'built', 'ff-started', 'ff-done'].includes(phase)) {
      assert.ok(fs.existsSync(f.feature)); assert.ok(f.git(f.root, 'rev-parse', 'feat/113-toy'));
    }
    const intent = JSON.parse(fs.readFileSync(f.file));
    const result = await mergeRoadmapRow({ ...f.options, fsImpl });
    assert.equal(result.outcome, 'merged');
    if (intent.commit) assert.equal(result.commit, intent.commit);
    assert.equal(fs.existsSync(path.join(f.root, '.doflow/state/roadmap/done/113.json')), true);
    assert.equal(fs.existsSync(f.file), false, 'the open intent path is removed after archive');
    assert.equal(f.git(f.develop, 'rev-list', '--first-parent', '--count', '--merges', 'HEAD'), '1');
    assert.equal(writes, 1); assert.deepEqual(readOpenIntents({ root: f.root }), []);
  });
}

test('rebuilding a built intent pins identity/date/message and gives the same commit SHA', async (t) => {
  const f = fixture(t);
  await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p) => { if (p === 'built') throw new Error('crash'); } }));
  const intent = JSON.parse(fs.readFileSync(f.file));
  const first = intent.commit; intent.phase = 'intent'; delete intent.commit; delete intent.tree;
  fs.writeFileSync(f.file, JSON.stringify(intent));
  const result = await mergeRoadmapRow({ ...f.options, now: () => 1892400000000 });
  assert.equal(result.commit, first);
});

for (const bad of ['tree', 'parents', 'old-head']) {
  test(`built intent with wrong ${bad} is rebuilt from pinned inputs`, async (t) => {
    const f = fixture(t);
    await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p) => { if (p === 'built') throw new Error('crash'); } }));
    const intent = JSON.parse(fs.readFileSync(f.file)), first = intent.commit;
    if (bad === 'tree') intent.tree = '0'.repeat(40);
    else intent.commit = bad === 'old-head' ? intent.developHead : intent.featureHead;
    fs.writeFileSync(f.file, JSON.stringify(intent));
    assert.equal((await mergeRoadmapRow(f.options)).commit, first);
  });
}

async function interrupted(t) {
  const f = fixture(t);
  await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p) => { if (p === 'built') throw new Error('crash'); } }));
  const intent = JSON.parse(fs.readFileSync(f.file));
  intent.phase = 'ff-started'; intent.ff = { pid: 2147483647, start: null, startedAt: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(f.file, JSON.stringify(intent));
  // Exact intermediate state of a killed ff: the new file exists, index and HEAD are still old.
  fs.writeFileSync(path.join(f.develop, 'new'), 'feature bytes\n');
  return { ...f, intent };
}

test('killed ff repairs only bytes equal to the intended blob, with CAS and a stale lock', async (t) => {
  const f = await interrupted(t);
  const lock = f.git(f.develop, 'rev-parse', '--git-path', 'index.lock');
  fs.writeFileSync(lock, 'dead'); fs.utimesSync(lock, new Date(0), new Date(0));
  const calls = [];
  const result = await mergeRoadmapRow({ ...f.options, alive: () => false,
    execFileSync(bin, args, opts) { calls.push(args); return cp.execFileSync(bin, args, opts); } });
  assert.equal(result.outcome, 'merged');
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.intent.commit);
  assert.equal(f.git(f.develop, 'status', '--porcelain'), '');
  assert.ok(calls.some((args) => args.includes('update-ref') && args.at(-1) === f.intent.developHead));
  assert.ok(calls.some((args) => args.includes('read-tree')));
});

test('dead ff with a clean old checkout and stale lock completes missing checkout files', async (t) => {
  const f = await interrupted(t);
  fs.unlinkSync(path.join(f.develop, 'new'));
  const lock = f.git(f.develop, 'rev-parse', '--git-path', 'index.lock');
  fs.writeFileSync(lock, 'dead'); fs.utimesSync(lock, new Date(0), new Date(0));
  const result = await mergeRoadmapRow({ ...f.options, alive: () => false });
  assert.equal(result.outcome, 'merged');
  assert.equal(fs.readFileSync(path.join(f.develop, 'new'), 'utf8'), 'feature bytes\n');
});

for (const refusal of ['wrong-bytes', 'outside-path', 'live-child', 'unknown-child', 'fresh-lock', 'missing-child', 'staged-bytes']) {
  test(`killed ff refuses repair: ${refusal}`, async (t) => {
    const f = await interrupted(t); let alive = () => false;
    if (refusal === 'wrong-bytes') fs.writeFileSync(path.join(f.develop, 'new'), 'human edit\n');
    if (refusal === 'outside-path') fs.writeFileSync(path.join(f.develop, 'human'), 'human edit');
    if (refusal === 'live-child') alive = () => true;
    if (refusal === 'unknown-child') alive = () => 'unknown';
    if (refusal === 'fresh-lock') {
      const lock = f.git(f.develop, 'rev-parse', '--git-path', 'index.lock');
      fs.writeFileSync(lock, 'live'); fs.utimesSync(lock, new Date(f.options.now()), new Date(f.options.now()));
    }
    if (refusal === 'missing-child') { delete f.intent.ff; fs.writeFileSync(f.file, JSON.stringify(f.intent)); }
    if (refusal === 'staged-bytes') { fs.writeFileSync(path.join(f.develop, 'base'), 'human edit'); f.git(f.develop, 'add', 'base'); }
    const before = f.git(f.develop, 'status', '--porcelain', '--untracked-files=all');
    assert.equal((await mergeRoadmapRow({ ...f.options, alive })).reason, 'develop-dirty');
    assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.intent.developHead);
    assert.equal(f.git(f.develop, 'status', '--porcelain', '--untracked-files=all'), before);
    assert.ok(fs.existsSync(f.feature));
  });
}

test('HEAD already at intent commit outranks stale phase and never creates another merge', async (t) => {
  const f = fixture(t);
  await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p) => { if (p === 'ff-done') throw new Error('crash'); } }));
  const intent = JSON.parse(fs.readFileSync(f.file)); intent.phase = 'built'; fs.writeFileSync(f.file, JSON.stringify(intent));
  const resumed = await mergeRoadmapRow(f.options);
  assert.equal(resumed.outcome, 'merged'); assert.equal(resumed.commit, intent.commit);
  assert.deepEqual(readOpenIntents({ root: f.root }), []);
  assert.equal(f.git(f.develop, 'rev-list', '--first-parent', '--count', '--merges', 'HEAD'), '1');
});

test('crash after render rename but before phase recording re-renders with zero extra writes', async (t) => {
  const f = fixture(t), fsImpl = Object.create(fs); let writes = 0;
  fsImpl.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (to.endsWith('ROADMAP.md')) { writes++; throw new Error('crash after render'); }
  };
  await assert.rejects(mergeRoadmapRow({ ...f.options, fsImpl }), /crash after render/);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).phase, 'ff-done');
  assert.ok(fs.existsSync(f.feature));
  assert.equal((await mergeRoadmapRow(f.options)).fileWrites, 0); assert.equal(writes, 1);
});

test('P1 resume denies changed heads and preserves its intent', async (t) => {
  for (const side of ['develop', 'feature']) {
    const f = fixture(t);
    await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p) => { if (p === 'intent') throw new Error('crash'); } }));
    f.git(f[side], 'commit', '--allow-empty', '-qm', 'moved');
    assert.equal((await mergeRoadmapRow(f.options)).reason, side === 'develop' ? 'develop-moved' : 'head-moved');
    assert.equal(JSON.parse(fs.readFileSync(f.file)).phase, 'intent');
  }
});

for (const after of ['remove', 'branch']) {
  test(`P5 cleanup resumes after ${after} already completed`, async (t) => {
    const f = fixture(t); let injected = false;
    const first = await mergeRoadmapRow({ ...f.options, execFileSync(bin, args, opts) {
      const output = cp.execFileSync(bin, args, opts);
      if (!injected && (after === 'remove' ? args.includes('remove') : args.includes('branch'))) {
        injected = true; throw new Error('interrupted cleanup');
      }
      return output;
    } });
    assert.equal(first.cleanup, 'cleanup-kept'); assert.equal(first.phase, 'rendered');
    assert.equal(fs.existsSync(f.feature), false);
    const resumed = await mergeRoadmapRow(f.options);
    assert.equal(resumed.outcome, 'merged'); assert.equal(resumed.cleanup, 'cleaned');
    assert.equal(fs.existsSync(path.join(f.root, '.doflow/state/roadmap/done/113.json')), true);
    assert.deepEqual(readOpenIntents({ root: f.root }), []);
  });
}
