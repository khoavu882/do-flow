'use strict';

// Feature 080 C.2 (IC-004 recorded graph, IC-006 steps 2, 6, 7, 8 and the aggregate half of 12,
// IC-009, IC-010 run fields, IC-021 test-only seam, IC-025, IC-026; DEC-006, DEC-007, DEC-011):
// claim checks the caller's run and records it on the attempt and the run record.
//
// In-process against hand-seeded ledgers. Every claim passes an explicit identity environment, so
// the developer's shell never decides a run key; each project directory holds a `.git` so it is a
// worktree top of its own.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { claim, TaskAttemptError } = require('../../src/runtime/task-attempts.ts');
const { measureSources, compareSources } = require('../../src/runtime/task-sources.ts');
const { runKeyFor, createRun, epochRefusal, clearedCancels } = require('../../src/runtime/task-run.ts');
const { graphDigest, graphTuples, buildGraph } = require('../../src/runtime/task-graph.ts');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');

const SLUG = 'feat-r';
const NOW = new Date('2026-01-02T00:00:00.000Z');
const HEADER = '**Task graph:** v1';
const MODULE = path.resolve(__dirname, '../../src/runtime/task-attempts.ts');

function planText({ header = true, tasks = null } = {}) {
  const lines = tasks || [
    '- [ ] A.1 first task; owner: core-implementer; files: a.js',
    '- [ ] A.2 second task; owner: core-implementer; files: b.js',
  ];
  return ['# Plan', '', ...(header ? [HEADER, ''] : []), '## Tasks', '', '### Phase A', '', ...lines, ''].join('\n');
}

function identityEnv(worktree, { run = 'r1', lineage = 'main', role = 'main' } = {}) {
  return {
    DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: lineage, DOFLOW_SESSION_ROLE: role, DOFLOW_ROLE: role,
    DOFLOW_WORKTREE: worktree, HOME: worktree,
  };
}

function project(t, plan, who = {}) {
  const dir = tempDir(t, 'doflow-task-attempts-run-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const env = identityEnv(dir, who);
  const key = runKeyFor(env, dir);
  const common = { file, fsImpl: fs, roots: [dir], slug: SLUG, now: NOW, env, cwd: dir };
  const seed = ({ runs, tasks = {} } = {}) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 1, planPath: null, tasks, ...(runs ? { runs } : {}) }, null, 2));
  };
  /** A run record for this project's key, as start would leave it. */
  const runRecord = (fields = {}) => ({ ...createRun(key, fields.budget || null, NOW, { epoch: 1 }), ...fields });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const take = (task, extra = {}) => claim({ ...common, task, owner: 'core-implementer', mode: 'subagent', ...extra });
  return { dir, file, env, key, common, seed, runRecord, read, take };
}

const unchanged = (p, run) => {
  const before = fs.readFileSync(p.file);
  const answer = run();
  assert.deepEqual(fs.readFileSync(p.file), before, 'a refusal writes nothing');
  return answer;
};

// ── step 7: run control ─────────────────────────────────────────────────────────────────────────

test('a paused or cancelled run refuses the claim with its run key, before the epoch check', (t) => {
  const p = project(t, planText());
  for (const control of ['paused', 'cancelled']) {
    p.seed({ runs: { [p.key.runKey]: p.runRecord({ control }) } });
    const reason = `run-${control === 'paused' ? 'paused' : 'cancelled'}`;
    // No --epoch: step 8 would say resume-required, so this pins step 7 before step 8.
    assert.deepEqual(unchanged(p, () => p.take('A.1')), { disposition: 'refused', taskId: 'A.1', reason, runKey: p.key.runKey });
    assert.deepEqual(unchanged(p, () => p.take('A.1', { epoch: 1 })).reason, reason);
  }
  // A legacy plan honours the control too.
  const legacy = project(t, planText({ header: false }));
  legacy.seed({ runs: { [legacy.key.runKey]: legacy.runRecord({ control: 'paused' }) } });
  assert.equal(unchanged(legacy, () => legacy.take('A.1')).reason, 'run-paused');
});

