'use strict';

// Issue #9 stage 3 (FU-7j3k84): a stage handoff names the context packs it was handed. When the
// context-pack verb records a delivery it names it on the run stage active at that moment
// (`recordStagePack`, the node's `packs`); `complete-stage` copies that onto its history entry and
// `trace spans` puts the reference on the stage span. No active stage records nothing; a record
// written before `packs` existed still projects.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { projectSpans } = require('../../src/runtime/trace/spans.ts');
const { recordFeature } = require('../../src/runtime/feature-pointer.ts');

const REPO = path.resolve(__dirname, '..', '..');
const STATE = (dir: any) => path.join(dir, '.doflow', 'state');

function project(t: any, featureSlug: any = null) {
  const dir = tempDir(t, 'doflow-stage-pack-');
  const orch: any = new WorkflowOrchestrator({ repoRoot: REPO, stateDir: path.join(STATE(dir), 'orchestration'), featureSlug, env: { DOFLOW_TELEMETRY: 'off' }, cwd: dir });
  orch.readinessEvaluate = () => 'READY';
  return { dir, orch };
}

const runFile = (dir: any, taskId: any) => path.join(STATE(dir), 'orchestration', `${taskId}.json`);
const readRun = (dir: any, taskId: any) => JSON.parse(fs.readFileSync(runFile(dir, taskId), 'utf8'));
const completion = (run: any, node: any) => run.history.filter((h: any) => h.action === 'complete-stage' && h.node === node).pop();
const current = (orch: any, taskId: any) => orch.snapshot(orch.requireRun(taskId)).current;
const stageSpan = (dir: any, node: any) => {
  const v = projectSpans({ projectRoot: dir, env: {} });
  return [...v.traces.flatMap((tr: any) => tr.spans), ...v.ungrouped.flatMap((g: any) => g.spans)].find((s: any) => s.kind === 'stage' && s.name === node);
};

/** One evidence item for `taskId`, so its pack is not empty; `content` changes the pack digest. */
function evidence(dir: any, taskId: any, content: any = 'observed', slug: any = null) {
  const ledger: any = new EvidenceLedger({ repoRoot: dir, ...(slug ? { slug } : {}) });
  ledger.load(taskId);
  ledger.addEvidence({ taskId, kind: 'runtime-observation', locator: { file: 'src/a.ts' }, content });
  ledger.save(taskId);
}

/** The real verb, in process: the digest of the pack it delivered and recorded. */
function pack(dir: any, taskId: any, extra: any = {}) {
  let out = '';
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = (text: any) => { out += text; };
  try { handleContextPackCommand({ taskId, taskClass: 'feature', json: true, stateRoot: dir, ...extra }); } finally { console.log = log; process.exitCode = exitCode; }
  const parsed = JSON.parse(out);
  assert.equal(parsed.delivery.recorded, true);
  assert.match(parsed.delivery.packDigest, /^sha256:[0-9a-f]{64}$/);
  return parsed.delivery.packDigest;
}

test('issue-9: a stage handoff records the digest context-pack delivered to it, and its span carries it', (t) => {
  const { dir, orch } = project(t);
  evidence(dir, 'feat-a');
  orch.start({ taskId: 'feat-a', taskClass: 'trivial-edit' });
  const digest = pack(dir, 'feat-a');
  const handed = orch.handoff({ taskId: 'feat-a', callingSkill: 'do-implement', note: 'implemented', outcome: 'passed' });
  assert.equal(handed.disposition, 'completed');
  assert.deepEqual(completion(readRun(dir, 'feat-a'), handed.recordedStage).packs, [{ taskId: 'feat-a', digest }]);
  const span = stageSpan(dir, handed.recordedStage);
  assert.deepEqual([span.attrs.pack_count, span.attrs.pack_task, span.attrs.pack_digest], [1, 'feat-a', digest]);
});

test('issue-9: a stage handed no pack records none, and its span has no pack attributes', (t) => {
  const { dir, orch } = project(t);
  orch.start({ taskId: 'feat-b', taskClass: 'trivial-edit' });
  const stage = current(orch, 'feat-b').id;
  orch.completeStage({ taskId: 'feat-b', stageId: stage });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-b'), stage), 'packs'), false);
  const span = stageSpan(dir, stage);
  for (const key of ['pack_count', 'pack_task', 'pack_digest']) assert.equal(Object.hasOwn(span.attrs, key), false, key);
});

