'use strict';

// Feature 080 D.3 (IC-004 comparison, IC-005 row 4 clear, IC-013 claim record, IC-015, IC-025;
// DEC-004, DEC-007, DEC-010): claim records the task's sources before the lock, and resume reports
// active attempts, changed sources, stale context and the graph comparison with a digest that an
// explicit acknowledgement must match before the run resumes under a new epoch.
//
// In-process against temp projects. Every call passes an explicit identity environment (the four
// identity variables plus XDG_CONFIG_HOME for 078's summary store), so the developer's shell never
// decides a run key or a summary scope. The git probe is a stub except in the detached-HEAD case,
// which runs real git in a temp repository.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { claim, status, start, pause, cancel, resume, TaskAttemptError } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, resumeDigest } = require('../../src/runtime/task-run.ts');
const { summaryScope } = require('../../src/runtime/context/summary-store.ts');

const SLUG = 'feat-r';
const NOW = new Date('2026-01-03T00:00:00.000Z');
const LATER = new Date('2026-01-03T00:05:00.000Z');
const HEADER = '**Task graph:** v1';
const REPO = path.resolve(__dirname, '..', '..');

const DEFAULT_LINES = [
  '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js',
  '- [ ] A.2 second task; owner: core-implementer; files: b.js, src/*.js',
  '', '### Phase B', '',
  '- [ ] B.1 later task; owner: core-implementer; files: c.js',
];

function planText({ header = true, lines = DEFAULT_LINES } = {}) {
  return ['# Plan', '', ...(header ? [HEADER, ''] : []), '## Tasks', '', ...lines, ''].join('\n');
}

/** A git runner stub: `branch` for symbolic-ref (null = detached), `commit` for rev-parse. */
const gitStub = ({ branch = 'feat/080', commit = null } = {}) => (args) => {
  if (args[0] === 'symbolic-ref') return branch === null ? null : `${branch}\n`;
  if (args[0] === 'rev-parse') return commit === null ? null : `${commit}\n`;
  return null;
};

function project(t, { plan = planText(), git = true } = {}) {
  const dir = tempDir(t, 'doflow-task-run-resume-');
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(xdg);
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(dir, f), `// ${f}\n`);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const env = (who = {}) => ({
    DOFLOW_RUN_ID: who.run || 'r1', DOFLOW_LINEAGE_ID: who.lineage || 'main',
    DOFLOW_SESSION_ROLE: who.role || 'main', DOFLOW_ROLE: who.role || 'main',
    DOFLOW_WORKTREE: dir, HOME: dir, XDG_CONFIG_HOME: xdg,
  });
  const common = (who = {}, now = NOW) => ({ file, fsImpl: fs, roots: [dir], slug: SLUG, now, env: env(who), cwd: dir });
  const key = (who = {}) => runKeyFor(env(who), dir);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file) : null);
  /** A pending 078 summary in this identity's scope, header written by hand. */
  const summary = (fields, who = {}) => {
    const e = env(who);
    const scope = summaryScope(dir, e.DOFLOW_RUN_ID, e.DOFLOW_LINEAGE_ID, e);
    fs.mkdirSync(scope, { recursive: true });
    const p = path.join(scope, 'summary.md');
    fs.writeFileSync(p, `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join('')}---\n\nBODY\n`);
    return p;
  };
  return { dir, file, common, key, read, bytes, summary, planFile };
}

const claimAs = (p, task, extra = {}) => claim({ ...p.common(), task, owner: 'core-implementer', mode: 'subagent', ...extra });

// ── claim records sources (IC-013, IC-006 step 2) ────────────────────────────────────────────────

