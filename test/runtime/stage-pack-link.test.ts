'use strict';

// Issue #9 stage 3 (FU-7j3k84): a stage handoff names the context pack it was handed. The
// orchestration record's `complete-stage` entry carries `packs` ({ taskId, digest }), read from the
// 075 delivery store over the stage's window, and `trace spans` puts the reference on the stage span.
// A stage with no delivery records none; a record written before `packs` existed still projects.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { recordDelivery, makeTokenRecord } = require('../../src/runtime/context/delivery-store.ts');
const { projectSpans } = require('../../src/runtime/trace/spans.ts');

const REPO = path.resolve(__dirname, '..', '..');
const digestOf = (n: number) => `sha256:${String(n).padStart(64, '0')}`;

function project(t: any, featureSlug: any = null) {
  const dir = tempDir(t, 'doflow-stage-pack-');
  const orch: any = new WorkflowOrchestrator({ repoRoot: REPO, stateDir: path.join(dir, '.doflow', 'state', 'orchestration'), featureSlug, env: { DOFLOW_TELEMETRY: 'off' }, cwd: dir });
  orch.readinessEvaluate = () => 'READY';
  return { dir, orch };
}

const readRun = (dir: any, taskId: any) => JSON.parse(fs.readFileSync(path.join(dir, '.doflow', 'state', 'orchestration', `${taskId}.json`), 'utf8'));
const completion = (run: any, node: any) => run.history.filter((h: any) => h.action === 'complete-stage' && h.node === node).pop();
const stageSpan = (dir: any, node: any) => {
  const v = projectSpans({ projectRoot: dir, env: {} });
  return [...v.traces.flatMap((tr: any) => tr.spans), ...v.ungrouped.flatMap((g: any) => g.spans)].find((s: any) => s.kind === 'stage' && s.name === node);
};

/** A delivery entry recorded at `firstAt`, the store's own write path. */
function deliver(dir: any, taskId: any, digest: any, firstAt: any, slug: any = null) {
  const entry = { key: `${digest}.json.unstated`, packDigest: digest, form: 'json', harness: null, firstAt, mode: 'full',
    budget: { maxBytes: 1024, source: 'task-class' }, since: null, deltaRefused: null, retention: { status: 'unknown', basis: 'test' },
    items: {}, mandatoryIds: [], sources: {}, pointers: [], bytes: 20, tokens: makeTokenRecord(20), omissions: [], expansions: [] };
  recordDelivery({ projectRoot: dir, taskId, slug, entry });
}

function runPack(options: any) {
  let out = '';
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = (text: any) => { out += text; };
  try { handleContextPackCommand(options); } finally { console.log = log; process.exitCode = exitCode; }
  return JSON.parse(out);
}

test('issue-9: a stage handoff records the digest of the pack context-pack delivered, and its span carries it', (t) => {
  const { dir, orch } = project(t);
  const ledger: any = new EvidenceLedger({ repoRoot: dir });
  ledger.load('feat-a');
  ledger.addEvidence({ taskId: 'feat-a', kind: 'runtime-observation', locator: { file: 'src/a.ts' }, content: 'observed' });
  ledger.save('feat-a');
  orch.start({ taskId: 'feat-a', taskClass: 'trivial-edit', now: new Date(Date.now() - 60_000) });
  const pack = runPack({ taskId: 'feat-a', taskClass: 'trivial-edit', json: true, stateRoot: dir });
  assert.match(pack.delivery.packDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(pack.delivery.recorded, true);

  const handed = orch.handoff({ taskId: 'feat-a', callingSkill: 'do-implement', note: 'implemented', outcome: 'passed' });
  assert.equal(handed.disposition, 'completed');
  const stage = handed.recordedStage;
  assert.deepEqual(completion(readRun(dir, 'feat-a'), stage).packs, [{ taskId: 'feat-a', digest: pack.delivery.packDigest }]);

  const span = stageSpan(dir, stage);
  assert.equal(span.attrs.pack_digest, pack.delivery.packDigest);
  assert.equal(span.attrs.pack_task, 'feat-a');
  assert.equal(span.attrs.pack_count, 1);
});

test('issue-9: a stage with no delivered pack records none, and its span has no pack attributes', (t) => {
  const { dir, orch } = project(t);
  orch.start({ taskId: 'feat-b', taskClass: 'trivial-edit' });
  const stage = orch.snapshot(orch.requireRun('feat-b')).current.id;
  orch.completeStage({ taskId: 'feat-b', stageId: stage });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-b'), stage), 'packs'), false);
  const span = stageSpan(dir, stage);
  for (const key of ['pack_count', 'pack_task', 'pack_digest']) assert.equal(Object.hasOwn(span.attrs, key), false, key);
});

test('issue-9: a pack delivered before the stage opened is not attributed to it; one delivered inside is', (t) => {
  const { dir, orch } = project(t);
  const t0 = Date.parse('2026-10-01T10:00:00.000Z');
  const at = (minutes: number) => new Date(t0 + minutes * 60_000);
  orch.start({ taskId: 'feat-c', taskClass: 'bug', now: at(0) });
  const first = orch.snapshot(orch.requireRun('feat-c')).current.id;
  deliver(dir, 'feat-c', digestOf(1), at(1).toISOString());
  orch.completeStage({ taskId: 'feat-c', stageId: first, now: at(2) });
  assert.deepEqual(completion(readRun(dir, 'feat-c'), first).packs, [{ taskId: 'feat-c', digest: digestOf(1) }]);

  const second = orch.snapshot(orch.requireRun('feat-c')).current;
  assert.equal(second.type, 'stage', 'the bug workflow has a second stage and no gate');
  orch.completeStage({ taskId: 'feat-c', stageId: second.id, now: at(3) });
  assert.equal(Object.hasOwn(completion(readRun(dir, 'feat-c'), second.id), 'packs'), false, 'the first stage\'s pack is not the second stage\'s');
});

test('issue-9: the feature run names each plan task\'s latest pack in the window, oldest first', (t) => {
  const { dir, orch } = project(t, 'feat-d');
  const t0 = Date.parse('2026-10-01T10:00:00.000Z');
  const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
  orch.start({ taskId: 'feat-d', taskClass: 'feature', now: new Date(at(0)) });
  deliver(dir, 'B.1', digestOf(2), at(1), 'feat-d');
  deliver(dir, 'A.1', digestOf(3), at(2), 'feat-d');
  deliver(dir, 'A.1', digestOf(4), at(3), 'feat-d');
  deliver(dir, 'C.1', digestOf(5), at(9), 'feat-d'); // after the handoff: not this stage's
  const stage = orch.snapshot(orch.requireRun('feat-d')).current.id;
  orch.completeStage({ taskId: 'feat-d', stageId: stage, now: new Date(at(5)) });
  assert.deepEqual(completion(readRun(dir, 'feat-d'), stage).packs, [
    { taskId: 'B.1', digest: digestOf(2) },
    { taskId: 'A.1', digest: digestOf(4) },
  ]);
  const span = stageSpan(dir, stage);
  assert.deepEqual([span.attrs.pack_count, span.attrs.pack_task, span.attrs.pack_digest], [2, 'A.1', digestOf(4)]);
});

test('issue-9: a record written before packs existed, or with a malformed packs value, still projects with no pack attributes', (t) => {
  const dir = tempDir(t, 'doflow-stage-pack-old-');
  const file = path.join(dir, '.doflow', 'state', 'orchestration', 'old.json');
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

