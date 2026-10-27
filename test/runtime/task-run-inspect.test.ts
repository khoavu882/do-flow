'use strict';

// Feature 080 D.4 (IC-016, IC-009 `totalsMismatch`; critic B m2, m4, m6): `inspect` reports the
// graph with its warnings and overlaps, every task's derived state and budget, the caller's run
// with recomputed totals, and a decomposition advisory. It reads with `readTaskState`, takes no
// lock, writes nothing and runs no process.
//
// In-process against temp projects; every call passes an explicit identity environment.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { claim, finish, release, start, pause, inspect } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, formatInspect } = require('../../src/runtime/task-run.ts');

const SLUG = 'feat-i';
const NOW: any = new Date('2026-01-04T00:00:00.000Z');
const HEADER = '**Task graph:** v1';

const GRAPH_LINES: any = [
  '### Phase A', '',
  '- [ ] A.1 [P] first; owner: core-implementer; files: a.js, ./shared.js; budget: attempts=3',
  '- [ ] A.2 [P] second; owner: core-implementer; files: b.js, shared.js',
  '', '### Phase B', '',
  '- [ ] B.1 later; owner: core-implementer; files: c.js; depends-on: A.1',
];

function planText({ header = true, lines = GRAPH_LINES }: any = {}) {
  return ['# Plan', '', ...(header ? [HEADER, ''] : []), '## Tasks', '', ...lines, ''].join('\n');
}

