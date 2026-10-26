'use strict';

// Row 093 B.2 (IC-013): every `tasks[]` entry of `task-attempt --action inspect` carries its
// attempt history as metadata only — token, owner, mode, state, startedAt, endedAt, result — in
// ledger order, after the keys it already had. No reason text, evidence id, worktree, usage or
// trace reaches the body, and every pre-existing key keeps its name, order and value.
//
// Row 093 E.5 (IC-018 c) appends `worktreeKey`, `run` and `lineage`, split from the attempt's stored
// `runKey`, after the IC-013 fields; they are null on a record with no `runKey`.
//
// In-process against a temp project; every call passes an explicit identity environment.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { claim, finish, release, start, cancel, inspect } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor } = require('../../src/runtime/task-run.ts');

const SLUG = 'feat-b2';
const NOW: any = new Date('2026-01-04T00:00:00.000Z');
const LATER: any = new Date('2026-01-04T00:05:00.000Z');
const MARKER = 'MARKER-b2-reason-7f3c';

const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 [P] first; owner: core-implementer; files: a.js',
  '- [ ] A.2 [P] second; owner: quality-guardian; files: b.js',
  '', '### Phase B', '',
  '- [ ] B.1 later; owner: core-implementer; files: c.js; depends-on: A.1',
  '',
].join('\n');

function project(t: any) {
  const dir = tempDir(t, 'doflow-task-attempt-inspect-attempts-');
  fs.mkdirSync(path.join(dir, '.git'));
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(dir, f), `// ${f}\n`);
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const env: any = {
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'xdg'),
  };
  const common: any = { file, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  return { dir, file, common, key: runKeyFor(env, dir).runKey };
}

/** One passing test-result evidence item for `taskId`; returns its id. */
function evidence(dir: string, taskId: string) {
  const ledger: any = new EvidenceLedger({ repoRoot: dir, slug: SLUG });
  const id = ledger.addEvidence({
    taskId, kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
    locator: { file: 'a.test.js' }, content: 'ran', observation: { command: 'node --test', exitCode: 0 },
  });
  ledger.save(taskId);
  return id;
}

/**
 * After `start`, A.1: claim, finish COMPLETED with evidence. A.2: claim, release with a reason carrying MARKER,
 * claim again (still active). B.1: untouched.
 */
function scenario(t: any) {
  const p = project(t);
  assert.equal(start({ ...p.common, by: 'orchestrator', now: NOW }).disposition, 'started');
  const take = (task: string, owner: string, mode: string, now: any) => {
    const answer = claim({ ...p.common, task, owner, mode, now, epoch: 1 });
    assert.equal(answer.disposition, 'claimed', JSON.stringify(answer));
    return answer.token;
  };
  const a1 = take('A.1', 'core-implementer', 'subagent', NOW);
  const evidenceId = evidence(p.dir, 'A.1');
  const done = finish({ ...p.common, task: 'A.1', token: a1, result: 'COMPLETED', evidenceId, now: LATER });
  assert.equal(done.disposition, 'applied', JSON.stringify(done));
  const a2 = take('A.2', 'quality-guardian', 'manual', NOW);
  const off = release({ ...p.common, task: 'A.2', token: a2, reason: `stuck on ${MARKER}`, now: LATER });
  assert.equal(off.disposition, 'released', JSON.stringify(off));
  take('A.2', 'quality-guardian', 'sequential', LATER);
  return { ...p, evidenceId, before: fs.readFileSync(p.file, 'utf8') };
}

const IC013_KEYS = ['token', 'owner', 'mode', 'state', 'startedAt', 'endedAt', 'result'];
const IC018C_KEYS = ['worktreeKey', 'run', 'lineage'];

/** The IC-018 c fields of an attempt claimed under `runKey`. */
function keyed(runKey: string) {
  const [worktreeKey, run, lineage] = runKey.split('/');
  return { worktreeKey, run, lineage };
}

