'use strict';

// The Sessions view's derivations (feature 093, IC-018; plan task E.7; design.md section 7a). Pure functions over the
// `GET /api/sessions` body: no DOM and no fetch. Control: joining lanes by harness name instead of by session key turns
// the no-merge case red (the control rewrites a copy of derive/sessions.js and re-runs the same case).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { project } = require('../src/project.ts');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'sessions.js'), 'utf8');

let scratch: string[] = [];
let sessions: any;

/** A copy of derive/sessions.js (optionally rewritten) with its imports, as ES modules a CommonJS package can import. */
async function load(source: string = SOURCE): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-sessions-'));
  scratch.push(dir);
  fs.cpSync(path.join(WEB_ROOT, 'derive'), path.join(dir, 'derive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'sessions.js'), source);
  return import(pathToFileURL(path.join(dir, 'derive', 'sessions.js')).href);
}

before(async () => { sessions = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- bodies -----------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const key = (n: number) => n.toString(16).padStart(16, '0');
const K = { main: key(1), linked: key(2), third: key(3), gone: key(4) };

// No commit time by default: a checkout with no record and a commit time is a C4 conflict, which only the C4 cases want.
const checkout = (worktreeKey: string, over: any = {}) => ({ worktreeKey, role: 'linked', current: false, branch: 'feat', head: 'abcdef012345', headCommittedAt: null, ...over });
const hook = (n: number, wk: string, over: any = {}) => ({
  sessionKey: key(100 + n), worktreeKey: wk, kind: 'hook', harness: 'codex', model: 'gpt-6-luna', modelFirstSeenAt: iso(3 * HOUR), startedAt: iso(3 * HOUR),
  branchAtStart: null, lastHookRecordAt: iso(HOUR), launched: null, ...over,
});
const attempt = (token: number, task: string, over: any = {}) => ({
  task, token, owner: 'core-implementer', mode: 'subagent', state: 'active', startedAt: iso(HOUR), endedAt: null, result: null, worktreeKey: K.main, run: 'local', lineage: 'main', ...over,
});
const entry = (slug: string, active: any[], overlaps: any[] = []) => ({ slug, revision: 1, overlaps, active });
const worker = (slug: string, task: string, token: number, state = 'running', over: any = {}) => ({
  slug, task, token, worker: { runId: 'w1', task, token, harness: 'codex', state, reason: null, startedAt: iso(HOUR), endedAt: null, attemptActive: true, ...over },
});
const section = (data: any) => ({ ok: true, data });
const observed = (checkouts: any[], list: any[] = [], over: any = {}) => ({ v: 1, store: 'present', checkouts, sessions: list, truncated: false, unreadable: 0, ...over });
const slot = (name: string, holder: any, waiters = 0) => ({ name, holder, waiters });
const body = (parts: any = {}) => ({
  v: 1,
  sections: {
    observed: section(parts.observed ?? observed([checkout(K.main, { role: 'main', current: true })])),
    slots: section(parts.slots ?? { v: 1, slots: [], unreadable: 0 }),
    runs: section(parts.runs ?? { v: 1, runs: [], unreadableCount: 0 }),
    tasks: section(parts.tasks ?? []),
    workers: section(parts.workers ?? []),
    roadmap: section(parts.roadmap ?? null),
    ...(parts.sections ?? {}),
  },
  limits: parts.limits ?? { runsInspected: 0, runsNotChecked: 0, workersChecked: 0, workersNotChecked: 0 },
});
const derive = (parts: any, now = NOW) => sessions.deriveSessions(body(parts), now);
const codes = (result: any) => result.conflicts.map((c: any) => c.code).sort();
const rowOf = (result: any, wk: string) => result.rows.find((r: any) => r.key === wk);
const lanesOf = (row: any) => row.lanes.map((l: any) => l.key);

// ---- rows -------------------------------------------------------------------------------------------------

test('rows are ordered: the current checkout, then conflicts, then records (newest first), then none', () => {
  // Input order is the reverse of the wanted one, so the sort has work to do.
  const result = derive({
    observed: observed([
      checkout(K.gone, { headCommittedAt: iso(40 * HOUR) }), // no record at all and a commit: outside DoFlow (C4)
      checkout(K.third, { headCommittedAt: iso(50 * HOUR) }), // records only
      checkout(K.linked, { headCommittedAt: iso(HOUR / 2) }), // records, and a commit newer than them (C4)
      checkout(K.main, { role: 'main', current: true }), // current
    ], [hook(1, K.third, { lastHookRecordAt: iso(2 * HOUR), startedAt: iso(5 * HOUR), modelFirstSeenAt: iso(5 * HOUR) }), hook(2, K.linked, { lastHookRecordAt: iso(3 * HOUR), startedAt: iso(4 * HOUR), modelFirstSeenAt: iso(4 * HOUR) })]),
  });
  assert.deepEqual(result.rows.map((r: any) => [r.key, r.group]), [[K.main, 'current'], [K.linked, 'conflict'], [K.gone, 'conflict'], [K.third, 'records']]);
});

test('the order without a conflict: records newest first, then rows with no record', () => {
  const fresh = (wk: string, extra: any = {}) => checkout(wk, { headCommittedAt: iso(500 * HOUR), ...extra });
  const result = derive({
    observed: observed([
      fresh(K.gone, { headCommittedAt: null }), // no commit time, no record
      fresh(K.third),
      fresh(K.linked),
      fresh(K.main, { role: 'main', current: true, headCommittedAt: null }),
    ], [hook(1, K.third, { lastHookRecordAt: iso(5 * HOUR) }), hook(2, K.linked, { lastHookRecordAt: iso(HOUR) })]),
  });
  assert.deepEqual(result.rows.map((r: any) => [r.key, r.group]), [[K.main, 'current'], [K.linked, 'records'], [K.third, 'records'], [K.gone, 'none']]);
});

test('a row names its checkout by branch, or "detached at <sha7>", and counts its lanes and holds', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true, branch: 'develop' }), checkout(K.linked, { branch: null, head: '725d3c7aabbcc' })], [hook(1, K.linked)]),
  });
  assert.equal(rowOf(result, K.main).label, 'develop');
  assert.equal(rowOf(result, K.linked).label, 'detached at 725d3c7');
  assert.deepEqual(rowOf(result, K.linked).counts, { lanes: 1, holds: 0 });
  assert.equal(rowOf(result, K.linked).head7, '725d3c7');
});