test('a graph-plan claim records sources and returns sourcesUnverifiable; a legacy claim keeps its result shape', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  assert.equal('sourcesUnverifiable' in claimAs(p, 'A.1', { epoch: 1 }), false, 'listed only when an entry is opaque');
  const done = claimAs(p, 'A.2', { epoch: 1 });
  assert.equal(done.disposition, 'claimed');
  assert.deepEqual(done.sourcesUnverifiable, ['src/*.js']);
  const a2 = p.read().tasks['A.2'].attempts[0];
  assert.equal(a2.sourcesTruncated, false);
  assert.equal(a2.sources[0].file, 'b.js');
  assert.equal(a2.sources[0].kind, 'file');
  assert.match(a2.sources[0].fileHash, /^sha256:|^[0-9a-f]+$/);
  assert.deepEqual(a2.sources[1], { file: 'src/*.js', kind: 'unverifiable', fileHash: null, why: 'pattern' });

  const legacy = project(t, { plan: planText({ header: false }) });
  const answer = claimAs(legacy, 'A.1');
  assert.deepEqual(Object.keys(answer).sort(), ['disposition', 'revision', 'taskId', 'token'], 'a legacy result keeps the 8ce5ad7 shape');
  assert.equal(legacy.read().tasks['A.1'].attempts[0].sources[0].kind, 'file');
});

// ── the requirement scenario ─────────────────────────────────────────────────────────────────────

test('resume reports a paused run, its active attempt, a changed file and a summary from another branch, then resumes on ack', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  assert.equal(claimAs(p, 'A.1', { epoch: 1 }).disposition, 'claimed');
  pause({ ...p.common(), by: 'orchestrator', reason: 'session ended' });
  fs.writeFileSync(path.join(p.dir, 'a.js'), '// edited\n');
  const summaryPath = p.summary({ summary_id: 'S1', branch: 'other', worktree: p.dir });
  const key = p.key().runKey;

  const before = p.bytes();
  const asked = resume({ ...p.common({}, LATER), gitRunner: gitStub() });
  assert.deepEqual(p.bytes(), before, 'without --ack nothing is written');
  assert.equal(asked.disposition, 'ack-required');
  assert.match(asked.digest, /^sha256:[0-9a-f]{64}$/);
  const r = asked.report;
  assert.equal(r.runKey, key);
  assert.equal(r.control, 'paused');
  assert.equal(r.epoch, 1);
  assert.deepEqual(r.activeAttempts, [{
    taskId: 'A.1', token: 1, owner: 'core-implementer', mode: 'subagent', startedAt: NOW.toISOString(),
    ageSeconds: 300, runKey: key, execWorktree: p.dir,
  }]);
  assert.deepEqual(r.changedSources, [{ taskId: 'A.1', token: 1, file: 'a.js', change: 'changed' }]);
  assert.deepEqual(r.doneChanged, []);
  assert.deepEqual(r.unverifiable, []);
  assert.deepEqual(r.staleContext, [{ kind: 'summary', path: summaryPath, reasons: ['branch-differs'] }]);
  assert.equal(r.graph.changed, false);
  assert.deepEqual([r.graph.added, r.graph.removed, r.graph.changedIds, r.graph.truncated], [[], [], [], false]);

  const resumed = resume({ ...p.common({}, LATER), ack: asked.digest, by: 'orchestrator', gitRunner: gitStub() });
  assert.equal(resumed.disposition, 'resumed');
  assert.equal(resumed.epoch, 2);
  assert.equal(resumed.digest, asked.digest);
  const run = p.read().runs[key];
  assert.equal(run.control, 'running');
  assert.equal(run.epoch, 2);
  // 088 adds `traceId` and `traceLink` to the entry when telemetry is on (test/runtime/trace-ids.test.js pins them); this pin is the pre-088 shape.
  const { traceId, traceLink, ...resumeEntry } = run.history.at(-1);
  assert.deepEqual(resumeEntry, {
    at: LATER.toISOString(), action: 'resume', by: 'orchestrator', reason: null, digest: asked.digest, epoch: 2, cleared: [],
  });
  assert.equal(fs.existsSync(summaryPath), true, 'resume reports stale context and never moves it (DEC-010)');

  // DEC-007: the old epoch is now resume-required; the new one claims.
  const old = claimAs(p, 'A.2', { epoch: 1 });
  assert.deepEqual([old.disposition, old.reason, old.epoch], ['refused', 'resume-required', 2]);
  assert.equal(claimAs(p, 'A.2', { epoch: 2 }).disposition, 'claimed');
});