test('issue-9: another session\'s delivery into a different run is not attributed to this run', (t) => {
  const { dir, orch } = project(t);
  evidence(dir, 'feat-y');
  orch.start({ taskId: 'feat-x', taskClass: 'bug' });
  orch.start({ taskId: 'feat-y', taskClass: 'bug' });
  const digest = pack(dir, 'feat-y');
  const x = current(orch, 'feat-x').id;
  const y = current(orch, 'feat-y').id;
  orch.completeStage({ taskId: 'feat-x', stageId: x });
  orch.completeStage({ taskId: 'feat-y', stageId: y });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-x'), x), 'packs'), false);
  assert.deepEqual(completion(readRun(dir, 'feat-y'), y).packs, [{ taskId: 'feat-y', digest }]);
});

test('issue-9: a pack for a task with its own run in the feature goes to that run, not to the feature run', (t) => {
  const { dir, orch } = project(t, 'feat-s');
  evidence(dir, 'T.9', 'observed', 'feat-s');
  orch.start({ taskId: 'feat-s', taskClass: 'bug' });
  orch.start({ taskId: 'T.9', taskClass: 'bug' }); // another session's run, under the feature's namespace
  const digest = pack(dir, 'T.9', { slug: 'feat-s' });
  const feature = current(orch, 'feat-s').id;
  const task = current(orch, 'T.9').id;
  orch.completeStage({ taskId: 'feat-s', stageId: feature });
  orch.completeStage({ taskId: 'T.9', stageId: task });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-s'), feature), 'packs'), false);
  const own = JSON.parse(fs.readFileSync(path.join(STATE(dir), 'orchestration', 'feat-s', 'T.9.json'), 'utf8'));
  assert.deepEqual(completion(own, task).packs, [{ taskId: 'T.9', digest }]);
});

test('issue-9: no active stage (a run at a gate, or no run) records no association', (t) => {
  const { dir, orch } = project(t, 'feat-g');
  evidence(dir, 'feat-g');
  evidence(dir, 'loose');
  orch.start({ taskId: 'feat-g', taskClass: 'feature' });
  orch.completeStage({ taskId: 'feat-g', stageId: current(orch, 'feat-g').id });
  assert.equal(orch.requireRun('feat-g').state, 'AWAITING_GATE');
  const before = fs.readFileSync(runFile(dir, 'feat-g'), 'utf8');
  pack(dir, 'feat-g');
  pack(dir, 'loose');
  assert.equal(fs.readFileSync(runFile(dir, 'feat-g'), 'utf8'), before, 'a run at a gate is not written');
  assert.deepEqual(fs.readdirSync(path.join(STATE(dir), 'orchestration')).filter((n: any) => n.endsWith('.json')), ['feat-g.json'], 'no run is created');
  orch.decideGate({ taskId: 'feat-g', gateId: current(orch, 'feat-g').id, decision: 'approve' });
  const design = current(orch, 'feat-g').id;
  orch.completeStage({ taskId: 'feat-g', stageId: design });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-g'), design), 'packs'), false, 'a pack delivered at the gate is not the next stage\'s');
});

test('issue-9: a delivery at the boundary belongs only to the stage active when it was made', (t) => {
  const { dir, orch } = project(t);
  evidence(dir, 'feat-c');
  const now = new Date('2026-10-01T10:00:00.000Z');
  orch.start({ taskId: 'feat-c', taskClass: 'bug', now });
  const first = current(orch, 'feat-c').id;
  const digest = pack(dir, 'feat-c');
  orch.completeStage({ taskId: 'feat-c', stageId: first, now });
  const second = current(orch, 'feat-c').id;
  orch.completeStage({ taskId: 'feat-c', stageId: second, now });
  const run = readRun(dir, 'feat-c');
  assert.deepEqual(completion(run, first).packs, [{ taskId: 'feat-c', digest }]);
  assert.equal(Object.hasOwn(completion(run, second), 'packs'), false, 'same instant, next stage: not handed the pack');
});

test('issue-9: an identical pack delivered again in a later stage is recorded for that stage; the delivery store revision stays', (t) => {
  const { dir, orch } = project(t);
  evidence(dir, 'feat-r');
  orch.start({ taskId: 'feat-r', taskClass: 'bug' });
  const first = current(orch, 'feat-r').id;
  const digest = pack(dir, 'feat-r');
  const store = path.join(STATE(dir), 'delivery', 'feat-r.json');
  const revision = JSON.parse(fs.readFileSync(store, 'utf8')).revision;
  orch.completeStage({ taskId: 'feat-r', stageId: first });
  const second = current(orch, 'feat-r').id;
  assert.equal(pack(dir, 'feat-r'), digest, 'the same pack');
  const disk = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.equal(disk.revision, revision, 'an identical delivery does not bump the store revision');
  assert.equal(disk.deliveries.length, 1);
  const runRevision = readRun(dir, 'feat-r').revision;
  pack(dir, 'feat-r');
  assert.equal(readRun(dir, 'feat-r').revision, runRevision, 'a repeat the stage already ends with does not write the run');
  orch.completeStage({ taskId: 'feat-r', stageId: second });
  const run = readRun(dir, 'feat-r');
  assert.deepEqual(completion(run, first).packs, [{ taskId: 'feat-r', digest }]);
  assert.deepEqual(completion(run, second).packs, [{ taskId: 'feat-r', digest }]);
});

