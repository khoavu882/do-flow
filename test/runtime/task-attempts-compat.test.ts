'use strict';
// task-attempts-compat.test.js — 8ce5ad7 compatibility obligations and their controls (feature 080,
// E.3; IC-002, IC-010, IC-020, NFR-001).
//
// test/fixtures/task-attempts/ledger-8ce5ad7.json was written once by the 8ce5ad7 CLI, run from
// `git archive 8ce5ad7 src bin core` in a temp dir, against a copy of the committed
// test/fixtures/plans/076-evidence-attempts/plan.md under the slug 076-evidence-attempts: A.1 and
// A.2 claimed and finished COMPLETED against task-bound passing evidence, A.3 claimed and left
// active, A.4 claimed and released. GOLDEN below is what the same 8ce5ad7 CLI answered, from that
// ledger, to the STEPS sequence: each step's exit code and JSON result, then `status --json` and
// `checkCompletion`. It is stored losslessly in compact form (see `expandStatus`); a `startedAt`
// written during the sequence is recorded as '<now>', since only the fixture's own times are fixed.
// This file replays STEPS through the current tree and compares; it never recomputes GOLDEN.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { checkCompletion, loadPlan } = require('../../src/runtime/task-attempts.ts');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');
const { buildGraph } = require('../../src/runtime/task-graph.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const PLANS = path.join(REPO, 'test', 'fixtures', 'plans');
const PLAN_076 = path.join(PLANS, '076-evidence-attempts', 'plan.md');
const PLAN_078 = path.join(PLANS, '078-scoped-context-arbitration', 'plan.md');
const LEDGER = path.join(REPO, 'test', 'fixtures', 'task-attempts', 'ledger-8ce5ad7.json');
const SLUG = '076-evidence-attempts';
const HEADER = '**Task graph:** v1';

/** Plan task order and phases as 8ce5ad7 listed them in `status`, for expanding GOLDEN. */
const ORDER = 'A.1/A A.2/A A.3/A A.4/A A.5/A B.1/B C.1/C C.2/C C.3/C D.1/D D.2/D E.1/E E.2/E F.1/F F.2/F F.3/F G.1/G VX.1/VX VX.2/VX VX.3/VX VX.4/VX VX.5/VX VX.6/VX VX.7/VX V.1/V V.2/V'
  .split(' ').map((entry) => entry.split('/'));

const claimArgs = (task: any, owner: any, mode: any) => ['--action', 'claim', '--task', task, '--owner', owner, '--mode', mode];
const STEPS: any = [
  { args: claimArgs('A.3', 'core-implementer', 'subagent') },
  { args: claimArgs('A.1', 'core-implementer', 'subagent') },
  { args: claimArgs('B.1', 'core-implementer', 'subagent') },
  { args: ['--action', 'finish', '--task', 'A.3', '--token', '1', '--result', 'COMPLETED'], evidence: 'A.3' },
  { args: claimArgs('A.4', 'core-implementer', 'subagent') },
  { args: ['--action', 'release', '--task', 'A.4', '--token', '2', '--reason', 'handing back'] },
  { args: ['--action', 'finish', '--task', 'A.4', '--token', '2', '--result', 'BLOCKED'] },
  { args: claimArgs('A.4', 'quality-guardian', 'manual') },
  { args: ['--action', 'finish', '--task', 'A.4', '--token', '3', '--result', 'BLOCKED'] },
  { args: claimArgs('A.5', 'core-implementer', 'sequential') },
  { args: ['--action', 'finish', '--task', 'A.5', '--token', '1', '--result', 'COMPLETED'], evidence: 'A.5' },
];

// Snapshot 0 is before any step. `tasks` lists only tasks whose status entry is not
// `{derived: 'pending', activeToken: null, doneToken: null, active: null}`, each as
// [derived, activeToken, doneToken, active ? [owner, mode, startedAt] : null].
const GOLDEN: any = [
  {"step":null,"complete":false,"revision":13,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["running",1,null,["core-implementer","subagent","2026-10-15T08:05:19.298Z"]],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action claim --task A.3 --owner core-implementer --mode subagent","exit":1,"result":{"disposition":"refused","taskId":"A.3","reason":"active-attempt","activeToken":1,"owner":"core-implementer","startedAt":"2026-10-15T08:05:19.298Z"},"complete":false,"revision":13,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["running",1,null,["core-implementer","subagent","2026-10-15T08:05:19.298Z"]],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action claim --task A.1 --owner core-implementer --mode subagent","exit":1,"result":{"disposition":"refused","taskId":"A.1","reason":"already-done"},"complete":false,"revision":13,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["running",1,null,["core-implementer","subagent","2026-10-15T08:05:19.298Z"]],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action claim --task B.1 --owner core-implementer --mode subagent","exit":1,"result":{"disposition":"refused","taskId":"B.1","reason":"unmet-phase","unmet":["A.3","A.4","A.5"]},"complete":false,"revision":13,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["running",1,null,["core-implementer","subagent","2026-10-15T08:05:19.298Z"]],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.3 A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action finish --task A.3 --token 1 --result COMPLETED","exit":0,"result":{"disposition":"applied","taskId":"A.3","token":1,"result":"COMPLETED","revision":14},"complete":false,"revision":15,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action claim --task A.4 --owner core-implementer --mode subagent","exit":0,"result":{"disposition":"claimed","taskId":"A.4","token":2,"revision":16},"complete":false,"revision":17,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["running",2,null,["core-implementer","subagent","<now>"]],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action release --task A.4 --token 2 --reason handing back","exit":0,"result":{"disposition":"released","taskId":"A.4","token":2,"revision":18},"complete":false,"revision":19,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action finish --task A.4 --token 2 --result BLOCKED","exit":1,"result":{"disposition":"stale","taskId":"A.4","token":2,"reason":"no-active-attempt"},"complete":false,"revision":19,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["ready",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action claim --task A.4 --owner quality-guardian --mode manual","exit":0,"result":{"disposition":"claimed","taskId":"A.4","token":3,"revision":20},"complete":false,"revision":21,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["running",3,null,["quality-guardian","manual","<now>"]],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action finish --task A.4 --token 3 --result BLOCKED","exit":0,"result":{"disposition":"applied","taskId":"A.4","token":3,"result":"BLOCKED","revision":22},"complete":false,"revision":23,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["blocked",null,null,null],"A.5":["ready",null,null,null]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action claim --task A.5 --owner core-implementer --mode sequential","exit":0,"result":{"disposition":"claimed","taskId":"A.5","token":1,"revision":24},"complete":false,"revision":25,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["blocked",null,null,null],"A.5":["running",1,null,["core-implementer","sequential","<now>"]]},"unclaimedChecked":"A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 A.5 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
  {"step":"--action finish --task A.5 --token 1 --result COMPLETED","exit":0,"result":{"disposition":"applied","taskId":"A.5","token":1,"result":"COMPLETED","revision":26},"complete":false,"revision":27,"tasks":{"A.1":["done",null,1,null],"A.2":["done",null,1,null],"A.3":["done",null,1,null],"A.4":["blocked",null,null,null],"A.5":["done",null,1,null]},"unclaimedChecked":"A.4 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2","completion":["incomplete","076-evidence-attempts","A.4 B.1 C.1 C.2 C.3 D.1 D.2 E.1 E.2 F.1 F.2 F.3 G.1 VX.1 VX.2 VX.3 VX.4 VX.5 VX.6 VX.7 V.1 V.2"]},
];

// Revision is the one recorded value that is deliberately not replayed as recorded. The 8ce5ad7
// CLI advanced the stored revision by two per write (FU-08tzhg) and reported the value in between;
// a write now advances it by one and reports the stored value. GOLDEN keeps what 8ce5ad7 recorded,
// and these two maps turn it into what the fixed counter gives, from the fixture's own revision:
// a status revision r is REVISION_0 + (r - REVISION_0) / 2, and a write result's revision r (the
// recorded status before the write, plus one) is that of its predecessor, plus one.
const REVISION_0 = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).revision;
const oneBumpPerWrite = (recorded: any) => REVISION_0 + (recorded - REVISION_0) / 2;
const expectedResult = (result: any) => (Number.isInteger(result.revision) ? { ...result, revision: oneBumpPerWrite(result.revision - 1) + 1 } : result);