// ── step 8: epoch ───────────────────────────────────────────────────────────────────────────────

test('a graph-plan claim with no run, no epoch or an old epoch is resume-required', (t) => {
  const p = project(t, planText());
  p.seed();
  assert.deepEqual(unchanged(p, () => p.take('A.1', { epoch: 1 })),
    { disposition: 'refused', taskId: 'A.1', reason: 'resume-required', runKey: p.key.runKey, epoch: null });
  p.seed({ runs: { [p.key.runKey]: p.runRecord({ epoch: 2 }) } });
  for (const epoch of [undefined, 1, 3]) {
    assert.deepEqual(unchanged(p, () => p.take('A.1', { epoch })),
      { disposition: 'refused', taskId: 'A.1', reason: 'resume-required', runKey: p.key.runKey, epoch: 2 }, `epoch ${epoch}`);
  }
  const claimed = p.take('A.1', { epoch: 2 });
  assert.deepEqual(claimed, {
    disposition: 'claimed', taskId: 'A.1', token: 1, revision: 2, runKey: p.key.runKey, epoch: 2, execWorktree: p.dir,
  });
  assert.equal(p.read().tasks['A.1'].attempts[0].epoch, 2);
  assert.throws(() => p.take('A.2', { epoch: -1 }), (e) => e instanceof TaskAttemptError && e.code === 'usage');
});

test('DEC-019 epoch-zero-never-matches: an epoch-0 run (as reopen or pause creates it) refuses claim({ epoch: 0 })', (t) => {
  const p = project(t, planText());
  p.seed({ runs: { [p.key.runKey]: p.runRecord({ epoch: 0 }) } });
  const before = fs.readFileSync(p.file);
  assert.throws(() => p.take('A.1', { epoch: 0 }), (e) => e instanceof TaskAttemptError && e.code === 'usage');
  assert.deepEqual(unchanged(p, () => p.take('A.1', { epoch: 1 })),
    { disposition: 'refused', taskId: 'A.1', reason: 'resume-required', runKey: p.key.runKey, epoch: 0 });
  assert.deepEqual(fs.readFileSync(p.file), before);
  const run0 = p.read().runs[p.key.runKey];
  assert.deepEqual(epochRefusal(run0, p.key.runKey, 0), { reason: 'resume-required', runKey: p.key.runKey, epoch: 0 });
});

test('a legacy plan accepts any --epoch, keeps the 8ce5ad7 result and creates its run record', (t) => {
  const p = project(t, planText({ header: false }));
  p.seed();
  for (const [task, epoch] of [['A.1', undefined], ['A.2', 7]]) {
    const revision = p.read().revision + 1;
    assert.deepEqual(p.take(task, { epoch }), { disposition: 'claimed', taskId: task, token: 1, revision });
  }
  const store = p.read();
  const run = store.runs[p.key.runKey];
  // Only start and an acknowledged resume issue an epoch (DEC-007); a claim-created run has none.
  assert.equal(run.epoch, 0);
  assert.deepEqual([run.control, run.worktree, run.run, run.lineage, run.history], ['running', p.dir, 'r1', 'main', []]);
  for (const id of ['A.1', 'A.2']) {
    const a = store.tasks[id].attempts[0];
    assert.deepEqual([a.runKey, a.epoch, a.execWorktree, 'reserve' in a], [p.key.runKey, 0, p.dir, false], id);
  }
  assert.deepEqual(run.totals, { attempts: 2, tokens: { measured: 0, estimated: 0, reserved: 0 }, unreported: 0 });
  assert.equal(Object.keys(store.runs).length, 1);
});

// ── step 6: workers (DEC-006) ───────────────────────────────────────────────────────────────────