// ---- lanes ------------------------------------------------------------------------------------------------

test('lanes are never merged without a shared key: two sessions of one harness stay two lanes, and an observation with no session directory is its own lane', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true })], [
      hook(1, K.main, { harness: 'codex', startedAt: null }), // an observation only: no session directory, so no start
      hook(2, K.main, { harness: 'codex' }),
      hook(3, K.main, { harness: null, model: null, modelFirstSeenAt: null }), // a session directory only: the harness is not recorded
    ]),
    // A worker of the same harness is a lane of its own kind, never the hook session's.
    tasks: [entry('feat-a', [attempt(1, 'A.1')])],
    workers: [worker('feat-a', 'A.1', 1)],
  });
  const row = rowOf(result, K.main);
  assert.equal(row.lanes.filter((l: any) => l.kind === 'hook').length, 3);
  assert.equal(new Set(row.lanes.map((l: any) => l.key)).size, row.lanes.length, 'every lane key is unique');
  assert.equal(row.lanes.find((l: any) => l.key === `hook:${key(103)}`).harness, null);
  const run = row.lanes.find((l: any) => l.kind === 'run');
  assert.equal(run.children.length, 1, 'the worker nests under the run lane it serves');
  assert.equal(run.children[0].kind, 'worker');
});

test('control: joining lanes by harness name instead of the session key merges the no-merge case', async () => {
  const hookKey = 'hook:${s.sessionKey}';
  assert.ok(SOURCE.includes(hookKey), 'the lane key is built from the session key');
  const mutated = await load(SOURCE.replace(hookKey, 'hook:${s.harness}'));
  const input = body({ observed: observed([checkout(K.main, { role: 'main', current: true })], [hook(1, K.main), hook(2, K.main)]) });
  const count = (mod: any) => mod.deriveSessions(input, NOW).rows[0].lanes.filter((l: any) => l.kind === 'hook').length;
  assert.equal(count(sessions), 2);
  assert.notEqual(count(mutated), 2, 'by harness name the two sessions of one harness collapse');
});