test('an acknowledgement against a stale digest is refused report-changed and writes nothing', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  claimAs(p, 'A.1', { epoch: 1 });
  const asked = resume({ ...p.common(), gitRunner: gitStub() });
  fs.writeFileSync(path.join(p.dir, 'a.js'), '// edited after the report\n');
  const before = p.bytes();
  const answer = resume({ ...p.common(), ack: asked.digest, by: 'orchestrator', gitRunner: gitStub() });
  assert.equal(answer.disposition, 'refused');
  assert.equal(answer.reason, 'report-changed');
  assert.notEqual(answer.digest, asked.digest);
  assert.deepEqual(answer.report.changedSources, [{ taskId: 'A.1', token: 1, file: 'a.js', change: 'changed' }]);
  assert.deepEqual(p.bytes(), before, 'a refused resume writes nothing');
});

test('with no run the report has control none and epoch null; the acknowledged resume creates it at epoch 1', (t) => {
  const p = project(t);
  const asked = resume({ ...p.common(), gitRunner: gitStub() });
  assert.equal(p.bytes(), null, 'no ledger is created by the report');
  assert.deepEqual([asked.report.control, asked.report.epoch, asked.report.graph.recorded], ['none', null, null]);
  const resumed = resume({ ...p.common(), ack: asked.digest, by: 'orchestrator', reason: 'first session', gitRunner: gitStub() });
  assert.deepEqual([resumed.disposition, resumed.epoch], ['resumed', 1]);
  const run = p.read().runs[p.key().runKey];
  assert.deepEqual([run.control, run.epoch, run.history.length, run.history[0].reason], ['running', 1, 1, 'first session']);
  assert.match(run.graphDigest, /^sha256:/);
});

// ── stale context: detached HEAD ─────────────────────────────────────────────────────────────────

test('a detached HEAD compares the recorded commit with the current one (real git)', (t) => {
  const p = project(t, { git: false });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: p.dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(p.dir, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '-q');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD');
  git('add', 'b.js');
  git('commit', '-q', '-m', 'two');
  const second = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', second);

  const summaryPath = p.summary({ summary_id: 'S1', commit: first });
  const stale = resume(p.common()).report.staleContext;
  assert.deepEqual(stale, [{ kind: 'summary', path: summaryPath, reasons: ['commit-differs'] }]);
  p.summary({ summary_id: 'S1', commit: second });
  assert.deepEqual(resume(p.common()).report.staleContext, [], 'the same commit is not stale');
  p.summary({ summary_id: 'S1' });
  assert.deepEqual(resume(p.common()).report.staleContext[0].reasons, ['branch-unknown'], 'no recorded branch or commit');
});

// ── done tasks apart, unverifiable per task (critic A m3) ───────────────────────────────────────