/** One GOLDEN snapshot → the 8ce5ad7 `status --json` object. */
function expandStatus(snapshot: any) {
  return {
    complete: snapshot.complete,
    revision: oneBumpPerWrite(snapshot.revision),
    tasks: ORDER.map(([id, phase]) => {
      const [derived, activeToken, doneToken, active] = snapshot.tasks[id] || ['pending', null, null, null];
      return {
        id, phase, derived, activeToken, doneToken,
        active: active ? { owner: active[0], mode: active[1], startedAt: active[2] } : null,
      };
    }),
    unclaimedChecked: snapshot.unclaimedChecked ? snapshot.unclaimedChecked.split(' ') : [],
  };
}

const expandCompletion = ([state, slug, incomplete]: any) => ({ state, slug, incomplete: incomplete ? incomplete.split(' ') : [] });

const LEDGER_TIMES: any = new Set(Object.values(JSON.parse(fs.readFileSync(LEDGER, 'utf8')).tasks)
  .flatMap((entry) => entry.attempts.map((attempt: any) => attempt.startedAt)));
const normalTime = (value: any) => (LEDGER_TIMES.has(value) ? value : '<now>');

/** Today's `status --json` cut to the keys 8ce5ad7 emitted, top level and per task. */
function legacyStatus(answer: any) {
  return {
    complete: answer.complete,
    revision: answer.revision,
    tasks: answer.tasks.map((t: any) => ({
      id: t.id, phase: t.phase, derived: t.derived, activeToken: t.activeToken, doneToken: t.doneToken,
      active: t.active ? { owner: t.active.owner, mode: t.active.mode, startedAt: normalTime(t.active.startedAt) } : null,
    })),
    unclaimedChecked: answer.unclaimedChecked,
  };
}

