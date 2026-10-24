'use strict';

// Feature 088 B.1 (IC-010; FR-002, FR-003, NFR-007; DD-5, OI-1): a trace id lives on the 080
// task-run record only. `start` and each acknowledged resume mint one (32 lowercase hex); a resume
// also links the previous id. Telemetry off mints none and leaves the record as it was before 088.
// The orchestrator `start` stores `runKey` and copies the id. `inspectRun` projects both fields out
// of the history, so `task-attempt inspect` is byte-identical with telemetry on, off and faulted.
//
// In-process against temp projects with an explicit identity environment, like task-run-resume.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { start, pause, resume, inspect } = require('../../src/runtime/task-attempts.ts');
const { runKeyFor, formatInspect, inspectRun } = require('../../src/runtime/task-run.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');

const SLUG = 'feat-t';
const NOW = new Date('2026-02-01T00:00:00.000Z');
const LATER = new Date('2026-02-01T00:05:00.000Z');
const LATEST = new Date('2026-02-01T00:10:00.000Z');
const REPO = path.resolve(__dirname, '..', '..');
const HEX32 = /^[0-9a-f]{32}$/;
const PLAN = [
  '# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', '',
].join('\n');

const git = () => (args) => (args[0] === 'symbolic-ref' ? 'feat/088\n' : null);

function project(t) {
  const dir = tempDir(t, 'doflow-trace-ids-');
  fs.mkdirSync(path.join(dir, '.git'));
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(xdg);
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  const file = path.join(dir, '.doflow', 'state', 'task-attempts', `${SLUG}.json`);
  const env = (who = {}) => {
    const e = {
      DOFLOW_RUN_ID: who.run || 'r1', DOFLOW_LINEAGE_ID: who.lineage || 'main',
      DOFLOW_SESSION_ROLE: who.role || 'main', DOFLOW_ROLE: who.role || 'main',
      DOFLOW_WORKTREE: dir, HOME: dir, XDG_CONFIG_HOME: xdg,
    };
    if (who.off) e.DOFLOW_TELEMETRY = 'off';
    return e;
  };
  const common = (who = {}, now = NOW) => ({ file, fsImpl: fs, roots: [dir], slug: SLUG, now, env: env(who), cwd: dir });
  const key = (who = {}) => runKeyFor(env(who), dir).runKey;
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = (who = {}) => read().runs[key(who)];
  /** The acknowledged resume: ask for the report, then acknowledge its digest. */
  const resumeAck = (who = {}, now = LATER) => {
    const asked = resume({ ...common(who, now), gitRunner: git() });
    assert.equal(asked.disposition, 'ack-required');
    return resume({ ...common(who, now), ack: asked.digest, by: 'orchestrator', gitRunner: git() });
  };
  return { dir, file, env, common, key, read, run, resumeAck };
}

/** Run `fn` with `crypto.randomBytes` throwing: a fault in the id source. */
function withFaultedIdSource(fn) {
  const real = crypto.randomBytes;
  crypto.randomBytes = () => { throw new Error('injected id source fault'); };
  try { return fn(); } finally { crypto.randomBytes = real; }
}

/** Whether a trace field is stored anywhere in `value` (the temp path itself says 'trace'). */
const hasTrace = (value) => /"trace(Id|Link)"/.test(typeof value === 'string' ? value : JSON.stringify(value));

const stripTrace = (value) => JSON.parse(JSON.stringify(value, (k, v) => (k === 'traceId' || k === 'traceLink' ? undefined : v)));

// ── ids on the 080 run record ───────────────────────────────────────────────────────────────────

test('start mints a 32-hex id on the run and in the start entry; a resume mints a new one and links the old', (t) => {
  const p = project(t);
  assert.equal(start({ ...p.common(), by: 'orchestrator' }).disposition, 'started');
  const first = p.run().traceId;
  assert.match(first, HEX32);
  assert.equal(p.run().history[0].traceId, first);
  assert.equal('traceLink' in p.run().history[0], false, 'start has no previous id to link');

  assert.equal(p.resumeAck({}, LATER).disposition, 'resumed');
  const second = p.run().traceId;
  assert.match(second, HEX32);
  assert.notEqual(second, first);
  const entry = p.run().history.find((h) => h.action === 'resume');
  assert.equal(entry.traceId, second);
  assert.equal(entry.traceLink, first);

  assert.equal(p.resumeAck({}, LATEST).disposition, 'resumed');
  const third = p.run().traceId;
  const entries = p.run().history.filter((h) => h.action === 'resume');
  assert.equal(entries[1].traceLink, second, 'the link is always the id just replaced');
  assert.equal(new Set([first, second, third]).size, 3);
});

test('negative control: a record written with telemetry off has no id, so the id assertions fail on it', (t) => {
  const p = project(t);
  start({ ...p.common({ off: true }), by: 'orchestrator' });
  assert.equal(p.run({ off: true }).traceId, undefined);
  assert.throws(() => assert.match(p.run({ off: true }).traceId, HEX32));
});

