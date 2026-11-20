'use strict';

// "Since you looked" on Now (180 C3, design §2, FR-A4): derive/digest.js compares the runs Now shows with the look this browser
// kept, and reads the `machine` member into the rows of the other projects. Pure functions: no DOM, no clock, no storage.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let digest: any;

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-digest-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  digest = await import(pathToFileURL(path.join(copy, 'derive', 'digest.js')).href);
});
after(() => { fs.rmSync(copy, { recursive: true, force: true }); });

const HERE = 'a1b2c3d4e5f60718';
const THERE = 'c1c2c3c4c5c6c7c8';
const OLD = 'd1d2d3d4d5d6d7d8';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const row = (projectKey: string, taskId: string, state: string, minutes = 1) => ({ projectKey, projectLabel: projectKey.slice(0, 4), taskId, slug: 'feat-a', state, updatedAt: at(minutes), gateName: null });
const look = (states: Record<string, string>, when = NOW - 3_600_000) => ({ at: when, states });

test('lookKey is <projectKey>:<taskId>', () => {
  assert.equal(digest.lookKey(row(HERE, 'T-1', 'RUNNING')), `${HERE}:T-1`);
});

test('sinceLooked lists the runs that appeared, changed state and left against the stored look', () => {
  const rows = [row(HERE, 'T-1', 'RUNNING'), row(HERE, 'T-2', 'AWAITING_GATE'), row(THERE, 'T-3', 'RUNNING')];
  const seen = look({ [`${HERE}:T-1`]: 'RUNNING', [`${HERE}:T-2`]: 'RUNNING', [`${THERE}:T-9`]: 'AWAITING_GATE' });
  const result = digest.sinceLooked(seen, rows, NOW);
  assert.equal(result.since, seen.at);
  assert.deepEqual(result.appeared.map((item: any) => [item.key, item.to]), [[`${THERE}:T-3`, 'RUNNING']]);
  assert.deepEqual(result.changed.map((item: any) => [item.key, item.from, item.to]), [[`${HERE}:T-2`, 'RUNNING', 'AWAITING_GATE']]);
  assert.deepEqual(result.left, [{ key: `${THERE}:T-9`, projectKey: THERE, taskId: 'T-9', from: 'AWAITING_GATE' }]);
  assert.equal(result.appeared[0].row, rows[2], 'an appeared item carries its row (project and slug)');
  const same = digest.sinceLooked(look({ [`${HERE}:T-1`]: 'RUNNING', [`${HERE}:T-2`]: 'AWAITING_GATE', [`${THERE}:T-3`]: 'RUNNING' }), rows, NOW);
  assert.deepEqual([same.appeared, same.changed, same.left], [[], [], []], 'control: nothing moved, nothing listed');
});

test('sinceLooked tolerates a missing or malformed store: no look, nothing listed', () => {
  const rows = [row(HERE, 'T-1', 'RUNNING')];
  const none = { since: null, appeared: [], changed: [], left: [] };
  for (const bad of [null, undefined, 'x', 42, [], {}, { at: 'yesterday', states: {} }, { at: NOW - 1, states: [] }, { at: NOW - 1, states: null },
    { at: NOW - 1, states: { [`${HERE}:T-1`]: 5 } }, { at: NOW + 60_000, states: {} }, { at: Number.NaN, states: {} }]) {
    assert.deepEqual(digest.sinceLooked(bad, rows, NOW), none, JSON.stringify(bad) ?? String(bad));
  }
  assert.notDeepEqual(digest.sinceLooked(look({}), rows, NOW), none, 'control: a well-formed empty look lists the run as new');
});

test('nextSeen keeps at most 200 keys, newest first, with the time of the look', () => {
  const rows = Array.from({ length: 250 }, (_, n) => row(n % 2 ? HERE : THERE, `T-${n}`, 'RUNNING', n));
  const next = digest.nextSeen(rows, NOW);
  assert.equal(next.at, NOW);
  const keys = Object.keys(next.states);
  assert.equal(keys.length, 200);
  assert.equal(digest.LOOK_LIMIT, 200);
  assert.ok(keys.includes(`${THERE}:T-0`) && keys.includes(`${HERE}:T-199`), 'the newest 200');
  assert.ok(!keys.includes(`${THERE}:T-200`) && !keys.includes(`${HERE}:T-249`), 'the oldest 50 are dropped');
  const result = digest.sinceLooked(next, rows, NOW + 1);
  assert.deepEqual([result.appeared.length, result.changed.length, result.left.length], [0, 0, 0], 'a run past the cap is never listed as new on every return');
  const stored = JSON.parse(JSON.stringify(next));
  assert.deepEqual(digest.sinceLooked(stored, rows, NOW + 1).appeared, [], 'the look survives a JSON round trip');
});