test('a launched unit joins the DoFlow run lane with the same worktree, run and lineage; without one it stays its own lane', () => {
  const unit = (n: number, wk: string, run: string, lineage: string) => hook(n, wk, { kind: 'launched', harness: null, model: null, modelFirstSeenAt: null, launched: { run, lineage, attempt: '1' }, lastHookRecordAt: iso(HOUR / 4) });
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true }), checkout(K.linked)], [unit(1, K.main, 'run-two', 'lin2'), unit(2, K.main, 'run-nine', 'lin9'), unit(3, K.linked, 'run-two', 'lin2')]),
    tasks: [entry('feat-a', [attempt(1, 'A.1', { run: 'run-two', lineage: 'lin2' })])],
  });
  const main = rowOf(result, K.main);
  const joined = main.lanes.find((l: any) => l.key === `run:${K.main}/run-two/lin2`);
  assert.equal(joined.launched.length, 1, 'joined by worktree, run and lineage');
  assert.equal(joined.lastRecordAt, iso(HOUR / 4), 'the joined unit\'s hook record is the lane\'s newest record');
  assert.ok(main.lanes.some((l: any) => l.key === `launched:${key(102)}`), 'a unit with no attempts in its run is its own lane');
  assert.ok(rowOf(result, K.linked).lanes.some((l: any) => l.kind === 'launched'), 'the same run in another checkout does not join');
});

test('attempts group by worktree, run and lineage; a null key is its own group; unplaced records go to one last row', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true })]),
    tasks: [entry('feat-a', [
      attempt(1, 'A.1'), attempt(1, 'A.2'),
      attempt(1, 'A.3', { run: 'run-two', lineage: 'lin2' }),
      attempt(1, 'A.4', { worktreeKey: K.gone }), // a checkout this view does not list
      attempt(1, 'A.5', { worktreeKey: null, run: null, lineage: null }),
    ])],
    slots: { v: 1, slots: [slot('suite', { label: 'suite@x', since: iso(HOUR), alive: 'unknown', worktreeKey: null })], unreadable: 0 },
  });
  const main = rowOf(result, K.main);
  assert.deepEqual(main.lanes.map((l: any) => l.key), [`run:${K.main}/local/main`, `run:${K.main}/run-two/lin2`]);
  assert.equal(main.lanes[0].holds.length, 2, 'two attempts, one run lane');
  const last = result.rows[result.rows.length - 1];
  assert.equal(last.kind, 'unplaced');
  assert.deepEqual(last.lanes.map((l: any) => l.kind).sort(), ['lock', 'run', 'run']);
  assert.equal(result.rows.filter((r: any) => r.kind === 'unplaced').length, 1);
});

test('a worker lane carries the process check, nests under its attempt\'s run, and a null worker adds no lane', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true })]),
    tasks: [entry('feat-a', [attempt(1, 'A.1'), attempt(1, 'A.2')])],
    workers: [worker('feat-a', 'A.1', 1, 'running'), { slug: 'feat-a', task: 'A.2', token: 1, worker: null }],
  });
  const run = rowOf(result, K.main).lanes[0];
  assert.deepEqual(run.children.map((c: any) => [c.kind, c.token, c.mark]), [['worker', 'running', 'checked']]);
  assert.match(run.children[0].liveness, /process seen/);
  const gone = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true })]),
    tasks: [entry('feat-a', [attempt(1, 'A.1')])],
    workers: [worker('feat-a', 'A.1', 1, 'exited', { endedAt: iso(HOUR / 2), reason: 'process-lost' })],
  });
  const ended = rowOf(gone, K.main).lanes[0].children[0];
  assert.equal(ended.token, 'done');
  assert.match(ended.liveness, /process gone/);
});