test('a done task\'s changed file goes to doneChanged, an unfinished one\'s to changedSources, opaque entries count per task', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  claimAs(p, 'A.1', { epoch: 1 });
  claimAs(p, 'A.2', { epoch: 1 });
  // A.1 done: a COMPLETED attempt written as finish would (the evidence path is 070's, tested there).
  const store = p.read();
  Object.assign(store.tasks['A.1'].attempts[0], { state: 'finished', result: 'COMPLETED' });
  fs.writeFileSync(p.file, JSON.stringify(store, null, 2));
  fs.writeFileSync(path.join(p.dir, 'a.js'), '// edited\n');
  fs.rmSync(path.join(p.dir, 'b.js'));
  const r = resume({ ...p.common(), gitRunner: gitStub() }).report;
  assert.deepEqual(r.doneChanged, [{ taskId: 'A.1', token: 1, file: 'a.js', change: 'changed' }]);
  assert.deepEqual(r.changedSources, []);
  assert.deepEqual(r.unverifiable, [{ taskId: 'A.2', token: 1, count: 1 }], 'the glob makes A.2 unverifiable, counted once');

  // Without the glob, A.2's removal is a changedSources row.
  const q = project(t, { plan: planText({ lines: DEFAULT_LINES.map((l) => l.replace(', src/*.js', '')) }) });
  start({ ...q.common(), by: 'orchestrator' });
  claimAs(q, 'A.2', { epoch: 1 });
  fs.rmSync(path.join(q.dir, 'b.js'));
  assert.deepEqual(resume({ ...q.common(), gitRunner: gitStub() }).report.changedSources, [{ taskId: 'A.2', token: 1, file: 'b.js', change: 'removed' }]);
});

test('an attempt with no recorded sources, or whose execution worktree is gone, is unverifiable', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  const exec = tempDir(t, 'doflow-task-run-resume-exec-');
  fs.writeFileSync(path.join(exec, 'a.js'), 'x\n');
  claimAs(p, 'A.1', { epoch: 1, execWorktree: exec });
  const store = p.read();
  store.tasks['B.1'] = { nextToken: 2, attempts: [{ token: 1, owner: 'o', mode: 'manual', startedAt: NOW.toISOString(), taskLineHash: 'sha256:x', state: 'released', result: null, evidenceId: null, reason: 'r' }] };
  fs.writeFileSync(p.file, JSON.stringify(store, null, 2));
  fs.rmSync(exec, { recursive: true, force: true });
  assert.deepEqual(resume({ ...p.common(), gitRunner: gitStub() }).report.unverifiable, [
    { taskId: 'A.1', token: 1, count: 1 },
    { taskId: 'B.1', token: 1, count: 1 },
  ]);
});

// ── the digest ───────────────────────────────────────────────────────────────────────────────────

test('ageSeconds is excluded from the digest: an acknowledgement minutes later still resumes', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  claimAs(p, 'A.1', { epoch: 1 });
  const asked = resume({ ...p.common({}, NOW), gitRunner: gitStub() });
  assert.equal(asked.report.activeAttempts[0].ageSeconds, 0);
  const later = resume({ ...p.common({}, LATER), ack: asked.digest, by: 'orchestrator', gitRunner: gitStub() });
  assert.equal(later.disposition, 'resumed');
  assert.equal(later.report.activeAttempts[0].ageSeconds, 300);
  assert.equal(resumeDigest(later.report), asked.digest);
});

test('the graph comparison names added, removed and changed task ids against the recorded tuples', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  const lines = [
    '### Phase A', '',
    '- [ ] A.1 first task; owner: core-implementer; files: a.js, d.js',
    '- [ ] A.3 new task; owner: core-implementer; files: b.js',
    '', '### Phase B', '',
    '- [ ] B.1 later task, reworded; owner: core-implementer; files: c.js',
  ];
  fs.writeFileSync(p.planFile, planText({ lines }));
  const g = resume({ ...p.common(), gitRunner: gitStub() }).report.graph;
  assert.equal(g.changed, true);
  assert.notEqual(g.recorded, g.current);
  assert.deepEqual([g.added, g.removed, g.changedIds], [['A.3'], ['A.2'], ['A.1']], 'a description change is not a structural change');
});

// ── cleared cancels (IC-005 row 4) ───────────────────────────────────────────────────────────────