// ---- the machine member ---------------------------------------------------------------------------------------------------

const ok = (data: any) => ({ ok: true, data });
const open = (taskId: string, state: string, extra: any = {}) => ({ slug: 'feat-b', taskId, state, workflowName: 'Feature Delivery', step: { done: 2, total: 9 }, updatedAt: at(5), gateName: state === 'AWAITING_GATE' ? 'Approve design' : null, ...extra });
const item = (projectKey: string, openRuns: any[] | null, counts = { open: 0, awaiting: 0 }) => ({ projectKey, runs: counts, gates: [], openRuns, workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] });
const machine = (items: any[], projects = [[HERE, 'here', true], [THERE, 'there', false], [OLD, 'old', false]], notShown = 0) => ({
  v: 1,
  sections: {
    projects: ok({ v: 1, store: 'present', excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false,
      projects: projects.map(([projectKey, label, current]) => ({ projectKey, label, current, temp: false, checkouts: 1, sources: [], lastRecordAt: null })) }),
    activity: ok({ v: 1, limits: { projects: items.length, notShown, watched: items.length, fingerprintOnly: 0 }, items }),
  },
});

test('machineRuns: the other projects’ open runs as labelled rows, the current project left out, an older core as counts only', () => {
  const body = machine([
    item(HERE, [open('H-1', 'RUNNING')], { open: 1, awaiting: 0 }),
    item(THERE, [open('T-1', 'AWAITING_GATE'), open('T-2', 'RUNNING')], { open: 2, awaiting: 1 }),
    item(OLD, null, { open: 3, awaiting: 1 }),
  ], undefined, 4);
  const model = digest.machineRuns(body);
  assert.equal(model.currentKey, HERE);
  assert.equal(model.currentLabel, 'here');
  assert.deepEqual(model.others.map((r: any) => [r.projectKey, r.projectLabel, r.taskId, r.state, r.gateName]),
    [[THERE, 'there', 'T-1', 'AWAITING_GATE', 'Approve design'], [THERE, 'there', 'T-2', 'RUNNING', null]]);
  assert.deepEqual(model.countsOnly, [{ projectKey: OLD, label: 'old', open: 3, awaiting: 1 }]);
  assert.equal(model.notShown, 4);
  assert.deepEqual(digest.machineRows(body).map((r: any) => r.taskId), ['H-1', 'T-1', 'T-2'], 'every shown project, the current one too, for the notification');
});

test('machineRuns is null without a readable project list naming the current project; a missing activity gives no rows', () => {
  assert.equal(digest.machineRuns(null), null);
  assert.equal(digest.machineRuns({ v: 1, sections: { projects: { ok: false, code: 'x' }, activity: ok({ items: [], limits: null }) } }), null);
  assert.equal(digest.machineRuns(machine([], [[THERE, 'there', false]])), null, 'no current project: the rows cannot be told apart');
  const bare = machine([]);
  delete (bare.sections as any).activity;
  assert.deepEqual(digest.machineRuns(bare), { currentKey: HERE, currentLabel: 'here', others: [], countsOnly: [], notShown: 0 });
});

test('ownRows: the current project’s runs as rows keyed by its project', () => {
  const runs = [{ taskId: 'H-1', featureSlug: 'feat-a', state: 'COMPLETED', updatedAt: at(2), taskClass: 'feature' }, { taskId: 'H-2', featureSlug: null, state: 'RUNNING', updatedAt: null }];
  assert.deepEqual(digest.ownRows(runs, HERE, 'here'), [
    { projectKey: HERE, projectLabel: 'here', taskId: 'H-1', slug: 'feat-a', state: 'COMPLETED', updatedAt: at(2), gateName: null },
    { projectKey: HERE, projectLabel: 'here', taskId: 'H-2', slug: null, state: 'RUNNING', updatedAt: null, gateName: null },
  ]);
});