test('a lock lane sits in the checkout of its holder; alive true is running, false is stale, unknown is recorded only', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true }), checkout(K.linked)]),
    slots: { v: 1, slots: [
      slot('build', { label: 'build@linked', since: iso(2 * HOUR), alive: false, worktreeKey: K.linked }, 1),
      slot('suite', { label: 'suite@main', since: iso(HOUR), alive: true, worktreeKey: K.main }),
      slot('gate', { label: 'gate@main', since: iso(HOUR), alive: 'unknown', worktreeKey: K.main }),
      slot('idle', null, 2), // waiters only: nothing is held
    ], unreadable: 0 },
  });
  assert.deepEqual(rowOf(result, K.main).lanes.map((l: any) => [l.key, l.token, l.mark]), [['lock:suite', 'running', 'checked'], ['lock:gate', 'unknown', 'recorded']]);
  assert.deepEqual(rowOf(result, K.linked).lanes.map((l: any) => [l.key, l.token]), [['lock:build', 'stale']]);
  assert.ok(!result.rows.some((r: any) => r.lanes.some((l: any) => l.key === 'lock:idle')));
});

test('the roadmap lease shows on the main checkout\'s row as a hold with its liveness not checked', () => {
  const result = derive({
    observed: observed([checkout(K.linked), checkout(K.main, { role: 'main' })]),
    roadmap: { run: 'rd-1', lease: { runId: 'rd-1', acquiredAt: iso(4 * HOUR) }, holds: [{ row: '104', state: 'held', kind: 'review' }] },
  });
  const main = rowOf(result, K.main);
  const lease = main.holds.find((h: any) => h.kind === 'lease');
  assert.ok(lease);
  assert.match(lease.text, /liveness not checked/);
  assert.equal(lease.since, iso(4 * HOUR));
  assert.ok(main.holds.some((h: any) => h.kind === 'roadmap-hold'));
  assert.equal(rowOf(result, K.linked).holds.length, 0);
});

// ---- conflicts --------------------------------------------------------------------------------------------

const overlap = { a: 'A.4', b: 'A.6', fileCount: 2 };
const pair = (a: any, b: any, over: any = {}) => derive({
  observed: observed([checkout(K.main, { role: 'main', current: true }), checkout(K.linked)]),
  tasks: [entry('feat-a', [a, b].filter(Boolean), [overlap])],
  ...over,
});

test('C1 only when both overlapping tasks have active attempts from a different worktree or run/lineage', () => {
  const a = attempt(1, 'A.4');
  const differentRun = attempt(1, 'A.6', { run: 'run-two', lineage: 'lin2' });
  const differentLineage = attempt(1, 'A.6', { lineage: 'lin2' });
  const differentTree = attempt(1, 'A.6', { worktreeKey: K.linked });
  const same = attempt(1, 'A.6');
  assert.deepEqual(codes(pair(a, differentRun)), ['C1']);
  assert.deepEqual(codes(pair(a, differentLineage)), ['C1']);
  assert.deepEqual(codes(pair(a, differentTree)), ['C1']);
  assert.deepEqual(codes(pair(a, same)), [], 'one run holds both: no conflict');
  assert.deepEqual(codes(pair(a, null)), [], 'the second task has no active attempt');
  assert.deepEqual(codes(pair(a, attempt(1, 'A.9', { run: 'run-two' }))), [], 'an active attempt on a task that is not in the pair');
  const split = pair(a, differentTree);
  const c1 = split.conflicts[0];
  assert.equal(c1.id, 'C1:feat-a:A.4:A.6');
  assert.deepEqual([...c1.rowKeys].sort(), [K.main, K.linked].sort());
  assert.ok(rowOf(split, K.linked).conflicts.includes(c1));
  assert.ok(rowOf(split, K.main).conflicts.includes(c1));
});

