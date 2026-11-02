'use strict';

// `doflow-run attendance --task-id <slug> [--run <id>]` (autonomy plan section 2): every unattended and
// attended branch, an unreadable record, and that a forged environment value reaches only the worker
// branch. Scratch HOME/XDG throughout; nothing under the real config home or roadmap is read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { resolveAttendance, handleAttendanceCommand } = require('../../src/runtime/roadmap/attendance.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const RUN_ID = 'rl-20261031-abcd';
const SLUG = '113-toy';
const ON = () => ({ enabled: true, switch: null });
const OFF = () => ({ enabled: false, switch: 'setting' });

function fixture(t: any, { hold, record = {}, closedAt = null, perform = { stage: 'design' } }: any = {}) {
  const dir = tempDir(t, 'doflow-attendance-');
  const root = path.join(dir, 'main'), home = path.join(dir, 'home');
  fs.mkdirSync(path.join(root, 'agent-docs', 'roadmap'), { recursive: true });
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'roadmap', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'doflow'), { recursive: true });
  const row: any = { id: '113', slug: SLUG, title: 'Toy', class: 'feature', needs: [], writeSet: ['feature.txt'] };
  if (hold) row.hold = hold;
  fs.writeFileSync(path.join(root, 'agent-docs', 'roadmap', 'rows.json'), JSON.stringify({ schema: 1, rows: [row] }));
  const runFile = path.join(root, '.doflow', 'state', 'roadmap', 'runs', `${RUN_ID}.json`);
  const body = { schema: 1, runId: RUN_ID, createdAt: '2026-10-31T00:00:00.000Z', closedAt, maxSteps: null, steps: 0, n: 0, log: [],
    rows: { '113': perform ? { perform: { outcome: 'perform', runId: RUN_ID, row: '113', slug: SLUG, ...perform } } : {} }, ...record };
  fs.writeFileSync(runFile, JSON.stringify(body));
  const env: any = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    GIT_CONFIG_GLOBAL: '/dev/null', DOFLOW_CLI: CLI };
  for (const key of ['DOFLOW_SESSION_ROLE', 'DOFLOW_AUTOPILOT_ENABLED']) delete env[key];
  const enable = () => fs.writeFileSync(path.join(home, '.config', 'doflow', 'settings.json'), `${JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' })}\n`);
  const ask = (extra: any = {}) => resolveAttendance({ taskId: SLUG, root, env, readKillSwitch: ON, ...extra });
  return { dir, root, home, env, runFile, enable, ask };
}

test('worker role is unattended with no run record at all, and role matching is case-insensitive', (t) => {
  const f = fixture(t, { perform: null });
  fs.rmSync(f.runFile);
  for (const role of ['worker', 'WORKER', 'Worker']) {
    assert.deepEqual(f.ask({ env: { ...f.env, DOFLOW_SESSION_ROLE: role } }), { attendance: 'unattended', source: 'worker-role' });
  }
});

test('an unset, empty, main or unrecognised role is not the worker branch', (t) => {
  const f = fixture(t, { perform: null });
  for (const role of [undefined, '', 'main', 'MAIN', 'workers', 'subagent']) {
    const answer = f.ask({ env: { ...f.env, ...(role === undefined ? {} : { DOFLOW_SESSION_ROLE: role }) } });
    assert.deepEqual(answer, { attendance: 'attended', reason: 'no-pending-perform' }, String(role));
  }
});

test('an open run with a pending perform, a live row and the switch on is unattended, by named run or the newest open one', (t) => {
  const f = fixture(t);
  const expected = { attendance: 'unattended', source: 'run-record', run: RUN_ID };
  assert.deepEqual(f.ask({ run: RUN_ID }), expected);
  assert.deepEqual(f.ask(), expected);
});

test('attended: the kill switch is off', (t) => {
  assert.deepEqual(fixture(t).ask({ readKillSwitch: OFF }), { attendance: 'attended', reason: 'switch-off' });
});

test('attended: a switch reader that throws reads as off', (t) => {
  assert.deepEqual(fixture(t).ask({ readKillSwitch() { throw new Error('boom'); } }), { attendance: 'attended', reason: 'switch-off' });
});

test('attended: the run is closed', (t) => {
  const f = fixture(t, { closedAt: '2026-10-31T01:00:00.000Z' });
  assert.deepEqual(f.ask({ run: RUN_ID }), { attendance: 'attended', reason: 'run-closed' });
  assert.deepEqual(f.ask(), { attendance: 'attended', reason: 'no-run' }, 'a closed run is not the newest open one');
});

test('attended: no run record, or a named run that does not exist', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.ask({ run: 'rl-20261031-zzzz' }), { attendance: 'attended', reason: 'no-run' });
  fs.rmSync(f.runFile);
  assert.deepEqual(f.ask(), { attendance: 'attended', reason: 'no-run' });
});

test('attended: the row is on hold', (t) => {
  assert.deepEqual(fixture(t, { hold: 'person is editing it' }).ask(), { attendance: 'attended', reason: 'row-held' });
});