test('two runs get different ids, and an id is not derived from the run key or the path', (t) => {
  const p = project(t);
  start({ ...p.common({ run: 'r1' }), by: 'orchestrator' });
  start({ ...p.common({ run: 'r2' }), by: 'orchestrator' });
  const a = p.run({ run: 'r1' }).traceId;
  const b = p.run({ run: 'r2' }).traceId;
  assert.match(a, HEX32);
  assert.match(b, HEX32);
  assert.notEqual(a, b);
  for (const [id, source] of [[a, p.key({ run: 'r1' })], [a, p.dir], [b, p.key({ run: 'r2' })], [b, p.dir]]) {
    for (const algo of ['sha256', 'sha1', 'md5']) {
      const digest = crypto.createHash(algo).update(source).digest('hex');
      assert.notEqual(id, digest.slice(0, 32), `${algo} prefix of ${source}`);
      assert.equal(id.includes(digest.slice(0, 16)), false, `${algo} 16-prefix of ${source}`);
    }
  }
});

test('the run key string is identical to the pre-088 form, with and without the telemetry switch', (t) => {
  const p = project(t);
  const expected = (who) => `${cwdHash(p.dir)}/${who.run || 'r1'}/${who.lineage || 'main'}`;
  assert.equal(runKeyFor(p.env(), p.dir).runKey, expected({}));
  assert.equal(runKeyFor(p.env({ off: true }), p.dir).runKey, expected({}));
  assert.equal(runKeyFor(p.env({ run: 'r9', lineage: 'L2' }), p.dir).runKey, expected({ run: 'r9', lineage: 'L2' }));
});

test('a run created before 088 (no id) resumes without error and links nothing', (t) => {
  const p = project(t);
  start({ ...p.common({ off: true }), by: 'orchestrator' });
  assert.equal(p.run({ off: true }).traceId, undefined);
  pause({ ...p.common({ off: true }), by: 'orchestrator', reason: 'stop' });

  const resumed = p.resumeAck();
  assert.equal(resumed.disposition, 'resumed');
  const entry = p.run().history.find((h) => h.action === 'resume');
  assert.match(entry.traceId, HEX32);
  assert.equal(entry.traceLink, null);
  assert.equal(p.run().traceId, entry.traceId);
});

test('a resume that creates the run mints an id and links nothing', (t) => {
  const p = project(t);
  assert.equal(p.resumeAck().disposition, 'resumed');
  const entry = p.run().history[0];
  assert.equal(entry.action, 'resume');
  assert.match(entry.traceId, HEX32);
  assert.equal(entry.traceLink, null);
});

// ── telemetry off ───────────────────────────────────────────────────────────────────────────────

test('telemetry off mints no id and the run record equals the on record with the trace fields removed', (t) => {
  const on = project(t);
  const off = project(t);
  for (const [p, who] of [[on, {}], [off, { off: true }]]) {
    start({ ...p.common(who), by: 'orchestrator' });
    pause({ ...p.common(who), by: 'orchestrator', reason: 'stop' });
    assert.equal(p.resumeAck(who).disposition, 'resumed');
  }
  const recordOf = (p, who) => {
    // The two projects differ in path, so the run key, worktree and the report digest (which names the key) do too.
    const { runKey, worktree, worktreeKey, ...rest } = p.run(who);
    return JSON.parse(JSON.stringify(rest, (k, v) => (k === 'digest' ? undefined : v)));
  };
  const onRecord = recordOf(on, {});
  const offRecord = recordOf(off, { off: true });
  assert.equal(hasTrace(offRecord), false, 'no trace field anywhere in the off record');
  assert.notDeepEqual(onRecord, offRecord, 'control: the on record differs before the fields are removed');
  assert.deepEqual(stripTrace(onRecord), offRecord);
  assert.equal(JSON.stringify(Object.keys(offRecord)), JSON.stringify(Object.keys(stripTrace(onRecord))), 'same key order');
});

// ── inspect hides the ids (OI-1, FR-002) ────────────────────────────────────────────────────────

test('inspect output is byte-identical with telemetry on, off and faulted, while the stored history holds the ids', (t) => {
  const p = project(t);
  const cycle = (who) => {
    fs.rmSync(p.file, { force: true });
    start({ ...p.common(who), by: 'orchestrator' });
    pause({ ...p.common(who), by: 'orchestrator', reason: 'stop' });
    p.resumeAck(who);
    const view = inspect(p.common(who));
    return { json: JSON.stringify(view), text: formatInspect(view).join('\n'), stored: JSON.stringify(p.read()) };
  };
  const on = cycle({});
  assert.match(on.stored, /"traceId":"[0-9a-f]{32}"/, 'control: the on store carries ids');
  assert.match(on.stored, /"traceLink":"[0-9a-f]{32}"/);
  const off = cycle({ off: true });
  const faulted = withFaultedIdSource(() => cycle({}));
  assert.equal(hasTrace(faulted.stored), false, 'a faulted id source leaves no id');
  assert.equal(on.json, off.json);
  assert.equal(on.json, faulted.json);
  assert.equal(on.text, off.text);
  assert.equal(on.text, faulted.text);
  assert.equal(hasTrace(on.json), false);
});