test('C2 at 24 h and only with no live worker: absent, unknown or ended', () => {
  const claim = (agoH: number) => attempt(1, 'A.1', { startedAt: iso(agoH * HOUR) });
  const run = (agoH: number, workers: any[] = []) => derive({ observed: observed([checkout(K.main, { role: 'main', current: true })]), tasks: [entry('feat-a', [claim(agoH)])], workers });
  assert.deepEqual(codes(run(23.9)), [], 'under 24 h');
  assert.deepEqual(codes(run(24.1)), ['C2'], 'over 24 h with no worker run');
  assert.deepEqual(codes(run(30, [worker('feat-a', 'A.1', 1, 'running')])), [], 'a running worker is a live worker');
  assert.deepEqual(codes(run(30, [worker('feat-a', 'A.1', 1, 'starting')])), []);
  assert.deepEqual(codes(run(30, [worker('feat-a', 'A.1', 1, 'unknown')])), ['C2']);
  assert.deepEqual(codes(run(30, [worker('feat-a', 'A.1', 1, 'exited')])), ['C2']);
  assert.deepEqual(codes(run(30, [worker('feat-a', 'A.1', 1, 'timed-out')])), ['C2']);
  assert.deepEqual(codes(run(30, [{ slug: 'feat-a', task: 'A.1', token: 1, worker: null }])), ['C2']);
  const c2 = run(30).conflicts[0];
  assert.equal(c2.id, 'C2:feat-a:A.1:1');
  assert.equal(sessions.conflictWords(c2).text, 'Claimed 30 h ago; no record since');
  assert.equal(run(30).rows[0].lanes[0].token, 'stale');
  assert.equal(run(1).rows[0].lanes[0].token, 'unknown');
});

test('C3 from alive false only', () => {
  const lock = (alive: any) => derive({ observed: observed([checkout(K.main, { role: 'main', current: true })]), slots: { v: 1, slots: [slot('build', { label: 'b', since: iso(HOUR), alive, worktreeKey: K.main })], unreadable: 0 } });
  assert.deepEqual(codes(lock(false)), ['C3']);
  assert.deepEqual(codes(lock(true)), []);
  assert.deepEqual(codes(lock('unknown')), []);
  assert.equal(sessions.conflictWords(lock(false).conflicts[0]).text, 'Held by a process that has exited; the next slot call clears it');
  assert.equal(lock(false).conflicts[0].id, 'C3:build');
});

test('C4 when the HEAD commit is after the newest record of that checkout', () => {
  const run = (head: string | null, list: any[]) => derive({ observed: observed([checkout(K.main, { role: 'main', current: true, headCommittedAt: head })], list) });
  const record = hook(1, K.main, { startedAt: iso(5 * HOUR), modelFirstSeenAt: iso(5 * HOUR), lastHookRecordAt: iso(4 * HOUR) });
  assert.deepEqual(codes(run(iso(3 * HOUR), [record])), ['C4'], 'a commit after the last record');
  assert.deepEqual(codes(run(iso(4 * HOUR), [record])), [], 'the same second is not after');
  assert.deepEqual(codes(run(iso(6 * HOUR), [record])), [], 'a commit before the last record');
  assert.deepEqual(codes(run(null, [record])), [], 'no commit time');
  assert.deepEqual(codes(run(iso(6 * HOUR), [])), ['C4'], 'no record at all: the Codex-app worktree case');
  const c4 = run(iso(3 * HOUR), [record]).conflicts[0];
  assert.equal(c4.id, `C4:${K.main}`);
  assert.equal(c4.recordAt, iso(4 * HOUR));
  assert.equal(run(iso(6 * HOUR), []).conflicts[0].recordAt, null);
  // The newest record of a checkout is the newest of every lane's times, a start and a model first seen included.
  assert.deepEqual(codes(run(iso(3 * HOUR), [hook(2, K.main, { startedAt: iso(2 * HOUR), lastHookRecordAt: null })])), [], 'a later start counts as a record');
});