function project(t: any, { plan = planText() }: any = {}) {
  const dir = tempDir(t, 'doflow-task-run-inspect-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  for (const f of ['a.js', 'b.js', 'c.js', 'shared.js']) fs.writeFileSync(path.join(dir, f), `// ${f}\n`);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const env: any = {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'xdg'),
  };
  const common: any = { file, fsImpl: fs, roots: [dir], slug: SLUG, now: NOW, env, cwd: dir };
  const key = runKeyFor(env, dir).runKey;
  return { dir, file, common, key, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const take = (p: any, task: any, extra: any = {}) => claim({ ...p.common, task, owner: 'core-implementer', mode: 'subagent', ...extra });

test('a header-less plan reports its near-miss dependency as a warning, legacy budgets as defaults', (t) => {
  const p = project(t, { plan: planText({ header: false, lines: ['### Phase A', '', '- [ ] A.1 one', '- [ ] A.2 two; depends-on: A.1 (after review)'] }) });
  const view = inspect(p.common);
  assert.equal(view.graph.graphPlan, false);
  assert.deepEqual(view.graph.warnings, [{ kind: 'near-miss-dependency', ids: ['A.2'], value: 'A.1 (after review)' }]);
  assert.equal(view.revision, 0);
  assert.equal(view.run.exists, false);
  assert.equal(view.run.control, 'none');
  assert.equal(view.run.epoch, null);
  assert.deepEqual(view.run.budget, { attempts: 40, tokens: null, source: 'default' });
  assert.deepEqual(view.run.history, []);
  assert.equal(view.run.totalsMismatch, false);
  assert.deepEqual(view.defaults, { runAttempts: true, tasks: ['A.1', 'A.2'] });
  assert.equal(fs.existsSync(p.file), false, 'inspect creates no ledger');
  const text = formatInspect(view);
  assert.match(text[0], /^DEFAULT BUDGETS: run attempt limit; task limits of A\.1, A\.2/);
  assert.ok(text.some((l: any) => l === "Warning: near-miss-dependency A.2 'A.1 (after review)'"));
  assert.ok(text.includes('  A.1 READY ready budget 0/20 (default)'));
});

test('the graph view carries files, [P], dependencies, overlaps and the decomposition advisory', (t) => {
  const p = project(t);
  const view = inspect(p.common);
  assert.equal(view.graph.graphPlan, true);
  assert.match(view.graph.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(view.graph.tasks, [
    { id: 'A.1', phase: 'A', owner: 'core-implementer', taskDeps: [], parallel: true, acceptance: [], files: ['a.js', './shared.js'] },
    { id: 'A.2', phase: 'A', owner: 'core-implementer', taskDeps: [], parallel: true, acceptance: [], files: ['b.js', 'shared.js'] },
    { id: 'B.1', phase: 'B', owner: 'core-implementer', taskDeps: ['A.1'], parallel: false, acceptance: [], files: ['c.js'] },
  ]);
  assert.deepEqual(view.graph.overlaps, [{ a: 'A.1', b: 'A.2', files: ['shared.js'] }]);
  assert.deepEqual(view.advisory.decomposition, {
    advisoryOnly: true,
    phases: [{ phase: 'A', tasks: 2, parallel: 2 }, { phase: 'B', tasks: 1, parallel: 0 }],
    maxTasksPerPhase: 2, maxParallelFanOut: 2,
  });
  assert.deepEqual(view.tasks.map((r: any) => [r.id, r.state, r.reason, r.budget]), [
    ['A.1', 'READY', 'ready', { limit: 3, used: 0, source: 'plan' }],
    ['A.2', 'READY', 'ready', { limit: 20, used: 0, source: 'default' }],
    ['B.1', 'PLANNED', 'unmet-dependency', { limit: 20, used: 0, source: 'default' }],
  ]);
  assert.deepEqual(view.defaults, { runAttempts: true, tasks: ['A.2', 'B.1'] });
  const text = formatInspect(view);
  assert.ok(text.includes('  A.1 READY ready budget 0/3'));
  assert.ok(text.includes('  B.1 PLANNED unmet-dependency budget 0/20 (default)'));
  assert.ok(text.includes('Overlap: A.1 and A.2 both declare shared.js'));
  assert.ok(text.includes('Advisory (decomposition): A 2 tasks, 2 [P]; B 1 task, 0 [P]'));
});

test('the run view: control, epoch, history, limits by source and totals by basis, with no summed figure', (t) => {
  const p = project(t);
  start({ ...p.common, by: 'orchestrator', budgetAttempts: 10, budgetTokens: 1000 });
  assert.equal(take(p, 'A.1', { epoch: 1, reserveTokens: 100 }).disposition, 'claimed');
  assert.equal(finish({ ...p.common, task: 'A.1', token: 1, result: 'BLOCKED', tokens: 70, basis: 'measured' }).disposition, 'applied');
  assert.equal(take(p, 'A.2', { epoch: 1, reserveTokens: 50 }).disposition, 'claimed');
  assert.equal(release({ ...p.common, task: 'A.2', token: 1, reason: 'r', tokens: 30, basis: 'estimated' }).disposition, 'released');
  assert.equal(take(p, 'A.2', { epoch: 1, reserveTokens: 25 }).disposition, 'claimed');
  pause({ ...p.common, by: 'orchestrator', reason: 'stop' });

  const view = inspect(p.common);
  const r = view.run;
  assert.equal(r.runKey, p.key);
  assert.equal(r.exists, true);
  assert.equal(r.control, 'paused');
  assert.equal(r.epoch, 1);
  assert.deepEqual(r.budget, { attempts: 10, tokens: 1000, source: 'run' });
  assert.deepEqual(r.totals, { attempts: 3, tokens: { measured: 70, estimated: 30, reserved: 25 }, unreported: 0 });
  assert.equal(r.totalsMismatch, false);
  assert.equal('storedTotals' in r, false);
  assert.deepEqual(r.history.map((h: any) => h.action), ['start', 'pause']);
  assert.equal(view.defaults.runAttempts, false);
  const a2 = view.tasks.find((x: any) => x.id === 'A.2');
  assert.deepEqual([a2.state, a2.reason, a2.budget.used], ['RUNNING', 'active-attempt', 2]);

  const text = formatInspect(view).join('\n');
  assert.match(text, /control paused, epoch 1/);
  assert.match(text, /limits: attempts 10 \(run\), tokens 1000 \(run\)/);
  assert.match(text, /tokens measured 70, estimated 30, reserved 25/);
  assert.doesNotMatch(text, /\b100\b/, 'measured plus estimated is never printed as one figure');
  assert.doesNotMatch(text, /\b125\b/);
});

test('a tampered stored totals sets totalsMismatch; the reported totals are recomputed', (t) => {
  const p = project(t);
  start({ ...p.common, by: 'orchestrator' });
  take(p, 'A.1', { epoch: 1 });
  const ledger = p.read();
  const honest = ledger.runs[p.key].totals;
  ledger.runs[p.key].totals = { ...honest, attempts: 99 };
  fs.writeFileSync(p.file, JSON.stringify(ledger, null, 2));

  const view = inspect(p.common);
  assert.equal(view.run.totalsMismatch, true);
  assert.deepEqual(view.run.totals, honest);
  assert.equal(view.run.storedTotals.attempts, 99);
  assert.ok(formatInspect(view).some((l: any) => /totals mismatch/.test(l)));
});

test('inspect leaves the ledger byte-identical, takes no lock and runs no process', (t): any => {
  const p = project(t);
  start({ ...p.common, by: 'orchestrator' });
  take(p, 'A.1', { epoch: 1 });
  const dir = path.dirname(p.file);
  const before = fs.readFileSync(p.file);
  const mtime = fs.statSync(p.file).mtimeMs;
  const listing = fs.readdirSync(dir).sort();

  const spawned: any = [];
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    t.mock.method(childProcess, name, (...args: any[]) => { spawned.push([name, args[0]]); throw new Error('no process'); });
  }
  const touched: any = [];
  for (const name of ['openSync', 'mkdirSync', 'rmdirSync', 'writeFileSync', 'renameSync', 'rmSync', 'unlinkSync']) {
    const real = fs[name];
    t.mock.method(fs, name, (...args: any[]) => {
      if (name !== 'openSync' || (args[1] !== undefined && args[1] !== 'r')) touched.push([name, String(args[0])]);
      return real.apply(fs, args);
    });
  }
  const view = inspect(p.common);
  t.mock.restoreAll();

  assert.equal(view.run.exists, true);
  assert.deepEqual(spawned, []);
  assert.deepEqual(touched, [], 'no lock directory, no write, no rename');
  assert.deepEqual(fs.readFileSync(p.file), before);
  assert.equal(fs.statSync(p.file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);
});