test('inspectRun strips stored ids from history entries and keeps the other fields in order', () => {
  const key = { runKey: 'k/r/l', top: '/x', identity: { run: 'r', lineage: 'l' } };
  const graph = { tasks: [], phases: [], order: [] };
  const entry = { at: 'a', action: 'resume', by: 'o', reason: null, digest: 'd', epoch: 2, cleared: [] };
  const withIds = { ...entry, traceId: 'a'.repeat(32), traceLink: 'b'.repeat(32) };
  const view = (history) => inspectRun({ revision: 1, tasks: {}, runs: { 'k/r/l': { runKey: 'k/r/l', control: 'running', epoch: 2, history } } }, { slug: 's', key, graph });
  assert.deepEqual(view([withIds]).run.history, [entry]);
  assert.deepEqual(view([entry]).run.history, [entry]);
  assert.equal(Object.keys(view([withIds]).run.history[0]).join(), Object.keys(entry).join(), 'key order kept');
});

// ── a fault in the id source changes no outcome ─────────────────────────────────────────────────

test('a fault in the id source fails no command and leaves the record as if telemetry were off', (t) => {
  const p = project(t);
  const started = withFaultedIdSource(() => start({ ...p.common(), by: 'orchestrator' }));
  assert.equal(started.disposition, 'started');
  assert.equal(hasTrace(p.run()), false);
  const resumed = withFaultedIdSource(() => p.resumeAck());
  assert.equal(resumed.disposition, 'resumed');
  assert.equal(hasTrace(p.run()), false);

  // A fault on a resume does not drop the id the run already holds.
  const q = project(t);
  start({ ...q.common(), by: 'orchestrator' });
  const held = q.run().traceId;
  assert.equal(withFaultedIdSource(() => q.resumeAck()).disposition, 'resumed');
  assert.equal(q.run().traceId, held);
  const entry = q.run().history.find((h) => h.action === 'resume');
  assert.equal('traceId' in entry, false);
});

// ── the orchestrator start ──────────────────────────────────────────────────────────────────────

function orchestratorFor(p, who = {}, extra = {}) {
  return new WorkflowOrchestrator({
    repoRoot: REPO, projectRoot: p.dir, stateDir: path.join(p.dir, '.doflow', 'state', 'orchestration'),
    readinessEvaluate: () => 'READY', featureSlug: SLUG, env: p.env(who), cwd: p.dir, ...extra,
  });
}

test('orchestrator start stores runKey and copies the id of the 080 record', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  const orch = orchestratorFor(p);
  orch.start({ taskId: 'o.copy', taskClass: 'feature', now: NOW });
  const run = orch.readRun('o.copy');
  assert.equal(run.runKey, p.key());
  assert.equal(run.traceId, p.run().traceId);
  assert.match(run.traceId, HEX32);
});

test('orchestrator start without an 080 record stores runKey and no id; no new action is added', (t) => {
  const p = project(t);
  const orch = orchestratorFor(p);
  orch.start({ taskId: 'o.none', taskClass: 'feature', now: NOW });
  const run = orch.readRun('o.none');
  assert.equal(run.runKey, p.key());
  assert.equal('traceId' in run, false);
  assert.deepEqual(run.history.map((h) => h.action), ['start']);
});

test('orchestrator start with telemetry off, or a solo lineage, stores neither runKey nor id', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  const off = orchestratorFor(p, { off: true });
  off.start({ taskId: 'o.off', taskClass: 'feature', now: NOW });
  const plain = fs.readFileSync(off.runFile('o.off'), 'utf8'); // under the feature's namespace (115 C-1)
  assert.equal(plain.includes('runKey') || plain.includes('traceId'), false);

  const solo = orchestratorFor(p, { lineage: 'solo' });
  solo.start({ taskId: 'o.solo', taskClass: 'feature', now: NOW });
  const soloRun = solo.readRun('o.solo');
  assert.equal('runKey' in soloRun, false);
  assert.equal('traceId' in soloRun, false);
});

test('orchestrator off record equals the on record without the trace fields', (t) => {
  const p = project(t);
  start({ ...p.common(), by: 'orchestrator' });
  const onOrch = orchestratorFor(p);
  onOrch.start({ taskId: 'o.same', taskClass: 'feature', now: NOW });
  const offOrch = orchestratorFor(p, { off: true });
  offOrch.start({ taskId: 'o.same2', taskClass: 'feature', now: NOW });
  const strip = (r) => { const { runKey, traceId, taskId, revision, updatedAt, ...rest } = r; return rest; };
  assert.deepEqual(strip(onOrch.readRun('o.same')), strip(offOrch.readRun('o.same2')));
});

test('an unreadable 080 store does not fail the orchestrator start', (t) => {
  const p = project(t);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, '{ not json');
  const orch = orchestratorFor(p);
  assert.equal(orch.start({ taskId: 'o.bad', taskClass: 'feature', now: NOW }).state, 'RUNNING');
  const run = orch.readRun('o.bad');
  assert.equal(run.runKey, p.key());
  assert.equal('traceId' in run, false);
});
