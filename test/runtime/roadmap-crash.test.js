'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { mergeRoadmapRow, readOpenIntents } = require('../../src/runtime/roadmap/merge.ts');
const { next, handleRoadmapCommand } = require('../../src/runtime/roadmap/loop.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { createHash } = require('node:crypto');

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

// Crash classification on the real merge path: git heads outrank the recorded phase, and a child whose
// death is not proven is never treated as dead. Each case starts from a built intent with no ff yet.
const resumeCases = {
  'ff-done recorded, develop still at its old head': ['develop-moved', (f, intent) => { intent.phase = 'ff-done'; }],
  'rendered recorded, develop still at its old head': ['develop-moved', (f, intent) => { intent.phase = 'rendered'; }],
  'develop moved after built': ['develop-moved', (f) => f.git(f.develop, 'commit', '--allow-empty', '-qm', 'moved')],
  'feature moved after built': ['head-moved', (f) => f.git(f.feature, 'commit', '--allow-empty', '-qm', 'moved')],
  'develop dirty at built': ['develop-dirty', (f) => fs.writeFileSync(path.join(f.develop, 'human'), 'human bytes')],
  'ff-started whose recorded child is this live process': ['ff-running', (f, intent) => {
    intent.phase = 'ff-started'; intent.ff = { pid: process.pid, start: null, startedAt: '2026-01-01T00:00:00Z' };
  }],
};
for (const [name, [reason, arrange]] of Object.entries(resumeCases)) {
  test(`resume reads git before the phase: ${name} denies ${reason}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p) => { if (p === 'built') throw new Error('crash'); } }), /crash/);
    const intent = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    arrange(f, intent);
    fs.writeFileSync(f.file, JSON.stringify(intent));
    const spawned = [];
    const result = await mergeRoadmapRow({ ...f.options, spawn: (...args) => { spawned.push(args[1]); return cp.spawn(...args); } });
    assert.deepEqual([result.outcome, result.reason], ['denied', reason]);
    assert.deepEqual(spawned, [], 'no fast-forward is attempted');
    assert.equal(f.git(f.root, 'rev-list', '--merges', '--count', 'refs/heads/develop'), '0');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).phase, intent.phase, 'the intent keeps its phase');
  });
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
    const expected = ['live-child', 'unknown-child'].includes(refusal) ? 'ff-running' : 'develop-dirty';
    assert.equal((await mergeRoadmapRow({ ...f.options, alive })).reason, expected);
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

// ── kill after every step boundary of one fixture run (feature 108 F.1; FR-002, FR-008, NFR-002) ─────
//
// One row sits at an approved gate-b. The loop is driven to idle once with nothing killed to list its
// boundaries: each merge phase write (merge.ts onPhase), each run-record checkpoint write and the
// ROADMAP.md write. Then, for every boundary k, a fresh copy of the fixture is killed right after the
// k-th boundary (the exception stands for the process dying there; the lease is released by the
// call's own finally, as a process exit would leave it for the takeover rule) and the loop is driven
// to idle again. Each of those runs must end with exactly one merge for the row, a current table and
// no open intent: 0 duplicate merges, 0 stale rows.

const REPO = path.resolve(__dirname, '../..');
const ROW = { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['toy/'] };
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

class Killed extends Error {}

function loopFixture(t) {
  const dir = tempDir(t, 'doflow-roadmap-boundary-');
  const root = path.join(dir, 'main'), develop = path.join(dir, 'develop'), home = path.join(dir, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test',
    GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test', GIT_AUTHOR_DATE: '1792400000 +0000', GIT_COMMITTER_DATE: '1792400000 +0000' };
  delete env.DOFLOW_AUTOPILOT_ENABLED;
  const git = (cwd, ...args) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Develop Owner'); git(root, 'config', 'user.email', 'develop@example.test');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8'));
  for (const gate of ['gate-0', 'gate-a', 'gate-b']) policy.classes.feature[gate].predicates = ['markers-zero:plan'];
  put(path.join(root, 'core/registry/gates.json'), `${JSON.stringify(policy, null, 2)}\n`);
  put(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  put(path.join(root, 'shared.txt'), 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  put(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows: [ROW] }));
  put(path.join(home, '.config/doflow/settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }));
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const tick = () => new Date(clock += 1000);
  const worktree = path.join(dir, 'main-113');
  return { dir, root, develop, home, env, git, tick, worktree, file: path.join(root, '.doflow/state/roadmap/intents/113.json'),
    next: (options = {}) => next({ root, env, now: tick, ...options }) };
}

/** The row claimed, one feature commit made and gate-b approved by policy, as the E.3 loop tests do it. */
async function approvedRow(t) {
  const f = loopFixture(t);
  await f.next();
  put(path.join(f.worktree, 'toy/a.txt'), 'feature\n');
  f.git(f.worktree, 'add', '.'); f.git(f.worktree, 'commit', '-qm', 'toy');
  const heads = { developHead: f.git(f.root, 'rev-parse', 'develop'), featureHead: f.git(f.root, 'rev-parse', 'feat/113-toy') };
  const orch = new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: f.worktree, stateDir: path.join(f.worktree, '.doflow/state/orchestration'),
    featureSlug: '113-toy', env: f.env, readinessEvaluate: () => 'READY' });
  const run = orch.readRun('113-toy');
  run.cursor = run.program.length; run.state = 'COMPLETED';
  for (const node of run.program) node.status = node.type === 'gate' ? 'approved' : 'completed';
  run.history.push({ at: f.tick().toISOString(), action: 'decide-gate', node: 'gate-b', detail: 'approve', by: 'autopilot',
    policy: { id: 'gate-b', digest: `sha256:${'d'.repeat(64)}` }, inputs: [{ locator: `${f.worktree}#heads`, sha256: digestOf(JSON.stringify(heads)) }], note: 'approved by policy', forced: false });
  orch.writeRun(run, f.tick());
  return f;
}

/** Counts boundaries and kills right after the `killAt`-th one (0: never). */
function boundaries(killAt, trace) {
  let count = 0;
  const hit = (what) => { count += 1; trace.push(what); if (count === killAt) throw new Killed(`killed after boundary ${count}: ${what}`); };
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (/[\\/]runs[\\/]rl-[^\\/]+\.json$/.test(to)) hit('checkpoint');
    else if (to.endsWith('ROADMAP.md')) hit('table');
  };
  const mergeImpl = (options) => mergeRoadmapRow({ ...options, onPhase: (phase) => hit(`phase:${phase}`) });
  return { fsImpl, mergeImpl, count: () => count };
}

/** Drives next to idle; the session's post-merge verification (a perform) is answered like a session would. */
async function drive(f, options = {}) {
  let last = null;
  for (let call = 0; call < 14; call += 1) {
    const out = await f.next(options);
    last = out.result;
    if (last.outcome === 'perform' && last.perform.purpose === 'post-merge') {
      put(path.join(f.root, '.doflow/state/verification/runs/113-toy.jsonl'),
        `${JSON.stringify({ schema: 1, taskId: '113-toy', head: last.perform.head, clean: true, verdict: 'PASS', at: '2026-10-19T00:00:00Z', reportSha256: `sha256:${'e'.repeat(64)}` })}\n`);
    } else if (last.outcome === 'idle') return last;
    else if (last.outcome !== 'acted') throw new Error(`unexpected ${last.outcome} ${last.reason}`);
  }
  throw new Error(`no idle after 14 calls (last ${last.outcome})`);
}

/** The invariants of a finished run; an empty list means 0 duplicate merges and 0 stale rows. */
function violations(f) {
  const found = [];
  const merges = Number(f.git(f.root, 'rev-list', '--first-parent', '--merges', '--grep=^DoFlow-Row: 113$', '--count', 'refs/heads/develop'));
  if (merges !== 1) found.push(`${merges} merges carry the row trailer`);
  const table = path.join(f.root, 'agent-docs/roadmap/ROADMAP.md');
  const text = fs.existsSync(table) ? fs.readFileSync(table, 'utf8') : '';
  if (!/\| 113 \| Toy \| feature \| - \| merged \|/.test(text)) found.push('the table row is not merged');
  const lines = [];
  const log = console.log; const exit = process.exitCode;
  console.log = (...args) => lines.push(args.join(' '));
  try { if (handleRoadmapCommand({ action: 'render', check: true, json: true, root: f.root }) !== 0) found.push(`render --check failed: ${lines.join(' ')}`); }
  finally { console.log = log; process.exitCode = exit; }
  if (readOpenIntents({ root: f.root }).length !== 0) found.push('an intent is still open');
  if (!fs.existsSync(path.join(f.root, '.doflow/state/roadmap/done/113.json'))) found.push('the intent was not archived');
  if (f.git(f.develop, 'status', '--porcelain') !== '') found.push('the develop checkout is dirty');
  if (fs.existsSync(f.worktree)) found.push('the feature worktree is still there');
  if (f.git(f.root, 'branch', '--list', 'feat/113-toy') !== '') found.push('the feature branch is still there');
  return found;
}

test('boundary list: one fixture run has the merge phases, the table write and the checkpoints, in order', async (t) => {
  const f = await approvedRow(t);
  const trace = [];
  const { fsImpl, mergeImpl } = boundaries(0, trace);
  await drive(f, { fsImpl, mergeImpl });
  assert.deepEqual(violations(f), []);
  const phases = trace.filter((x) => x.startsWith('phase:')).map((x) => x.slice(6));
  assert.deepEqual(phases, ['intent', 'built', 'ff-started', 'ff-done', 'rendered', 'cleaned']);
  assert.ok(trace.filter((x) => x === 'checkpoint').length >= 4, 'every call that logs writes its checkpoint');
  assert.equal(trace.filter((x) => x === 'table').length, 1, 'the table is written once');
  boundaryTrace.push(...trace);
});

const boundaryTrace = [];
test('crash after every step boundary: 0 duplicate merges and 0 stale rows once the loop is driven to idle again', async (t) => {
  assert.ok(boundaryTrace.length > 0, 'the boundary list test runs first');
  t.diagnostic(`${boundaryTrace.length} boundaries: ${boundaryTrace.join(' ')}`);
  for (let k = 1; k <= boundaryTrace.length; k += 1) {
    const f = await approvedRow(t);
    const cut = boundaries(k, []);
    let killed = null;
    try { await drive(f, { fsImpl: cut.fsImpl, mergeImpl: cut.mergeImpl }); } catch (error) { if (!(error instanceof Killed)) throw error; killed = error.message; }
    assert.ok(killed, `boundary ${k} (${boundaryTrace[k - 1]}) was reached`);
    assert.equal(fs.existsSync(path.join(f.root, '.doflow/state/roadmap/lease.json')), false, `${killed}: the lease is not left behind`);
    await drive(f);
    assert.deepEqual(violations(f), [], killed);
  }
});

test('control: trusting the recorded intent phase without asking git makes a second merge, and the detector sees it', async (t) => {
  const f = await approvedRow(t);
  const cut = boundaries(0, []);
  // Kill after the fast-forward, then leave the intent saying the merge has not happened yet (a stale phase).
  await assert.rejects(f.next({ mergeImpl: (o) => mergeRoadmapRow({ ...o, isEnabled: () => ({ enabled: true }), postMergeCheck: () => ({ ok: true }),
    onPhase: (phase) => { if (phase === 'ff-done') throw new Killed('after ff'); } }) }), /after ff/);
  const intent = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(f.git(f.root, 'rev-parse', 'develop'), intent.commit, 'the merge is already on develop');
  intent.phase = 'built'; fs.writeFileSync(f.file, JSON.stringify(intent));
  // The real merge asks git first (HEAD at the intent commit outranks the phase): still one merge.
  const honest = await approvedRow(t);
  await assert.rejects(honest.next({ mergeImpl: (o) => mergeRoadmapRow({ ...o, isEnabled: () => ({ enabled: true }), postMergeCheck: () => ({ ok: true }),
    onPhase: (phase) => { if (phase === 'ff-done') throw new Killed('after ff'); } }) }), /after ff/);
  const honestIntent = JSON.parse(fs.readFileSync(honest.file, 'utf8')); honestIntent.phase = 'built'; fs.writeFileSync(honest.file, JSON.stringify(honestIntent));
  await drive(honest);
  assert.deepEqual(violations(honest), []);
  // The naive merge trusts `built`: it builds and fast-forwards again, a second merge for the same row.
  const naive = async (options) => {
    const open = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    if (!['intent', 'built', 'ff-started'].includes(open.phase)) return mergeRoadmapRow(options);
    const head = f.git(f.root, 'rev-parse', 'refs/heads/develop');
    const commit = f.git(f.root, 'commit-tree', f.git(f.root, 'rev-parse', `${head}^{tree}`), '-p', head, '-p', open.featureHead, '-m', 'merge: 113 Toy', '-m', 'DoFlow-Row: 113');
    f.git(f.develop, 'merge', '--ff-only', '-q', commit);
    open.phase = 'cleaned'; fs.writeFileSync(f.file, JSON.stringify(open));
    return { outcome: 'merged', cleanup: 'cleaned', commit };
  };
  await drive(f, { mergeImpl: naive }).catch(() => null);
  assert.ok(violations(f).some((v) => v.includes('2 merges carry the row trailer')), `expected a duplicate merge, got: ${violations(f)}`);
});