test('the conflict words: the overlap names both tasks and the two runs; the outside-DoFlow sentence shows both times and attributes nothing', () => {
  const c1 = pair(attempt(1, 'A.4'), attempt(1, 'A.6', { run: 'run-two', lineage: 'lin2' })).conflicts[0];
  assert.deepEqual(sessions.conflictWords(c1), { label: 'Overlap', text: 'A.4 and A.6 share 2 declared files, held by two runs', announce: 'New conflict: A.4 and A.6 overlap, held by two runs' });
  const one = sessions.conflictWords({ ...c1, fileCount: 1 });
  assert.match(one.text, /share 1 declared file,/);
  const c4 = derive({ observed: observed([checkout(K.main, { role: 'main', current: true, headCommittedAt: iso(HOUR) })], [hook(1, K.main, { lastHookRecordAt: iso(3 * HOUR), startedAt: iso(3 * HOUR), modelFirstSeenAt: iso(3 * HOUR) })]) }).conflicts[0];
  const clock = (ms: number) => `T${ms - NOW}`;
  assert.equal(sessions.conflictWords(c4, clock).text, `Git shows a commit at T${-HOUR}; DoFlow has no record from this checkout after T${-3 * HOUR}`);
  const none = derive({ observed: observed([checkout(K.main, { role: 'main', current: true, headCommittedAt: iso(HOUR) })]) }).conflicts[0];
  assert.equal(sessions.conflictWords(none, clock).text, `Git shows a commit at T${-HOUR}; DoFlow has no record from this checkout`);
  assert.equal(sessions.conflictWords(c4).label, 'Outside DoFlow');
  assert.equal(sessions.conflictWords(pair(attempt(1, 'A.4'), null, { slots: { v: 1, slots: [slot('b', { label: 'b', since: iso(HOUR), alive: false, worktreeKey: K.main })], unreadable: 0 } }).conflicts[0]).label, 'Dead lock holder');
});

// ---- liveness words ---------------------------------------------------------------------------------------

test('no main-session lane carries a live state, and no lane text says active, online or idle', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true })], [
      hook(1, K.main),
      hook(2, K.main, { kind: 'launched', harness: null, model: null, launched: { run: 'run-nine', lineage: 'lin9', attempt: '2' } }),
    ]),
    tasks: [entry('feat-a', [attempt(1, 'A.1')])],
  });
  const row = rowOf(result, K.main);
  const mains = row.lanes.filter((l: any) => l.kind === 'hook' || l.kind === 'launched');
  assert.equal(mains.length, 2);
  for (const lane of mains) {
    assert.equal(lane.token, 'unknown');
    assert.equal(lane.mark, 'recorded');
    assert.notEqual(lane.token, 'running');
  }
  const everything = JSON.stringify(row.lanes.map((l: any) => [l.liveness, l.title, sessions.laneName(l, row)]));
  assert.doesNotMatch(everything, /\b(active|online|idle)\b/i);
  // A claim with no worker is recorded, not running: a run lane alone never reads as live.
  assert.equal(row.lanes.find((l: any) => l.kind === 'run').token, 'unknown');
});

test('accessible names state kind, harness or owner, times and holds, and the checkout', () => {
  const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true, branch: null, head: '725d3c7aabbcc' })], [hook(1, K.main, { harness: 'codex', model: 'gpt-6-luna', startedAt: iso(3 * HOUR), lastHookRecordAt: iso(HOUR) })]),
  });
  const row = rowOf(result, K.main);
  assert.equal(sessions.laneName(row.lanes[0], row, clock), 'Hook session, codex, model gpt-6-luna, started 09:00, last hook record 11:00, holds nothing, checkout detached at 725d3c7');
  const noHarness = derive({ observed: observed([checkout(K.main, { role: 'main', current: true })], [hook(1, K.main, { harness: null, model: null, modelFirstSeenAt: null })]) });
  assert.match(sessions.laneName(noHarness.rows[0].lanes[0], noHarness.rows[0], clock), /^Hook session, harness not recorded, model not recorded,/);
  const full = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true, headCommittedAt: iso(20 * HOUR) })]),
    tasks: [entry('feat-a', [attempt(1, 'A.1')])],
    slots: { v: 1, slots: [slot('build', { label: 'b', since: iso(HOUR), alive: true, worktreeKey: K.main })], unreadable: 0 },
    workers: [worker('feat-a', 'A.1', 1)],
  });
  const names = full.rows[0].lanes.flatMap((l: any) => [l, ...l.children]).map((l: any) => sessions.laneName(l, full.rows[0], clock));
  assert.ok(names.some((n: string) => /^DoFlow run local\/main, holds 1 claim: A\.1 in feat-a by core-implementer since 11:00/.test(n)), names.join(' | '));
  assert.ok(names.some((n: string) => /^Worker, codex, process seen/.test(n)));
  assert.ok(names.some((n: string) => /^Lock build, process seen, since 11:00, holds the slot build/.test(n)));
  assert.match(sessions.rowName(full.rows[0], clock), /^This checkout, main, branch feat, HEAD abcdef0 committed 16:00, 3 lanes, 2 holds, no conflicts$/);
});