test('issue-9: a feature run\'s stage names the plan-task packs delivered while it was active, latest per task', (t) => {
  const { dir, orch } = project(t, 'feat-d');
  for (const task of ['A.1', 'B.1', 'C.1']) evidence(dir, task, 'first', 'feat-d');
  orch.start({ taskId: 'feat-d', taskClass: 'feature' });
  const discovery = current(orch, 'feat-d').id;
  const c1 = pack(dir, 'C.1', { slug: 'feat-d' }); // handed while discovery is active
  orch.completeStage({ taskId: 'feat-d', stageId: discovery });
  orch.decideGate({ taskId: 'feat-d', gateId: current(orch, 'feat-d').id, decision: 'approve' });
  const design = current(orch, 'feat-d').id;
  const b1 = pack(dir, 'B.1', { slug: 'feat-d' });
  const a1first = pack(dir, 'A.1', { slug: 'feat-d' });
  evidence(dir, 'A.1', 'second', 'feat-d');
  const a1 = pack(dir, 'A.1', { slug: 'feat-d' }); // A.1's latest pack while design is active
  assert.notEqual(a1, a1first);
  orch.completeStage({ taskId: 'feat-d', stageId: design });
  const run = readRun(dir, 'feat-d');
  assert.deepEqual(completion(run, discovery).packs, [{ taskId: 'C.1', digest: c1 }]);
  assert.deepEqual(completion(run, design).packs, [{ taskId: 'B.1', digest: b1 }, { taskId: 'A.1', digest: a1 }]);
  const span = stageSpan(dir, design);
  assert.deepEqual([span.attrs.pack_count, span.attrs.pack_task, span.attrs.pack_digest], [2, 'A.1', a1]);
});

test('issue-9: with no --slug, the checkout\'s feature pointer names the feature run', (t) => {
  const { dir, orch } = project(t, 'feat-p');
  // A minimal repository on `main` (HEAD, objects, refs), so the pointer has a checkout to key on.
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  evidence(dir, 'P.1');
  orch.start({ taskId: 'feat-p', taskClass: 'feature' });
  recordFeature({ storeRoot: dir, cwd: dir, slug: 'feat-p', taskId: 'feat-p' });
  const digest = pack(dir, 'P.1');
  const stage = current(orch, 'feat-p').id;
  orch.completeStage({ taskId: 'feat-p', stageId: stage });
  assert.deepEqual(completion(readRun(dir, 'feat-p'), stage).packs, [{ taskId: 'P.1', digest }]);
});

test('issue-9: a record written before packs existed, or with a malformed packs value, still projects with no pack attributes', (t) => {
  const dir = tempDir(t, 'doflow-stage-pack-old-');
  const file = path.join(STATE(dir), 'orchestration', 'old.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 2, taskId: 'old', taskClass: 'feature', startedAt: '2026-09-01T10:00:00.000Z',
    history: [
      { at: '2026-09-01T10:00:00.000Z', action: 'start', detail: 'task-class=feature' },
      { at: '2026-09-01T10:10:00.000Z', action: 'complete-stage', node: 'discovery', note: null, outcome: 'unverified' },
      { at: '2026-09-01T10:20:00.000Z', action: 'complete-stage', node: 'design', packs: [{ taskId: 'x y', digest: 'sha256:00' }, 'junk'] },
      { at: '2026-09-01T10:30:00.000Z', action: 'complete-stage', node: 'plan', packs: 'not-a-list' },
    ] }));
  const v = projectSpans({ projectRoot: dir, env: {} });
  assert.deepEqual(v.gaps, []);
  for (const node of ['discovery', 'design', 'plan']) {
    const span = stageSpan(dir, node);
    assert.ok(span, node);
    for (const key of ['pack_count', 'pack_task', 'pack_digest']) assert.equal(Object.hasOwn(span.attrs, key), false, `${node} ${key}`);
  }
});

test('issue-9: a malformed packs value on a run node never blocks completion and records none', (t) => {
  const { dir, orch } = project(t);
  orch.start({ taskId: 'feat-m', taskClass: 'bug' });
  const disk = readRun(dir, 'feat-m');
  disk.program[disk.cursor].packs = 'junk';
  fs.writeFileSync(runFile(dir, 'feat-m'), JSON.stringify(disk));
  const stage = current(orch, 'feat-m').id;
  orch.completeStage({ taskId: 'feat-m', stageId: stage });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-m'), stage), 'packs'), false);
});