/** A scratch git project holding `plan` under `slug`, and `ledger` as its task-attempt store. */
function project(t: any, { plan = fs.readFileSync(PLAN_076, 'utf8'), slug = SLUG, ledger = fs.readFileSync(LEDGER) }: any = {}) {
  const scratch = createScratch('doflow-task-compat-');
  t.after(() => scratch.remove());
  const dir = path.join(scratch.dir, 'project');
  const planFile = path.join(dir, 'agent-docs', 'doflow', slug, 'plan.md');
  const store = path.join(dir, '.doflow', 'state', 'task-attempts', `${slug}.json`);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  if (ledger) {
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, ledger);
  }
  // Every run-key input is set here, so the developer's shell never decides one.
  const env = scratch.env({
    DOFLOW_RUN_ID: 'run-compat', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: dir,
  });
  delete env.FORCE_COLOR;
  delete env.KIRO_SESSION_ID;
  const git = spawnSync('git', ['init', '-q'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const ta = (args: any) => {
    const done = spawnSync(process.execPath, [CLI, 'task-attempt', '--slug', slug, ...args, '--json'], { cwd: dir, env, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* reported by the assertion that reads data */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  /** Records one passing test-result bound to `taskId` and returns its id. */
  const evidence = (taskId: any) => {
    const ledgerFile: any = new EvidenceLedger({ repoRoot: dir, slug });
    const id = ledgerFile.addEvidence({
      taskId, kind: 'test-result', provenance: 'extracted', source: { provider: 'shell', capability: 'test' },
      locator: { file: 'a.test.js' }, content: 'ran', observation: { command: 'node --test', exitCode: 0 },
    });
    ledgerFile.save(taskId);
    return id;
  };
  const completion = () => checkCompletion({ slug, cwd: dir });
  return { dir, planFile, store, ta, evidence, completion };
}

/** `plan` with the graph header added before its first `## ` section (IC-001). */
function withHeader(plan: any) {
  const lines = plan.split('\n');
  const at = lines.findIndex((line: any) => /^## /.test(line));
  assert.notEqual(at, -1, 'the plan has a ## section');
  lines.splice(at, 0, HEADER, '');
  return lines.join('\n');
}

/** `plan` with the `- [?] <id> ` task line passed through `edit`. */
function editTaskLine(plan: any, id: any, edit: any) {
  const lines = plan.split('\n');
  const pattern: any = new RegExp(`^-\\s*\\[[ xX]\\]\\s+${id.replace('.', '\\.')}\\s`);
  const at = lines.findIndex((line: any) => pattern.test(line));
  assert.notEqual(at, -1, `the plan holds a ${id} task line`);
  lines[at] = edit(lines[at]);
  return lines.join('\n');
}

test('GOLDEN and STEPS describe the same sequence', () => {
  assert.equal(GOLDEN.length, STEPS.length + 1);
  assert.equal(GOLDEN[0].step, null);
  STEPS.forEach((step: any, i: any) => assert.equal(GOLDEN[i + 1].step, step.args.join(' '), `step ${i + 1}`));
});

test('the 8ce5ad7 ledger and plan load unchanged: recorded hashes match and reads write nothing (IC-002, IC-010)', (t) => {
  const p = project(t);
  const fixture = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const plan = loadPlan({ roots: [p.dir], slug: SLUG });
  assert.equal(plan.planPath, fixture.planPath, 'planPath');
  const hashes: any = new Map(plan.tasks.map((task: any) => [task.id, task.hash]));
  for (const [id, entry] of Object.entries(fixture.tasks)) {
    for (const attempt of entry.attempts) assert.equal(hashes.get(id), attempt.taskLineHash, `${id} token ${attempt.token}`);
  }

  const before = fs.readFileSync(p.store);
  const status = p.ta(['--action', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(legacyStatus(status.data), expandStatus(GOLDEN[0]), 'status before any write');
  assert.deepEqual(p.completion(), expandCompletion(GOLDEN[0].completion), 'checkCompletion before any write');
  assert.deepEqual(fs.readFileSync(p.store), before, 'status and checkCompletion leave the ledger bytes unchanged');
  assert.equal(fs.readFileSync(p.planFile, 'utf8'), fs.readFileSync(PLAN_076, 'utf8'), 'the plan is the committed 076 fixture');
});

test('every step answers as 8ce5ad7 did, and status and checkCompletion agree after each 080 write (IC-010, IC-020, FR-015)', (t) => {
  const p = project(t);
  STEPS.forEach((step: any, i: any) => {
    const golden: any = GOLDEN[i + 1];
    const label = `step ${i + 1}: ${golden.step}`;
    const args = step.evidence ? [...step.args, '--evidence-id', p.evidence(step.evidence)] : step.args;
    const run = p.ta(args);
    assert.equal(run.status, golden.exit, `${label} exit: ${run.stderr}`);
    const result: any = { ...run.data };
    if (result.startedAt) result.startedAt = normalTime(result.startedAt);
    // Exact equality: a legacy claim, finish or release keeps 8ce5ad7's key set, nothing added.
    assert.deepEqual(result, expectedResult(golden.result), `${label} result`);
    const status = p.ta(['--action', 'status']);
    assert.equal(status.status, 0, `${label} status: ${status.stderr}`);
    assert.deepEqual(legacyStatus(status.data), expandStatus(golden), `${label} status`);
    assert.deepEqual(p.completion(), expandCompletion(golden.completion), `${label} checkCompletion`);
  });
  const store = JSON.parse(fs.readFileSync(p.store, 'utf8'));
  assert.equal(store.version, 1, 'the ledger stays version 1 after 080 writes');
});

test('an attempt claimed by the 8ce5ad7 runtime finishes under 080 without plan-changed (IC-020)', (t) => {
  const p = project(t);
  const finish = p.ta(['--action', 'finish', '--task', 'A.3', '--token', '1', '--result', 'BLOCKED']);
  assert.equal(finish.status, 0, finish.stderr);
  assert.deepEqual(finish.data, { disposition: 'applied', taskId: 'A.3', token: 1, result: 'BLOCKED', revision: 14 });
});

test('a header-less plan does not enforce owner: (DEC-008, IC-020)', (t) => {
  const plan = fs.readFileSync(PLAN_078, 'utf8');
  const slug = '078-scoped-context-arbitration';
  assert.equal(parsePlan(plan).tasks.find((task: any) => task.id === 'H.1').owner, 'quality-guardian', 'H.1 declares an owner');
  assert.equal(parsePlan(plan).graphHeader, null, 'the 078 fixture has no graph header');
  const p = project(t, { plan, slug, ledger: null });
  const claim = p.ta(claimArgs('H.1', 'core-implementer', 'subagent'));
  assert.equal(claim.status, 0, claim.stderr);
  assert.deepEqual(claim.data, { disposition: 'claimed', taskId: 'H.1', token: 1, revision: 1 }, 'claimed in the 8ce5ad7 shape');
});

test('control: the same owner mismatch is refused once the plan carries the graph header (IC-020)', (t) => {
  const plan = withHeader(fs.readFileSync(PLAN_078, 'utf8'));
  const slug = '078-scoped-context-arbitration';
  const p = project(t, { plan, slug, ledger: null });
  const start = p.ta(['--action', 'start', '--by', 'lead']);
  assert.equal(start.status, 0, start.stderr);
  const claim = p.ta([...claimArgs('H.1', 'core-implementer', 'subagent'), '--epoch', String(start.data.epoch)]);
  assert.equal(claim.status, 1, claim.stdout);
  assert.deepEqual([claim.data.disposition, claim.data.reason, claim.data.declared], ['refused', 'owner-mismatch', 'quality-guardian']);
});

test('control: the graph header turns a near-miss depends-on: into bad-dependency; without it the plan stays valid (IC-020)', (t) => {
  // The committed 076 fixture carries no `depends-on:` field (its dependencies are prose), so the
  // near-miss value is added to A.2 in both copies, closed by `;` so the wrapped
  // continuation lines that follow A.2 stay out of it.
  const nearMiss = editTaskLine(fs.readFileSync(PLAN_076, 'utf8'), 'A.2', (line: any) => `${line}; depends-on: A.1 (after review);`);
  const plain = buildGraph(parsePlan(nearMiss));
  assert.equal(plain.ok, true, 'header-less copy builds');
  assert.deepEqual(plain.warnings, [{ kind: 'near-miss-dependency', ids: ['A.2'], value: 'A.1 (after review)' }]);
  const headed = buildGraph(parsePlan(withHeader(nearMiss)));
  assert.equal(headed.ok, false, 'headed copy is refused');
  assert.deepEqual(headed.problems, [{ kind: 'bad-dependency', ids: ['A.2'], value: 'A.1 (after review)' }]);

  const valid = project(t, { plan: nearMiss, ledger: null }).ta(['--action', 'status']);
  assert.equal(valid.status, 0, valid.stderr);
  const malformed = project(t, { plan: withHeader(nearMiss), ledger: null }).ta(['--action', 'status']);
  assert.equal(malformed.status, 2, malformed.stdout);
  assert.equal(malformed.data.error, 'plan-malformed');
});

test('control: one changed character in a legacy task line changes its hash and the 8ce5ad7 attempt finishes plan-changed (IC-002)', (t) => {
  // Flip the first description letter of A.3, the attempt the fixture left active.
  const perturbed = editTaskLine(fs.readFileSync(PLAN_076, 'utf8'), 'A.3', (line: any) => {
    const match = line.match(/^(-\s*\[[ xX]\]\s+A\.3\s+(?:\[[^\]]+\]\s+)*)(\S)/);
    assert.ok(match, 'A.3 has description text');
    return line.slice(0, match[1].length) + (match[2] === 'X' ? 'Y' : 'X') + line.slice(match[1].length + 1);
  });
  const p = project(t, { plan: perturbed });
  const fixture = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  const hashes: any = new Map(loadPlan({ roots: [p.dir], slug: SLUG }).tasks.map((task: any) => [task.id, task.hash]));
  assert.notEqual(hashes.get('A.3'), fixture.tasks['A.3'].attempts[0].taskLineHash, 'A.3 hash differs');
  for (const id of ['A.1', 'A.2', 'A.4']) assert.equal(hashes.get(id), fixture.tasks[id].attempts[0].taskLineHash, `${id} unaffected`);
  const before = fs.readFileSync(p.store);
  const finish = p.ta(['--action', 'finish', '--task', 'A.3', '--token', '1', '--result', 'BLOCKED']);
  assert.equal(finish.status, 1, finish.stdout);
  assert.deepEqual(finish.data, { disposition: 'refused', taskId: 'A.3', token: 1, reason: 'plan-changed' });
  assert.deepEqual(fs.readFileSync(p.store), before, 'the refusal writes nothing');
});

test('control: one attempt state set to superseded breaks the checkCompletion equality (IC-020)', (t) => {
  const fixture = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  fixture.tasks['A.1'].attempts[0].state = 'superseded';
  const p = project(t, { ledger: `${JSON.stringify(fixture, null, 2)}\n` });
  const answer = p.completion();
  assert.notDeepEqual(answer, expandCompletion(GOLDEN[0].completion), 'the equality the compatibility test asserts would fail');
  assert.ok(answer.incomplete.includes('A.1'), 'A.1 is no longer done');
});