test('a worker is refused in a graph plan and admitted in a legacy plan', (t) => {
  const g = project(t, planText(), { role: 'worker', lineage: 'w1' });
  g.seed({ runs: { [g.key.runKey]: g.runRecord() } });
  assert.deepEqual(unchanged(g, () => g.take('A.1', { epoch: 1 })), { disposition: 'refused', taskId: 'A.1', reason: 'worker-session' });
  const l = project(t, planText({ header: false }), { role: 'worker', lineage: 'w1' });
  l.seed();
  assert.equal(l.take('A.1').disposition, 'claimed');
});

// ── step 2: execution worktree (IC-026) ─────────────────────────────────────────────────────────

test('execWorktree defaults to the run worktree; a given path is lifted to its top; a missing one is usage', (t) => {
  const p = project(t, planText());
  p.seed({ runs: { [p.key.runKey]: p.runRecord() } });
  assert.equal(p.take('A.1', { epoch: 1 }).execWorktree, p.dir);
  assert.equal(p.read().tasks['A.1'].attempts[0].execWorktree, p.dir);

  const other = tempDir(t, 'doflow-task-attempts-run-wt-');
  fs.mkdirSync(path.join(other, '.git'));
  fs.mkdirSync(path.join(other, 'src', 'deep'), { recursive: true });
  const relative = path.relative(p.dir, path.join(other, 'src', 'deep'));
  const claimed = p.take('A.2', { epoch: 1, execWorktree: relative });
  assert.equal(claimed.execWorktree, other);
  assert.equal(p.read().tasks['A.2'].attempts[0].execWorktree, other);

  const before = fs.readFileSync(p.file);
  assert.throws(() => p.take('A.2', { epoch: 1, execWorktree: path.join(other, 'nope') }),
    (e) => e instanceof TaskAttemptError && e.code === 'usage' && /does not exist/.test(e.message));
  assert.deepEqual(fs.readFileSync(p.file), before);
});

// ── recorded graph (IC-004) and the mode as declared (FR-006) ───────────────────────────────────

// ── IC-005 row 4: a cancel is cleared only by a resume that lists it (FU-82p04v) ────────────────

test('a cancel stamped earlier than a resume is not cleared by the clock; only the resume that lists it clears it', (t) => {
  const p = project(t, planText());
  const cancelled = (token, at) => ({
    token, state: 'cancelled', runKey: p.key.runKey, startedAt: '2026-01-01T00:00:00.000Z', cancel: { at, by: 'lead', reason: 'x' },
  });
  // The resume entry is stamped 12:00; both cancels happened after it in ledger order, but the
  // second was written by a host whose clock was behind (stamp 09:00 < 12:00).
  const resume = { at: '2026-01-02T12:00:00.000Z', action: 'resume', by: 'lead', reason: null, digest: 'd', epoch: 2, cleared: [{ taskId: 'A.1', token: 1 }] };
  const store = {
    version: 1, revision: 1, planPath: null,
    tasks: {
      'A.1': { nextToken: 2, attempts: [cancelled(1, '2026-01-02T09:00:00.000Z')] },
      'A.2': { nextToken: 2, attempts: [cancelled(1, '2026-01-02T09:00:00.000Z')] },
    },
    runs: { [p.key.runKey]: { ...p.runRecord({ epoch: 2 }), history: [resume] } },
  };
  assert.deepEqual(clearedCancels(store).map((c) => `${c.taskId}#${c.token}`), ['A.1#1'], 'only the listed attempt is cleared');
  // Control: the same store with A.2 listed clears both, so the listing is what decides.
  store.runs[p.key.runKey].history[0].cleared.push({ taskId: 'A.2', token: 1 });
  assert.deepEqual(clearedCancels(store).map((c) => `${c.taskId}#${c.token}`).sort(), ['A.1#1', 'A.2#1']);
});

// ── IC-013: a file absent in the execution worktree reads removed (FU-ev7r3g) ───────────────────