test('attended: the slot holds no perform (the stage was performed or never issued)', (t) => {
  assert.deepEqual(fixture(t, { perform: null }).ask(), { attendance: 'attended', reason: 'no-pending-perform' });
  assert.deepEqual(fixture(t, { perform: { stage: 7 } }).ask(), { attendance: 'attended', reason: 'no-pending-perform' });
});

const MARK = { stage: 'verification', purpose: 'post-merge', head: 'a'.repeat(40), issuedAt: '2026-10-31T00:00:01.000Z' };
const withMark = (mark: any, extra: any = {}) => ({ perform: null, record: { rows: { '113': { postMerge: mark, ...extra } } } });

test('AU-P10: a pending post-merge verification (the loop\'s postMerge marker, no slot.perform) is unattended', (t) => {
  assert.deepEqual(fixture(t, withMark(MARK)).ask(), { attendance: 'unattended', source: 'run-record', run: RUN_ID });
});

test('AU-P10: attended once the loop consumed the marker, for a missing, malformed or other-purpose marker', (t) => {
  assert.deepEqual(fixture(t, withMark(undefined)).ask(), { attendance: 'attended', reason: 'no-pending-perform' }, 'handoff done: the loop deleted the marker');
  assert.deepEqual(fixture(t, withMark({ stage: 'verification' })).ask(), { attendance: 'attended', reason: 'no-pending-perform' });
  assert.deepEqual(fixture(t, withMark({ ...MARK, purpose: 'other' })).ask(), { attendance: 'attended', reason: 'no-pending-perform' });
  assert.deepEqual(fixture(t, withMark({ ...MARK, stage: 7 })).ask(), { attendance: 'attended', reason: 'no-pending-perform' });
  assert.deepEqual(fixture(t, withMark('post-merge')).ask(), { attendance: 'attended', reason: 'no-pending-perform' });
});

test('AU-P10: a held or paused slot, a held row, a closed run and a switch-off all beat a stale post-merge marker', (t) => {
  assert.deepEqual(fixture(t, withMark(MARK, { held: { kind: 'intent', reason: 'plan-changed' } })).ask(), { attendance: 'attended', reason: 'slot-held' });
  assert.deepEqual(fixture(t, withMark(MARK, { paused: { reason: 'budget' } })).ask(), { attendance: 'attended', reason: 'slot-paused' });
  assert.deepEqual(fixture(t, { ...withMark(MARK), hold: 'user' }).ask(), { attendance: 'attended', reason: 'row-held' });
  assert.deepEqual(fixture(t, { ...withMark(MARK), closedAt: '2026-10-31T01:00:00.000Z' }).ask({ run: RUN_ID }), { attendance: 'attended', reason: 'run-closed' });
  assert.deepEqual(fixture(t, withMark(MARK)).ask({ readKillSwitch: OFF }), { attendance: 'attended', reason: 'switch-off' });
});

test('attended: the slot is held or paused, whatever else holds', (t) => {
  const f = fixture(t);
  const write = (slot: any) => {
    const body = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
    body.rows['113'] = { ...body.rows['113'], ...slot };
    fs.writeFileSync(f.runFile, JSON.stringify(body));
  };
  write({ held: { kind: 'gate', gate: 'gate-b', reason: 'verify-missing' } });
  assert.deepEqual(f.ask(), { attendance: 'attended', reason: 'slot-held' });
  write({ held: undefined, paused: { reason: 'budget' } });
  assert.deepEqual(f.ask(), { attendance: 'attended', reason: 'slot-paused' });
  write({ paused: undefined });
  assert.equal(f.ask().attendance, 'unattended', 'control: the same slot without a mark is unattended');
});

test('attended: a record the loop would call unreadable (steps, n or log missing or malformed)', (t) => {
  for (const drop of [['steps'], ['n'], ['log'], ['steps', 'n', 'log']]) {
    const f = fixture(t);
    const body = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
    for (const key of drop) delete body[key];
    fs.writeFileSync(f.runFile, JSON.stringify(body));
    assert.deepEqual(f.ask({ run: RUN_ID }), { attendance: 'attended', reason: 'run-unreadable' }, drop.join());
    assert.deepEqual(f.ask(), { attendance: 'attended', reason: 'run-unreadable' }, drop.join());
  }
  const g = fixture(t);
  const body = JSON.parse(fs.readFileSync(g.runFile, 'utf8'));
  body.steps = 1.5; body.log = {};
  fs.writeFileSync(g.runFile, JSON.stringify(body));
  assert.equal(g.ask().reason, 'run-unreadable');
});

test('attended: a slug that names no seed row', (t) => {
  assert.deepEqual(fixture(t).ask({ taskId: '999-other' }), { attendance: 'attended', reason: 'row-unknown' });
});

