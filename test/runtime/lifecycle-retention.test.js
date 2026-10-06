'use strict';

// The retention switch: DOFLOW_RETENTION_HOURS parsing, which event files are eligible, the
// journal-first removal and its roll-forward, and the stderr lines. Every spawn runs under the
// scratch HOME and XDG_CONFIG_HOME, and sets DOFLOW_RETENTION_HOURS itself or not at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const store = require('../../src/runtime/lifecycle/event-store');
const { parseWindow, selectExpired } = require('../../src/runtime/lifecycle/retention');
const { prepareStore, LEGACY_EVENTS_REL, LEGACY_LIFECYCLE_REL } = require('../../src/runtime/lifecycle/store-upkeep');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const POSIX = process.platform !== 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;
const HOUR = 3600000;
const NOTICE = 'note: the lifecycle store is now .doflow/state/lifecycle/events; agent-docs/lifecycle/ is no longer read and can be deleted';

const scratch = createScratch('doflow-retention-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

let count = 0;
function project(name) {
  const dir = path.join(scratch.dir, `${name}-${(count += 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let serial = 0;
/** One IC-002 envelope dated `atMs`; ids are unique across the file. */
function ev(type, data, atMs) {
  serial += 1;
  const at = new Date(atMs).toISOString();
  return { v: 1, id: `${at.replace(/[-:.]/g, '')}-${String(serial).padStart(6, '0')}`, type, at, by: 'agent', data };
}
const fileOf = (event) => `${event.id}.json`;
function writeAll(folder, events) {
  fs.mkdirSync(folder, { recursive: true });
  for (const event of events) fs.writeFileSync(path.join(folder, fileOf(event)), `${JSON.stringify(event, null, 2)}\n`);
  return events.map(fileOf);
}
const eventsDir = (dir) => path.join(dir, store.EVENTS_REL);
const eventFiles = (dir) => (fs.existsSync(eventsDir(dir)) ? fs.readdirSync(eventsDir(dir)).filter(store.isEventName).sort() : []);

/** Builders for one item's history, every event `hoursAgo` (or later ones a little after it). */
function at(now, hoursAgo, plusMs = 0) { return now - hoursAgo * HOUR + plusMs; }
const added = (id, ms, source = { kind: 'manual' }) => ev('followup.added', { id, statement: `s ${id}`, source }, ms);
const settled = (id, as, ms, extra = {}) => ev('followup.settled', { id, as, ...(as === 'done' ? { evidence: 'proof' } : { reason: 'why' }), ...extra }, ms);
const dismissedFollowup = (id, now, hoursAgo) => [added(id, at(now, hoursAgo)), settled(id, 'dismissed', at(now, hoursAgo, 1))];
const doneGoal = (goal, now, hoursAgo) => [
  ev('goal.added', { goal, outcome: `o ${goal}`, items: [{ id: 'I-1', text: 'x' }] }, at(now, hoursAgo + 2)),
  ev('goal.done', { goal, reason: 'enough' }, at(now, hoursAgo)),
];

function run(cwd, args, hours) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: scratch.env(hours === undefined ? {} : { DOFLOW_RETENTION_HOURS: hours }), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const retentionLines = (stderr) => stderr.split('\n').filter((l) => /: (retention|warning): /.test(l));

function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
    const file = path.join(dir, rel);
    const st = fs.lstatSync(file);
    out[rel] = { mode: st.mode, mtimeMs: st.mtimeMs, sha: st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
  }
  return out;
}
const journal = (dir) => JSON.parse(fs.readFileSync(path.join(dir, store.JOURNAL_REL), 'utf8'));

// ── the window ─────────────────────────────────────────────────────────────────────────────────

test('parseWindow: unset and empty are off; a positive whole number is on; anything else is invalid', () => {
  assert.deepEqual(parseWindow({}), { state: 'off' });
  assert.deepEqual(parseWindow({ DOFLOW_RETENTION_HOURS: '' }), { state: 'off' });
  assert.deepEqual(parseWindow({ DOFLOW_RETENTION_HOURS: '24' }), { state: 'on', hours: 24, ms: 24 * HOUR });
  for (const raw of ['0', '-5', 'soon', ' 24', '24 ', '1.5', '007', '1e3', '9007199254740993']) {
    assert.deepEqual(parseWindow({ DOFLOW_RETENTION_HOURS: raw }), { state: 'invalid', raw }, raw);
  }
});

test('unset or empty keeps everything and prints no line', () => {
  const dir = project('off');
  const files = writeAll(eventsDir(dir), dismissedFollowup('FU-aaaaaa', Date.now(), 1000));
  for (const hours of [undefined, '']) {
    const r = run(dir, ['followup', '--action', 'list', '--json'], hours);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(retentionLines(r.stderr), []);
  }
  assert.deepEqual(eventFiles(dir), files.sort());
  assert.equal(fs.existsSync(path.join(dir, store.JOURNAL_REL)), false);
});

test('an invalid window warns once, removes nothing, and the verb completes', () => {
  const dir = project('invalid');
  const files = writeAll(eventsDir(dir), dismissedFollowup('FU-aaaaaa', Date.now(), 1000));
  for (const raw of ['0', '-5', 'soon', ' 24', '1.5', '99999999999999999999']) {
    const r = run(dir, ['followup', '--action', 'list', '--state', 'all', '--json'], raw);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.items.map((i) => i.id), ['FU-aaaaaa']);
    assert.deepEqual(retentionLines(r.stderr), [`doflow followup: warning: DOFLOW_RETENTION_HOURS='${raw}' is not a positive whole number of hours; ignored, nothing removed`], raw);
  }
  assert.deepEqual(eventFiles(dir), files.sort());
});

// ── what is removed and what is kept ───────────────────────────────────────────────────────────

test('a done goal whose newest event is 48 h old is removed with a 24 h window, with one count line', () => {
  const dir = project('done-goal');
  writeAll(eventsDir(dir), doneGoal('G-aaaaaa', Date.now(), 48));
  const r = run(dir, ['goal', '--action', 'list', '--json'], '24');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(retentionLines(r.stderr), ['doflow goal: retention: removed 2 event files older than 24 h']);
  assert.deepEqual(r.json.goals, []);
  assert.deepEqual(eventFiles(dir), []);
  assert.deepEqual(journal(dir).pending, []);
  assert.match(journal(dir).generation, /^[0-9a-hjkmnp-tv-z]{16}$/);
  assert.deepEqual(retentionLines(run(dir, ['goal', '--action', 'list', '--json'], '24').stderr), [], 'nothing left: no line');
});

test('a settled follow-up whose newest event is 1 h old is kept with a 24 h window', () => {
  const dir = project('recent');
  const now = Date.now();
  const files = writeAll(eventsDir(dir), [added('FU-aaaaaa', at(now, 100)), settled('FU-aaaaaa', 'dismissed', at(now, 1))]);
  const r = run(dir, ['followup', '--action', 'list', '--json'], '24');
  assert.deepEqual(retentionLines(r.stderr), []);
  assert.deepEqual(eventFiles(dir), files.sort());
});

test('open, fix-routed, promoted, taken and failure follow-ups and an open goal, all a week old, are kept with a 1 h window', () => {
  const dir = project('unsettled');
  const now = Date.now();
  const old = (plus) => at(now, 200, plus);
  const files = writeAll(eventsDir(dir), [
    ev('feature.tracked', { slug: 'f1' }, old(0)),
    added('FU-aaaaaa', old(1)),
    added('FU-bbbbbb', old(2)), settled('FU-bbbbbb', 'fix', old(3)),
    added('FU-cccccc', old(4)), ev('followup.promoted', { ids: ['FU-cccccc'], intent: 'next-thing' }, old(5)),
    added('FU-dddddd', old(6)), ev('followup.taken', { ids: ['FU-dddddd'], feature: 'f1' }, old(7)),
    added('FU-eeeeee', old(8), { kind: 'failure', ref: '0123456789abcdef' }),
    ev('goal.added', { goal: 'G-aaaaaa', outcome: 'o', items: [{ id: 'I-1', text: 'x' }] }, old(9)),
  ]);
  const r = run(dir, ['followup', '--action', 'list', '--state', 'all', '--json'], '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(retentionLines(r.stderr), []);
  assert.deepEqual(eventFiles(dir), files.sort());
});

test('a dismissed and a done follow-up are removed; nothing else is', () => {
  const dir = project('settled');
  const now = Date.now();
  const keep = writeAll(eventsDir(dir), [added('FU-cccccc', at(now, 200))]);
  writeAll(eventsDir(dir), [...dismissedFollowup('FU-aaaaaa', now, 200), added('FU-bbbbbb', at(now, 200)), settled('FU-bbbbbb', 'done', at(now, 199))]);
  const r = run(dir, ['followup', '--action', 'list', '--state', 'all', '--json'], '1');
  assert.deepEqual(retentionLines(r.stderr), ['doflow followup: retention: removed 4 event files older than 1 h']);
  assert.deepEqual(r.json.items.map((i) => i.id), ['FU-cccccc']);
  assert.deepEqual(eventFiles(dir), keep);
});

test('two follow-ups joined by one followup.taken go together or not at all', () => {
  const now = new Date('2026-10-06T12:00:00.000Z').getTime();
  const old = (plus) => at(now, 200, plus);
  const events = [
    ev('feature.tracked', { slug: 'f1' }, old(0)),
    added('FU-aaaaaa', old(1)), added('FU-bbbbbb', old(2)),
    ev('followup.taken', { ids: ['FU-aaaaaa', 'FU-bbbbbb'], feature: 'f1' }, old(3)),
    settled('FU-aaaaaa', 'kept', old(4)), settled('FU-bbbbbb', 'kept', old(5)),
    settled('FU-aaaaaa', 'done', old(6)),
  ];
  const options = { now: new Date(now), windowMs: HOUR };
  assert.deepEqual(selectExpired(events, options), { files: [], units: [] }, 'FU-bbbbbb is open, so FU-aaaaaa stays too');
  const last = settled('FU-bbbbbb', 'dismissed', old(7));
  const both = selectExpired([...events, last], options);
  assert.deepEqual(both.units.map((u) => u.items), [['followup:FU-aaaaaa', 'followup:FU-bbbbbb']]);
  assert.equal(both.units[0].newestAt, last.at);
  assert.deepEqual(both.files, [...events.slice(1), last].map(fileOf).sort());
});

test('a done goal linked to a tracked feature is kept; an unlinked done goal beside it still goes', () => {
  const now = new Date('2026-10-06T12:00:00.000Z').getTime();
  const linked = doneGoal('G-aaaaaa', now, 100);
  const link = ev('goal.linked', { goal: 'G-aaaaaa', slug: 'f1' }, at(now, 101));
  const free = doneGoal('G-bbbbbb', now, 100);
  const events = [ev('feature.tracked', { slug: 'f1' }, at(now, 300)), ...linked, link, ...free];
  const out = selectExpired(events, { now: new Date(now), windowMs: HOUR });
  assert.deepEqual(out.units.map((u) => u.items), [['goal:G-bbbbbb']]);
  assert.deepEqual(out.files, free.map(fileOf).sort());
});

test('feature, merge, release and unknown-type events are never removed', () => {
  const now = new Date('2026-10-06T12:00:00.000Z').getTime();
  const events = [
    ev('feature.tracked', { slug: 'f1' }, at(now, 900)),
    ev('feature.merged', { slug: 'f1', reason: 'r' }, at(now, 899)),
    ev('release.recorded', { tag: 'v1.0.0', features: [{ slug: 'f1' }] }, at(now, 898)),
    ev('custom.thing', { id: 'FU-aaaaaa', goal: 'G-aaaaaa' }, at(now, 897)),
    ev('followup.settled', { id: 7, as: 'done' }, at(now, 896)),
  ];
  assert.deepEqual(selectExpired(events, { now: new Date(now), windowMs: HOUR }), { files: [], units: [] });
});

test('a future-dated event keeps its item, though the fold leaves that event out', () => {
  const now = new Date('2026-10-06T12:00:00.000Z').getTime();
  const events = [...dismissedFollowup('FU-aaaaaa', now, 200), settled('FU-aaaaaa', 'kept', now + 48 * HOUR)];
  assert.deepEqual(selectExpired(events, { now: new Date(now), windowMs: HOUR }).files, []);
  assert.equal(selectExpired(events.slice(0, 2), { now: new Date(now), windowMs: HOUR }).files.length, 2);
});

test('a report follow-up removed by retention leaves its body under the XDG folder untouched', () => {
  const dir = project('report');
  const reported = run(dir, ['followup', '--action', 'report', '--statement', 'a report', '--text', 'the body text', '--json']);
  assert.equal(reported.status, 0, reported.stderr);
  const id = reported.json.created[0].id;
  assert.equal(run(dir, ['followup', '--action', 'settle', '--ids', id, '--as', 'dismissed', '--reason', 'noise', '--json']).status, 0);
  // Age the store by two days: each event is rewritten under an id that matches its new time.
  for (const name of eventFiles(dir)) {
    const event = JSON.parse(fs.readFileSync(path.join(eventsDir(dir), name), 'utf8'));
    const aged = { ...event, at: new Date(Date.parse(event.at) - 48 * HOUR).toISOString() };
    aged.id = `${aged.at.replace(/[-:.]/g, '')}-${event.id.slice(-6)}`;
    fs.writeFileSync(path.join(eventsDir(dir), fileOf(aged)), JSON.stringify(aged));
    fs.unlinkSync(path.join(eventsDir(dir), name));
  }
  const reports = path.join(scratch.xdg, 'doflow', 'reports');
  const bodies = snapshot(reports);
  assert.ok(Object.keys(bodies).some((rel) => rel.endsWith(`${id}.txt`)), 'the body is on this machine');
  const r = run(dir, ['followup', '--action', 'list', '--state', 'all', '--json'], '24');
  assert.deepEqual(retentionLines(r.stderr), ['doflow followup: retention: removed 2 event files older than 24 h']);
  assert.deepEqual(snapshot(reports), bodies);
});

test('the remaining items read the same before and after a pass, for followup, goal and lifecycle', () => {
  const dir = project('equal');
  const now = Date.now();
  writeAll(eventsDir(dir), [
    added('FU-aaaaaa', at(now, 300)), ...dismissedFollowup('FU-bbbbbb', now, 300),
    added('FU-cccccc', at(now, 299)), settled('FU-cccccc', 'fix', at(now, 298)),
    ...doneGoal('G-aaaaaa', now, 300),
    ev('goal.added', { goal: 'G-bbbbbb', outcome: 'open one', items: [{ id: 'I-1', text: 'x' }] }, at(now, 297)),
    ev('goal.checked', { goal: 'G-bbbbbb', item: 'I-1', met: true, evidence: 'e' }, at(now, 296)),
  ]);
  const reads = (hours) => ({
    followups: run(dir, ['followup', '--action', 'list', '--state', 'all', '--json'], hours).json,
    goals: run(dir, ['goal', '--action', 'list', '--json'], hours).json,
    overview: run(dir, ['lifecycle', '--json'], hours).json,
  });
  const before = reads(undefined);
  const after = reads('1');
  assert.equal(eventFiles(dir).length, 5, 'the dismissed follow-up and the done goal went');
  assert.deepEqual(after.followups.items, before.followups.items.filter((i) => i.id !== 'FU-bbbbbb'));
  assert.deepEqual(after.goals.goals, before.goals.goals.filter((g) => g.goal !== 'G-aaaaaa'));
  const withoutGoal = (o) => ({ ...o, goals: o.goals.filter((g) => g.goal !== 'G-aaaaaa') });
  assert.deepEqual(after.overview, withoutGoal(before.overview));
});

// ── the journal ────────────────────────────────────────────────────────────────────────────────

test('a journal left with pending files hides them, and the next verb removes them with no count line', () => {
  const dir = project('rollforward');
  const now = Date.now();
  const [gone] = writeAll(eventsDir(dir), [added('FU-aaaaaa', at(now, 5))]);
  const [kept] = writeAll(eventsDir(dir), [added('FU-bbbbbb', at(now, 4))]);
  fs.writeFileSync(path.join(dir, store.JOURNAL_REL), JSON.stringify({ v: 1, generation: 'aaaaaaaaaaaaaaaa', pending: [gone] }));
  assert.deepEqual(store.readEvents(dir).events.map((e) => e.data.id), ['FU-bbbbbb']);
  const r = run(dir, ['followup', '--action', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(retentionLines(r.stderr), []);
  assert.deepEqual(r.json.items.map((i) => i.id), ['FU-bbbbbb']);
  assert.deepEqual(eventFiles(dir), [kept]);
  assert.deepEqual(journal(dir).pending, []);
  assert.notEqual(journal(dir).generation, 'aaaaaaaaaaaaaaaa');
});

test('an unlink failure keeps the journal and hides the files, warns, and the next pass finishes with no count line', () => {
  const dir = project('unlink-fault');
  const now = Date.now();
  const files = writeAll(eventsDir(dir), dismissedFollowup('FU-aaaaaa', now, 200)).sort();
  const failing = {
    ...fs,
    unlinkSync: (p) => {
      if (path.basename(String(p)) === files[1]) throw Object.assign(new Error('no'), { code: 'EPERM' });
      return fs.unlinkSync(p);
    },
  };
  const out = prepareStore(dir, { env: { DOFLOW_RETENTION_HOURS: '1' }, fsImpl: failing });
  assert.deepEqual(out, { ok: true, lines: ['warning: retention could not remove every file (EPERM); they stay hidden and the next lifecycle command finishes the removal'] });
  assert.deepEqual(journal(dir).pending, files);
  assert.deepEqual(store.readEvents(dir).events, []);
  assert.deepEqual(eventFiles(dir), [files[1]]);
  assert.deepEqual(prepareStore(dir, { env: {} }), { ok: true, lines: [] });
  assert.deepEqual(eventFiles(dir), []);
  assert.deepEqual(journal(dir).pending, []);
});

test('an events folder that refuses unlinks: the verb exits 0 with the warning', { skip: !POSIX || ROOT_USER }, () => {
  const dir = project('unlink-readonly');
  const files = writeAll(eventsDir(dir), dismissedFollowup('FU-aaaaaa', Date.now(), 200)).sort();
  fs.chmodSync(eventsDir(dir), 0o555);
  try {
    const r = run(dir, ['followup', '--action', 'list', '--json'], '1');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.items, []);
    assert.deepEqual(retentionLines(r.stderr), ['doflow followup: warning: retention could not remove every file (EACCES); they stay hidden and the next lifecycle command finishes the removal']);
    assert.deepEqual(journal(dir).pending, files);
  } finally {
    fs.chmodSync(eventsDir(dir), 0o755);
  }
  assert.equal(run(dir, ['followup', '--action', 'list', '--json']).status, 0);
  assert.deepEqual(eventFiles(dir), []);
});

test('two processes started together both exit 0 and each eligible unit is removed once', async () => {
  const dir = project('concurrent');
  const now = Date.now();
  const files = writeAll(eventsDir(dir), Array.from({ length: 10 }, (_, i) => dismissedFollowup(`FU-${String(i).padStart(6, '0')}`, now, 200)).flat());
  const once = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'followup', '--action', 'list', '--json'], { cwd: dir, env: scratch.env({ DOFLOW_RETENTION_HOURS: '1' }) });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([once(), once()]);
  assert.deepEqual(results.map((r) => r.code), [0, 0]);
  const removed = results.flatMap((r) => retentionLines(r.stderr)).map((l) => Number(/removed (\d+) /.exec(l)[1]));
  assert.deepEqual(removed, [files.length], 'one pass removed every file; the other found nothing');
  assert.deepEqual(eventFiles(dir), []);
});

test('run state under .doflow/state and an old agent-docs/lifecycle folder keep their hashes', () => {
  const dir = project('untouched');
  const now = Date.now();
  writeAll(eventsDir(dir), dismissedFollowup('FU-aaaaaa', now, 200));
  writeAll(path.join(dir, LEGACY_EVENTS_REL), dismissedFollowup('FU-bbbbbb', now, 200));
  for (const sub of ['evidence', 'orchestration', 'outcomes']) {
    fs.mkdirSync(path.join(dir, '.doflow', 'state', sub), { recursive: true });
    fs.writeFileSync(path.join(dir, '.doflow', 'state', sub, 'run.json'), '{"old":true}');
  }
  const state = (s) => Object.fromEntries(Object.entries(s).filter(([rel]) => !rel.startsWith('lifecycle')));
  const runState = state(snapshot(path.join(dir, '.doflow', 'state')));
  const legacy = snapshot(path.join(dir, LEGACY_LIFECYCLE_REL));
  const r = run(dir, ['followup', '--action', 'list', '--json'], '1');
  assert.deepEqual(retentionLines(r.stderr), ['doflow followup: retention: removed 2 event files older than 1 h']);
  assert.deepEqual(state(snapshot(path.join(dir, '.doflow', 'state'))), runState);
  assert.deepEqual(snapshot(path.join(dir, LEGACY_LIFECYCLE_REL)), legacy);
});

test('retention runs after a copy in the same invocation, and the notice prints before the count line', () => {
  const dir = project('after-copy');
  const now = Date.now();
  writeAll(path.join(dir, LEGACY_EVENTS_REL), dismissedFollowup('FU-aaaaaa', now, 200));
  const [open] = writeAll(path.join(dir, LEGACY_EVENTS_REL), [added('FU-bbbbbb', at(now, 200))]);
  const legacy = snapshot(path.join(dir, LEGACY_LIFECYCLE_REL));
  const r = run(dir, ['followup', '--action', 'list', '--json'], '1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stderr.split('\n').filter(Boolean), [`doflow followup: ${NOTICE}`, 'doflow followup: retention: removed 2 event files older than 1 h']);
  assert.deepEqual(eventFiles(dir), [open]);
  assert.deepEqual(snapshot(path.join(dir, LEGACY_LIFECYCLE_REL)), legacy);
});