test('a declared file absent in the execution worktree reads absent even when the main copy exists', (t) => {
  const p = project(t, planText());
  const exec = tempDir(t, 'doflow-task-sources-exec-');
  fs.writeFileSync(path.join(p.dir, 'a.js'), 'main\n');
  fs.writeFileSync(path.join(exec, 'a.js'), 'worktree\n');
  const before = measureSources({ files: ['a.js'] }, exec, [p.dir]);
  assert.equal(before.sources[0].kind, 'file');
  assert.equal(before.execWorktreeMissing, false);
  fs.rmSync(path.join(exec, 'a.js'));
  const after = measureSources({ files: ['a.js'] }, exec, [p.dir]);
  assert.deepEqual(after.sources[0], { file: 'a.js', kind: 'absent', fileHash: null }, 'the main copy is not consulted');
  assert.deepEqual(compareSources(before, after), { unverifiable: false, files: [{ file: 'a.js', change: 'removed' }] });
  // Control: with no execution worktree the plan roots still resolve the file.
  assert.equal(measureSources({ files: ['a.js'] }, null, [p.dir]).sources[0].kind, 'file');
  // Control: a missing execution worktree keeps measuring the roots and flags the task.
  const gone = measureSources({ files: ['a.js'] }, path.join(exec, 'gone'), [p.dir]);
  assert.deepEqual([gone.execWorktreeMissing, gone.sources[0].kind], [true, 'file']);
});

test('graphTasks is stored at 500 tasks and null with graphTruncated at 501', (t) => {
  for (const n of [500, 501]) {
    const tasks = Array.from({ length: n }, (_, i) => `- [ ] A.${i + 1} task ${i + 1}; owner: core-implementer; files: f${i + 1}.js`);
    const text = planText({ tasks });
    const p = project(t, text);
    p.seed({ runs: { [p.key.runKey]: p.runRecord() } });
    assert.equal(p.take('A.1', { epoch: 1 }).disposition, 'claimed', `${n}`);
    const run = p.read().runs[p.key.runKey];
    assert.equal(run.graphDigest, graphDigest(buildGraph(parsePlan(text)).graph), `${n}`);
    if (n === 500) {
      assert.equal(run.graphTasks.length, 500);
      assert.deepEqual(run.graphTasks, graphTuples(buildGraph(parsePlan(text)).graph));
      assert.equal(run.graphTasks[0][0], 'A.1');
      assert.equal('graphTruncated' in run, false);
    } else {
      assert.deepEqual([run.graphTasks, run.graphTruncated], [null, true]);
    }
  }
});

test('the three modes are stored exactly as stated', (t) => {
  const p = project(t, planText({ tasks: ['- [ ] A.1 a', '- [ ] A.2 b', '- [ ] A.3 c'] }));
  p.seed({ runs: { [p.key.runKey]: p.runRecord() } });
  const modes = { 'A.1': 'manual', 'A.2': 'sequential', 'A.3': 'subagent' };
  for (const [task, mode] of Object.entries(modes)) {
    assert.equal(claim({ ...p.common, task, owner: 'core-implementer', mode, epoch: 1 }).disposition, 'claimed');
  }
  const store = p.read();
  assert.deepEqual(Object.fromEntries(Object.keys(modes).map((id) => [id, store.tasks[id].attempts[0].mode])), modes);
});

// ── step 12, aggregate half (IC-009, DEC-011) ───────────────────────────────────────────────────