// ---- sections, states, filter, announcements -------------------------------------------------------------

test('a failed section is named and the others still derive; a failed observed has no rows', () => {
  const failed = (code: string) => ({ ok: false, code });
  const partial = sessions.deriveSessions(body({ sections: { slots: failed('core-error'), roadmap: failed('core-contract-mismatch') }, observed: observed([checkout(K.main, { role: 'main', current: true })], [hook(1, K.main)]) }), NOW);
  assert.equal(partial.rows.length, 1);
  assert.equal(partial.rows[0].lanes.length, 1);
  assert.deepEqual(partial.notes.map((n: any) => [n.name, n.code]), [['slots', 'core-error'], ['roadmap', 'core-contract-mismatch']]);
  const noRows = sessions.deriveSessions(body({ sections: { observed: failed('cannot-list-checkouts') } }), NOW);
  assert.deepEqual(noRows.rows, []);
  assert.equal(noRows.notes[0].name, 'observed');
  assert.match(sessions.noteWords(noRows.notes[0]), /Git did not answer/);
  // tasks and workers fail with runs; one note per failed section, in a fixed order.
  const withRuns = sessions.deriveSessions(body({ sections: { runs: failed('core-error'), tasks: failed('core-error'), workers: failed('core-error') } }), NOW);
  assert.deepEqual(withRuns.notes.map((n: any) => n.name), ['runs', 'tasks', 'workers']);
});

test('no config home is observed.store absent; the empty state is one checkout with no lane, hold or lease', () => {
  const absent = derive({ observed: observed([checkout(K.main, { role: 'main', current: true })], [], { store: 'absent' }) });
  assert.equal(absent.storeAbsent, true);
  assert.equal(absent.empty, true);
  assert.equal(derive({}).storeAbsent, false);
  assert.equal(derive({ observed: observed([checkout(K.main, { role: 'main', current: true }), checkout(K.linked)]) }).empty, false, 'two checkouts are not "only this checkout"');
  assert.equal(derive({ observed: observed([checkout(K.main, { role: 'main', current: true })], [hook(1, K.main)]) }).empty, false);
  assert.equal(derive({ observed: observed([checkout(K.main, { role: 'main', current: true })]), roadmap: { run: 'r', lease: { runId: 'r', acquiredAt: iso(HOUR) }, holds: [] } }).empty, false);
});

test('limits are carried through, with the truncated and unreadable counts of the reads', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true })], [], { truncated: true, unreadable: 3 }),
    slots: { v: 1, slots: [], unreadable: 2 },
    limits: { runsInspected: 20, runsNotChecked: 4, workersChecked: 16, workersNotChecked: 5 },
  });
  assert.deepEqual(result.limits, { runsInspected: 20, runsNotChecked: 4, workersChecked: 16, workersNotChecked: 5, truncated: true, observedUnreadable: 3, slotsUnreadable: 2 });
  assert.deepEqual(sessions.limitWords(result.limits), ['20 runs checked, 4 not checked', '16 workers checked, 5 not checked', 'hook records cut at the read limit', '3 hook records unreadable', '2 locks unreadable']);
});