test('each task lists its attempts in ledger order with exactly the IC-013 fields (IC-013)', (t) => {
  const s = scenario(t);
  const body = inspect(s.common);
  const byId = Object.fromEntries(body.tasks.map((r: any) => [r.id, r]));
  for (const row of body.tasks) {
    assert.ok(Array.isArray(row.attempts), `${row.id} has attempts[]`);
    assert.equal(Object.keys(row).at(-1), 'attempts', `${row.id}: attempts comes after the existing keys`);
    for (const a of row.attempts) assert.deepEqual(Object.keys(a), [...IC013_KEYS, ...IC018C_KEYS], `${row.id} token ${a.token}: field names and order`);
  }
  const k = keyed(s.key);
  assert.deepEqual(byId['A.1'].attempts, [
    { token: 1, owner: 'core-implementer', mode: 'subagent', state: 'finished', startedAt: NOW.toISOString(), endedAt: LATER.toISOString(), result: 'COMPLETED', ...k },
  ]);
  assert.deepEqual(byId['A.2'].attempts, [
    { token: 1, owner: 'quality-guardian', mode: 'manual', state: 'released', startedAt: NOW.toISOString(), endedAt: LATER.toISOString(), result: null, ...k },
    { token: 2, owner: 'quality-guardian', mode: 'sequential', state: 'active', startedAt: LATER.toISOString(), endedAt: null, result: null, ...k },
  ]);
  assert.deepEqual(byId['B.1'].attempts, []);
});

test('no reason text, evidence id, worktree, usage or trace reaches the body (IC-013, NFR-003)', (t) => {
  const s = scenario(t);
  const text = JSON.stringify(inspect(s.common));
  assert.ok(s.before.includes(MARKER), 'the ledger holds the release reason');
  assert.ok(s.before.includes(s.evidenceId), 'the ledger holds the evidence id');
  assert.ok(!text.includes(MARKER), 'the release reason is not in the inspect body');
  assert.ok(!text.includes(s.evidenceId), 'the evidence id is not in the inspect body');
  for (const a of inspect(s.common).tasks.flatMap((r: any) => r.attempts)) {
    for (const k of ['reason', 'evidenceId', 'execWorktree', 'usage', 'traceId', 'finishedBy', 'sources', 'reserve', 'runKey']) {
      assert.ok(!(k in a), `attempt carries no ${k}`);
    }
  }
});

test('a cancelled attempt ends at its cancel time; the cancel reason stays out (IC-013 ruling)', (t) => {
  const p = project(t);
  assert.equal(start({ ...p.common, by: 'orchestrator', now: NOW }).disposition, 'started');
  const token = claim({ ...p.common, task: 'A.2', owner: 'quality-guardian', mode: 'subagent', now: NOW, epoch: 1 }).token;
  const off = cancel({ ...p.common, task: 'A.2', token, by: 'orchestrator', reason: `halt ${MARKER}`, now: LATER });
  assert.equal(off.disposition, 'cancelled', JSON.stringify(off));
  const body = inspect(p.common);
  assert.deepEqual(body.tasks.find((r: any) => r.id === 'A.2').attempts, [
    { token: 1, owner: 'quality-guardian', mode: 'subagent', state: 'cancelled', startedAt: NOW.toISOString(), endedAt: LATER.toISOString(), result: null, ...keyed(p.key) },
  ]);
  const attempts = JSON.stringify(body.tasks.map((r: any) => r.attempts));
  assert.ok(!attempts.includes(MARKER), 'the cancel reason is not in attempts[]');
});

test('inspect stays read-only and every pre-existing key keeps its name, order and value (IC-013)', (t) => {
  const s = scenario(t);
  const body = inspect(s.common);
  assert.equal(fs.readFileSync(s.file, 'utf8'), s.before, 'inspect wrote nothing');
  const without = { ...body, tasks: body.tasks.map(({ attempts, ...rest }: any) => rest) };
  const shape = JSON.parse(JSON.stringify(without).split(s.key).join('<runKey>'));
  assert.deepEqual(shape, PRE_CHANGE_SHAPE);
  assert.equal(JSON.stringify(shape), JSON.stringify(PRE_CHANGE_SHAPE), 'key order unchanged');
});