test('a run token limit needs a reservation; the reservation is recorded and counted in totals', (t) => {
  const p = project(t, planText());
  p.seed({ runs: { [p.key.runKey]: p.runRecord({ budget: { attempts: null, tokens: 1000 } }) } });
  assert.deepEqual(unchanged(p, () => p.take('A.1', { epoch: 1 })),
    { disposition: 'refused', taskId: 'A.1', reason: 'reservation-required', limit: 1000 });
  assert.equal(unchanged(p, () => p.take('A.1', { epoch: 1, reserveTokens: 1001 })).reason, 'aggregate-exhausted');
  assert.equal(p.take('A.1', { epoch: 1, reserveTokens: 600 }).disposition, 'claimed');
  const store = p.read();
  assert.deepEqual(store.tasks['A.1'].attempts[0].reserve, { tokens: 600 });
  assert.deepEqual(store.runs[p.key.runKey].totals, { attempts: 1, tokens: { measured: 0, estimated: 0, reserved: 600 }, unreported: 0 });
  const full = unchanged(p, () => p.take('A.2', { epoch: 1, reserveTokens: 500 }));
  assert.deepEqual([full.reason, full.scope, full.measure, full.reserved], ['aggregate-exhausted', 'run', 'tokens', 600]);
  assert.throws(() => p.take('A.2', { epoch: 1, reserveTokens: 1.5 }), (e) => e instanceof TaskAttemptError && e.code === 'usage');
});

test('the run attempt limit refuses aggregate-exhausted in a legacy plan too', (t) => {
  const p = project(t, planText({ header: false }));
  const run = p.runRecord({ budget: { attempts: 1, tokens: null } });
  p.seed({ runs: { [p.key.runKey]: run }, tasks: { 'A.2': { nextToken: 2, attempts: [{
    token: 1, owner: 'core-implementer', mode: 'subagent', startedAt: NOW.toISOString(), taskLineHash: 'x',
    state: 'released', result: null, evidenceId: null, reason: 'r', runKey: p.key.runKey, usage: { tokens: 0, basis: 'measured', reporter: 'main:main' },
  }] } } });
  const refused = unchanged(p, () => p.take('A.1'));
  assert.deepEqual([refused.reason, refused.scope, refused.measure, refused.limit, refused.used], ['aggregate-exhausted', 'run', 'attempts', 1, 1]);
});

// ── IC-021 test-only seam ───────────────────────────────────────────────────────────────────────

/** A child claiming A.1 that prints `go` just before its claim, then prints the answer. */
function childClaim(p, options) {
  const script = `
    const { claim } = require(${JSON.stringify(MODULE)});
    const fs = require('node:fs');
    process.stdout.write('go\\n');
    const answer = claim({ file: ${JSON.stringify(p.file)}, fsImpl: fs, roots: [${JSON.stringify(p.dir)}], slug: ${JSON.stringify(SLUG)},
      task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, env: ${JSON.stringify(p.env)}, cwd: ${JSON.stringify(p.dir)},
      ...${JSON.stringify(options)} });
    process.stdout.write(JSON.stringify(answer) + '\\n');`;
  const child = spawn(process.execPath, ['-e', script], { env: { ...p.env, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  const started = new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('go\n')) resolve(); }));
  const done = new Promise((resolve) => child.on('close', () => resolve(JSON.parse(out.split('\n')[1]))));
  return { started, done };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the checkOutsideLock seam lets a claim checked before another one also claim; the locked claim does not', async (t) => {
  for (const seam of [true, false]) {
    const p = project(t, planText());
    p.seed({ runs: { [p.key.runKey]: p.runRecord() } });
    const child = childClaim(p, seam ? { checkOutsideLock: true, delayAfterCheckMs: 1500 } : {});
    await child.started;
    // The seamed child has checked and is waiting; the locked child has claimed or will block on us.
    await wait(300);
    const mine = p.take('A.1', { epoch: 1 });
    const theirs = await child.done;
    const dispositions = [mine.disposition, theirs.disposition].sort();
    const active = p.read().tasks['A.1'].attempts.filter((a) => a.state === 'active');
    if (seam) {
      assert.deepEqual(dispositions, ['claimed', 'claimed'], 'the seam must be able to produce two claims');
      assert.equal(active.length, 2);
    } else {
      assert.deepEqual(dispositions, ['claimed', 'refused']);
      assert.equal(active.length, 1);
    }
  }
});

test('the CLI handler never passes the seam', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  const handler = source.slice(source.indexOf('function handleTaskAttemptCommand'));
  assert.doesNotMatch(handler, /checkOutsideLock|delayAfterCheckMs/);
});