test('an acknowledged resume clears its own run\'s cancels, and only its own', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  claimAs(p, 'A.1', { epoch: 1 });
  cancel({ ...p.common(), by: 'orchestrator', reason: 'stop' });
  // Another run's cancelled attempt on A.2, cancelled at the same instant.
  const store = p.read();
  store.tasks['A.2'] = { nextToken: 2, attempts: [{
    token: 1, owner: 'o', mode: 'manual', startedAt: NOW.toISOString(), taskLineHash: 'sha256:x', state: 'cancelled',
    result: null, evidenceId: null, reason: null, runKey: 'other/r9/L9', cancel: { at: NOW.toISOString(), by: 'x', reason: 'y' },
  }] };
  fs.writeFileSync(p.file, JSON.stringify(store, null, 2));
  const state = (id) => status(p.common()).tasks.find((x) => x.id === id).state;
  assert.equal(state('A.1'), 'CANCELLED');
  assert.equal(claimAs(p, 'A.1', { epoch: 1 }).reason, 'run-cancelled');

  const asked = resume({ ...p.common(), gitRunner: gitStub() });
  assert.equal(asked.report.control, 'cancelled');
  const resumed = resume({ ...p.common(), ack: asked.digest, by: 'orchestrator', gitRunner: gitStub() });
  assert.deepEqual(p.read().runs[p.key().runKey].history.at(-1).cleared, [{ taskId: 'A.1', token: 1 }]);
  assert.equal(state('A.1'), 'READY', 'cleared in the same instant it was cancelled');
  assert.equal(state('A.2'), 'CANCELLED', 'another run\'s cancel is not cleared');
  assert.equal(claimAs(p, 'A.1', { epoch: resumed.epoch }).disposition, 'claimed');
});

// ── refusals and flags ───────────────────────────────────────────────────────────────────────────

test('resume refuses a solo lineage always and a worker in a graph plan, before any probe', (t) => {
  const p = project(t);
  let probed = 0;
  const runner = (...args) => { probed += 1; return gitStub()(...args); };
  assert.equal(resume({ ...p.common({ lineage: 'solo' }), gitRunner: runner }).reason, 'identity-solo');
  assert.equal(resume({ ...p.common({ role: 'worker' }), gitRunner: runner }).reason, 'worker-session');
  assert.equal(probed, 0, 'no probe runs for a refused identity');
  const legacy = project(t, { plan: planText({ header: false }) });
  assert.equal(resume({ ...legacy.common({ role: 'worker' }), gitRunner: gitStub() }).disposition, 'ack-required');
});

test('a malformed --ack, an ack without --by and an empty --reason are usage errors', (t) => {
  const p = project(t);
  const code = (fn) => { try { fn(); return null; } catch (e) { assert.ok(e instanceof TaskAttemptError); return e.code; } };
  assert.equal(code(() => resume({ ...p.common(), ack: 'sha256:abc', by: 'o' })), 'usage');
  assert.equal(code(() => resume({ ...p.common(), ack: `sha256:${'0'.repeat(64)}` })), 'usage');
  assert.equal(code(() => resume({ ...p.common(), reason: '  ' })), 'usage');
});

// ── lazy loading (IC-022) ────────────────────────────────────────────────────────────────────────

test('status and claim do not load summary-store.ts; resume does', (t) => {
  const p = project(t, { plan: planText({ header: false }) });
  const script = `
    const ta = require(${JSON.stringify(path.join(REPO, 'src/runtime/task-attempts.ts'))});
    const fs = require('node:fs');
    const loaded = () => Object.keys(require.cache).some((k) => k.endsWith('summary-store.ts'));
    const common = { file: ${JSON.stringify(p.file)}, fsImpl: fs, roots: [${JSON.stringify(p.dir)}], slug: ${JSON.stringify(SLUG)}, cwd: ${JSON.stringify(p.dir)} };
    ta.status(common);
    const c = ta.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'manual' });
    const before = loaded();
    ta.resume({ ...common, gitRunner: () => null });
    console.log(JSON.stringify({ claimed: c.disposition, before, after: loaded() }));
  `;
  const env = { PATH: process.env.PATH, HOME: p.dir, XDG_CONFIG_HOME: path.join(p.dir, 'xdg'), DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: p.dir };
  if (process.env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: p.dir, env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), { claimed: 'claimed', before: false, after: true });
});