test('worktreeKey, run and lineage come from the stored runKey and are null without one (IC-018 c)', (t) => {
  const s = scenario(t);
  const k = keyed(s.key);
  assert.match(k.worktreeKey, /^[0-9a-f]{16}$/);
  assert.equal(k.run, 'r1');
  assert.equal(k.lineage, 'main');
  // An older record: the second A.2 attempt carries no runKey, the first an unparsable one.
  const ledger = JSON.parse(s.before);
  delete ledger.tasks['A.2'].attempts[1].runKey;
  ledger.tasks['A.2'].attempts[0].runKey = 'not-a-run-key';
  fs.writeFileSync(s.file, JSON.stringify(ledger, null, 2));
  const attempts = inspect(s.common).tasks.find((r: any) => r.id === 'A.2').attempts;
  for (const a of attempts) {
    assert.deepEqual(Object.keys(a), [...IC013_KEYS, ...IC018C_KEYS]);
    assert.deepEqual({ worktreeKey: a.worktreeKey, run: a.run, lineage: a.lineage }, { worktreeKey: null, run: null, lineage: null }, `token ${a.token}`);
  }
  assert.deepEqual(inspect(s.common).tasks.find((r: any) => r.id === 'A.1').attempts.map((a: any) => a.run), ['r1'], 'A.1 keeps its run');
});

// The body produced by the code before B.2 for `scenario`, captured against 4ebf5d18 with the
// run key replaced by `<runKey>`: key order is part of the comparison.
const PRE_CHANGE_SHAPE: any = {
  slug: 'feat-b2',
  revision: 6,
  graph: {
    digest: 'sha256:fd24f0b9f92844727526c4dc0d6f933b3e58494af6bdd2de83a04848496668f8',
    graphPlan: true,
    warnings: [],
    tasks: [
      {
        id: 'A.1',
        phase: 'A',
        owner: 'core-implementer',
        taskDeps: [],
        parallel: true,
        acceptance: [],
        files: ['a.js'],
      },
      {
        id: 'A.2',
        phase: 'A',
        owner: 'quality-guardian',
        taskDeps: [],
        parallel: true,
        acceptance: [],
        files: ['b.js'],
      },
      {
        id: 'B.1',
        phase: 'B',
        owner: 'core-implementer',
        taskDeps: ['A.1'],
        parallel: false,
        acceptance: [],
        files: ['c.js'],
      },
    ],
    overlaps: [],
  },
  tasks: [
    {
      id: 'A.1',
      phase: 'A',
      derived: 'done',
      state: 'SUCCEEDED',
      reason: 'completed',
      claimable: false,
      budget: { limit: 20, used: 1, source: 'default' },
      activeToken: null,
      doneToken: 1,
      active: null,
      readiness: null,
    },
    {
      id: 'A.2',
      phase: 'A',
      derived: 'running',
      state: 'RUNNING',
      reason: 'active-attempt',
      claimable: false,
      budget: { limit: 20, used: 2, source: 'default' },
      activeToken: 2,
      doneToken: null,
      active: { owner: 'quality-guardian', mode: 'sequential', startedAt: '2026-01-04T00:05:00.000Z' },
      readiness: null,
    },
    {
      id: 'B.1',
      phase: 'B',
      derived: 'ready',
      state: 'READY',
      reason: 'ready',
      claimable: true,
      budget: { limit: 20, used: 0, source: 'default' },
      activeToken: null,
      doneToken: null,
      active: null,
      readiness: { reason: 'ready' },
    },
  ],
  run: {
    runKey: '<runKey>',
    exists: true,
    control: 'running',
    epoch: 1,
    budget: { attempts: 60, tokens: null, source: 'default' },
    totals: { attempts: 3, tokens: { measured: 0, estimated: 0, reserved: 0 }, unreported: 2 },
    totalsMismatch: false,
    history: [{ at: '2026-01-04T00:00:00.000Z', action: 'start', by: 'orchestrator', reason: null, epoch: 1 }],
  },
  defaults: { runAttempts: true, tasks: ['A.1', 'A.2', 'B.1'] },
  advisory: {
    decomposition: {
      advisoryOnly: true,
      phases: [{ phase: 'A', tasks: 2, parallel: 2 }, { phase: 'B', tasks: 1, parallel: 0 }],
      maxTasksPerPhase: 2,
      maxParallelFanOut: 2,
    },
  },
};