test('attended: an unreadable or malformed run record, or an unreadable seed', (t) => {
  for (const bytes of ['{not json', '{}', JSON.stringify({ schema: 2, runId: RUN_ID, rows: {}, createdAt: 'x' }), JSON.stringify({ schema: 1, runId: 'bad', rows: {}, createdAt: 'x' })]) {
    const f = fixture(t);
    fs.writeFileSync(f.runFile, bytes);
    assert.deepEqual(f.ask({ run: RUN_ID }), { attendance: 'attended', reason: 'run-unreadable' }, bytes);
    assert.deepEqual(f.ask(), { attendance: 'attended', reason: 'run-unreadable' }, bytes);
  }
  const g = fixture(t);
  fs.writeFileSync(path.join(g.root, 'agent-docs', 'roadmap', 'rows.json'), '{broken');
  assert.deepEqual(g.ask(), { attendance: 'attended', reason: 'seed-unreadable' });
});

test('a forged DOFLOW_SESSION_ROLE only ever opens the worker branch: a bogus value changes no run-record answer', (t) => {
  const f = fixture(t, { hold: 'held' });
  assert.deepEqual(f.ask({ env: { ...f.env, DOFLOW_SESSION_ROLE: 'not-a-role' } }), { attendance: 'attended', reason: 'row-held' });
  assert.deepEqual(f.ask({ env: { ...f.env, DOFLOW_SESSION_ROLE: 'main' } }), { attendance: 'attended', reason: 'row-held' });
  assert.deepEqual(f.ask({ env: { ...f.env, DOFLOW_SESSION_ROLE: 'worker' } }), { attendance: 'unattended', source: 'worker-role' });
});

test('the real kill-switch reader: off by default, on once the scratch user settings turn autopilot on', (t) => {
  const f = fixture(t);
  assert.equal(resolveAttendance({ taskId: SLUG, root: f.root, env: f.env }).reason, 'switch-off');
  f.enable();
  assert.equal(resolveAttendance({ taskId: SLUG, root: f.root, env: f.env }).attendance, 'unattended');
  assert.equal(resolveAttendance({ taskId: SLUG, root: f.root, env: { ...f.env, DOFLOW_AUTOPILOT_ENABLED: 'off' } }).reason, 'switch-off');
});

test('the verb writes nothing: the run record and the seed are byte-equal after any answer', (t) => {
  const f = fixture(t);
  const before = [fs.readFileSync(f.runFile, 'utf8'), fs.readFileSync(path.join(f.root, 'agent-docs/roadmap/rows.json'), 'utf8')];
  f.ask(); f.ask({ readKillSwitch: OFF });
  assert.deepEqual([fs.readFileSync(f.runFile, 'utf8'), fs.readFileSync(path.join(f.root, 'agent-docs/roadmap/rows.json'), 'utf8')], before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.doflow', 'state', 'roadmap')).sort(), ['runs']);
});

test('usage: a missing --task-id, a bad --run and an unsupported flag exit 2', (t) => {
  const f = fixture(t);
  const realLog = console.log, realErr = console.error, realExit = process.exitCode;
  console.log = () => {}; console.error = () => {};
  try {
    assert.equal(handleAttendanceCommand({ cwd: f.root, env: f.env }), 2);
    assert.equal(handleAttendanceCommand({ taskId: SLUG, run: 'bad', cwd: f.root, env: f.env }), 2);
    assert.equal(handleAttendanceCommand({ taskId: SLUG, flags: ['--task-id', '--force'], cwd: f.root, env: f.env }), 2);
    assert.equal(handleAttendanceCommand({ taskId: SLUG, action: 'x', flags: ['--task-id', '--action'], cwd: f.root, env: f.env }), 2);
  } finally { console.log = realLog; console.error = realErr; process.exitCode = realExit; }
});

test('the CLI and doflow-run print "unattended <source>" or "attended <reason>" and exit 0', (t) => {
  const f = fixture(t);
  const cli = (args: string[], env: any = f.env) => cp.spawnSync(process.execPath, [CLI, 'attendance', ...args], { cwd: f.root, env, encoding: 'utf8' });
  const off = cli(['--task-id', SLUG]);
  assert.deepEqual([off.status, off.stdout.trim()], [0, 'attended switch-off']);
  f.enable();
  const on = cli(['--task-id', SLUG, '--run', RUN_ID]);
  assert.deepEqual([on.status, on.stdout.trim()], [0, `unattended run-record ${RUN_ID}`]);
  const json = cli(['--task-id', SLUG, '--json']);
  assert.deepEqual(JSON.parse(json.stdout), { schema: 1, attendance: 'unattended', source: 'run-record', run: RUN_ID });
  const worker = cli(['--task-id', 'anything'], { ...f.env, DOFLOW_SESSION_ROLE: 'worker' });
  assert.equal(worker.stdout.trim(), 'unattended worker-role');
  const viaRun = cp.spawnSync(bashPath(), [RUN, 'attendance', '--task-id', SLUG], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.deepEqual([viaRun.status, viaRun.stdout.trim()], [0, `unattended run-record ${RUN_ID}`]);
  assert.equal(cli([]).status, 2);
});