test('the filter chips: conflicts, with records, all', () => {
  const result = derive({
    observed: observed([checkout(K.main, { role: 'main', current: true }), checkout(K.linked, { headCommittedAt: iso(HOUR / 2) }), checkout(K.third, { headCommittedAt: iso(500 * HOUR) })], [hook(1, K.linked, { lastHookRecordAt: iso(2 * HOUR), startedAt: iso(2 * HOUR), modelFirstSeenAt: iso(2 * HOUR) }), hook(2, K.third)]),
  });
  const keys = (filter: string) => sessions.filterRows(result.rows, filter).map((r: any) => r.key);
  assert.deepEqual(keys('all'), [K.main, K.linked, K.third]);
  assert.deepEqual(keys('conflicts'), [K.linked]);
  assert.deepEqual(keys('records'), [K.linked, K.third]);
  assert.deepEqual(keys('nonsense'), keys('all'));
});

test('a new conflict is announced once: only ids absent from the previous set; none on the first read', () => {
  const first = pair(attempt(1, 'A.4'), attempt(1, 'A.6', { run: 'run-two', lineage: 'lin2' }));
  assert.deepEqual(sessions.newConflicts(null, first.conflicts), [], 'the first read announces nothing');
  assert.deepEqual(sessions.newConflicts(new Set(), first.conflicts).map((c: any) => c.id), ['C1:feat-a:A.4:A.6']);
  assert.deepEqual(sessions.newConflicts(new Set(['C1:feat-a:A.4:A.6']), first.conflicts), []);
  assert.deepEqual(sessions.newConflicts(new Set(['C9:x']), []), []);
});

// ---- keyboard ---------------------------------------------------------------------------------------------

test('keyboard: rows are one tab stop each; Right goes into the lanes, Up and Down walk them, Left goes back', () => {
  const layout = [{ lanes: 2 }, { lanes: 0 }, { lanes: 1 }];
  const go = (at: any, k: string) => sessions.moveFocus(layout, at, k);
  assert.deepEqual(go({ row: 0, lane: null }, 'ArrowDown'), { row: 1, lane: null });
  assert.deepEqual(go({ row: 1, lane: null }, 'ArrowUp'), { row: 0, lane: null });
  assert.equal(go({ row: 0, lane: null }, 'ArrowUp'), null);
  assert.equal(go({ row: 2, lane: null }, 'ArrowDown'), null);
  assert.deepEqual(go({ row: 0, lane: null }, 'End'), { row: 2, lane: null });
  assert.deepEqual(go({ row: 2, lane: null }, 'Home'), { row: 0, lane: null });
  assert.deepEqual(go({ row: 0, lane: null }, 'ArrowRight'), { row: 0, lane: 0 });
  assert.equal(go({ row: 1, lane: null }, 'ArrowRight'), null, 'a row with no lane has nowhere to go');
  assert.deepEqual(go({ row: 0, lane: 0 }, 'ArrowDown'), { row: 0, lane: 1 });
  assert.equal(go({ row: 0, lane: 1 }, 'ArrowDown'), null);
  assert.deepEqual(go({ row: 0, lane: 1 }, 'ArrowUp'), { row: 0, lane: 0 });
  assert.equal(go({ row: 0, lane: 0 }, 'ArrowUp'), null);
  assert.deepEqual(go({ row: 0, lane: 1 }, 'ArrowLeft'), { row: 0, lane: null });
  assert.equal(go({ row: 0, lane: null }, 'ArrowLeft'), null);
  assert.equal(go({ row: 0, lane: null }, 'x'), null);
});

// ---- the real projection ----------------------------------------------------------------------------------

test('a body built from project() outputs derives without a shape error (the allow-listed field sets are what the derivation reads)', () => {
  const real = {
    observed: project('observed', observed([checkout(K.main, { role: 'main', current: true })], [hook(1, K.main)])),
    slots: project('slots', { v: 1, slots: [slot('build', { label: 'b', since: iso(HOUR), alive: false, worktreeKey: K.main }, 0)], unreadable: 0 }),
  };
  assert.equal(real.observed.ok, true);
  assert.equal(real.slots.ok, true);
  const result = derive({ observed: (real.observed as any).body, slots: (real.slots as any).body });
  assert.deepEqual(codes(result), ['C3']);
  assert.equal(rowOf(result, K.main).lanes.length, 2);
});
