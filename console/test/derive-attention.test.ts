'use strict';

// The shell's attention model (derive/attention.js): what waits for the person on this machine, from the `machine` member the
// live store holds. Pure functions: no DOM, no fetch, no clock. First test: a stream that is down with no record held reads
// `not observed` with its reason, never "nothing waiting".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DERIVE = path.join(__dirname, '..', 'web', 'derive');

let scratch: string[] = [];
let attention: any;

/** Copies of derive/attention.js and of what it imports (derive/layers.js, which reads derive/actions.js and derive/start.js), as ES modules a CommonJS package can import. */
async function load(): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-attention-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const name of ['attention.js', 'layers.js', 'actions.js', 'start.js']) fs.writeFileSync(path.join(dir, 'derive', name), fs.readFileSync(path.join(DERIVE, name), 'utf8'));
  return import(pathToFileURL(path.join(dir, 'derive', 'attention.js')).href);
}

before(async () => { attention = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

const HERE = 'a1b2c3d4e5f60718';
const THERE = 'c1c2c3c4c5c6c7c8';
const ok = (data: any) => ({ ok: true, data });
const gate = (taskId: string, slug: string | null = 'feat-a') => ({ slug, taskId, gateId: `g-${taskId}`, name: null, recordAt: '2026-11-15T09:00:00.000Z' });
const item = (projectKey: string, gates: any[]) => ({ projectKey, runs: { open: gates.length, awaiting: gates.length }, gates, workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] });
const body = (here: any[], there: any[] = [], activity: any = null) => ({
  v: 1,
  sections: {
    projects: ok({ v: 1, store: 'present', excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false, projects: [
      { projectKey: HERE, label: 'here', current: true, temp: false, checkouts: 1, sources: [], lastRecordAt: null },
      { projectKey: THERE, label: 'there', current: false, temp: false, checkouts: 1, sources: [], lastRecordAt: null },
    ] }),
    activity: activity ?? ok({ v: 1, limits: { projects: 2, notShown: 0, watched: 2, fingerprintOnly: 0 }, items: [item(HERE, here), item(THERE, there)] }),
  },
});
const open = { state: 'open', code: null };
const model = (b: any, transport: any = open, error: string | null = null) => attention.attentionModel({ body: b, transport, error });

test('no record held: a stream that is down, refused, unsupported or older than the core is not observed with its reason; connecting and paused say nothing', () => {
  assert.deepEqual(model(null, { state: 'retrying', code: 'silent' }), { kind: 'unobserved', reason: 'down', code: 'silent', held: false });
  assert.deepEqual(model(null, { state: 'refused', code: 'stream-limit' }), { kind: 'unobserved', reason: 'refused', code: 'stream-limit', held: false });
  assert.deepEqual(model(null, { state: 'unsupported', code: 'no-eventsource' }), { kind: 'unobserved', reason: 'unsupported', code: 'no-eventsource', held: false });
  assert.deepEqual(model(null, open, 'core-lacks-channel'), { kind: 'unobserved', reason: 'core-lacks-channel', code: 'core-lacks-channel', held: false });
  assert.deepEqual(model(null, { state: 'connecting', code: null }), { kind: 'quiet' });
  assert.deepEqual(model(null, { state: 'paused', code: null }), { kind: 'quiet' });
  assert.deepEqual(model(null, null), { kind: 'quiet' });
});

test('a followed, readable record with no awaiting gate is clear; an unreadable activity section is never read as clear', () => {
  assert.deepEqual(model(body([])), { kind: 'clear' });
  assert.deepEqual(model(body([], [], { ok: false, code: 'activity-failed' })), { kind: 'unobserved', reason: 'unreadable', code: 'activity-failed', held: false });
  const absent = body([]);
  delete (absent.sections as any).activity;
  assert.deepEqual(model(absent), { kind: 'quiet' }, 'the activity has not arrived: nothing is said');
  assert.deepEqual(model(absent, { state: 'closed', code: null }), { kind: 'unobserved', reason: 'down', code: null, held: false });
});

test('waiting gates are counted across the machine; the link opens the run for the one gate of this project, the project page for gates of one other project', () => {
  assert.deepEqual(model(body([gate('T-1')])), { kind: 'waiting', atLeast: false, missing: [], count: 1, projects: 1, place: 'here', label: null, target: '#/run/feat-a/T-1', held: false, reason: null, code: null });
  assert.deepEqual(model(body([], [gate('T-9')])), { kind: 'waiting', atLeast: false, missing: [], count: 1, projects: 1, place: 'other', label: 'there', target: `#/layers/${THERE}`, held: false, reason: null, code: null }, 'another project: its page, the run pages read this project only');
  assert.deepEqual(model(body([], [gate('T-8'), gate('T-9')])), { kind: 'waiting', atLeast: false, missing: [], count: 2, projects: 1, place: 'other', label: 'there', target: `#/layers/${THERE}`, held: false, reason: null, code: null });
  assert.deepEqual(model(body([gate('T-1', null)])), { kind: 'waiting', atLeast: false, missing: [], count: 1, projects: 1, place: 'here', label: null, target: '#/layers', held: false, reason: null, code: null }, 'no feature folder: no run page');
  assert.deepEqual(model(body([gate('T-1'), gate('T-2')], [gate('T-9')])), { kind: 'waiting', atLeast: false, missing: [], count: 3, projects: 2, place: 'several', label: null, target: '#/layers', held: false, reason: null, code: null });
  assert.equal(model(body([gate('T-1')]), { state: 'paused', code: null }).held, true);
  assert.equal(model(body([gate('T-1')]), open, 'events-down').held, true);
});

test('the words: a count and where, a held record says as of when, not observed says why; quiet and clear show nothing', () => {
  const words = attention.attentionWords;
  assert.deepEqual(words(model(body([gate('T-1')])), '09:30'), { state: 'awaiting', count: '1 gate waiting for you', where: 'on this machine, in this project', link: { href: '#/run/feat-a/T-1', text: 'Review' }, badge: '1' });
  assert.equal(words(model(body([], [gate('T-9')]))).where, 'on this machine, in there', 'the strip counts the machine and names the other project');
  assert.deepEqual(words(model(body([gate('T-1'), gate('T-2')], [gate('T-9')]), { state: 'retrying', code: null }), '09:30'),
    { state: 'awaiting', count: '3 gates waiting for you', where: 'on this machine, in 2 projects · as of 09:30, not observed since: the stream from the Console is down', link: { href: '#/layers', text: 'Review' }, badge: '3' });
  assert.deepEqual(words(model(null, { state: 'refused', code: 'stream-limit' })),
    { state: 'unknown', count: 'Waiting gates not observed', where: 'the Console refused this stream (stream-limit)', link: { href: '#/layers', text: 'Details' }, badge: null });
  assert.equal(words(model(null, { state: 'closed', code: null })).where, 'the stream from the Console is down');
  assert.equal(words(model(body([]))), null);
  assert.equal(words({ kind: 'quiet' }), null);
  for (const reason of Object.values(attention.UNOBSERVED_REASON)) assert.doesNotMatch(String(reason), /idle|nothing waiting/);
});

test('the project the Console runs in, by its label: what the Now page names beside the strip\'s machine count', () => {
  assert.equal(attention.currentProject(body([])), 'here');
  assert.equal(attention.currentProject(null), null);
  const none = body([]);
  for (const project of none.sections.projects.data.projects) project.current = false;
  assert.equal(attention.currentProject(none), null);
});

// ---- 162 review B-1, B-2, B-3: the count is the core's, never a silent absence, never a project it cannot name ----

const activityOf = (items: any[], notShown = 0) => ok({ v: 1, limits: { projects: 16, notShown, watched: 2, fingerprintOnly: 0 }, items });
const counted = (projectKey: string, gates: any[], awaiting: number, unreadable: string[] = []) => ({ ...item(projectKey, gates), runs: { open: awaiting, awaiting }, unreadable });

test('B-1: the count is the awaiting runs, not the at most 8 gates the core lists; left-out projects or an unreadable run store say at least', () => {
  const words = attention.attentionWords;
  const eight = Array.from({ length: 8 }, (_, i) => gate(`T-${i}`));
  const ten = model(body([], [], activityOf([counted(HERE, eight, 10), counted(THERE, [], 0)])));
  assert.equal(ten.count, 10, 'ten awaiting runs, eight gates listed');
  assert.equal(words(ten).count, '10 gates waiting for you');
  assert.equal(words(ten).badge, '10');

  const notShown = model(body([], [], activityOf([counted(HERE, [gate('T-1')], 1), counted(THERE, [], 0)], 5)));
  assert.deepEqual([notShown.kind, notShown.atLeast, notShown.missing], ['waiting', true, [{ reason: 'not-shown', n: 5 }]]);
  assert.deepEqual(words(notShown), { state: 'awaiting', count: 'At least 1 gate waiting for you', where: 'on this machine, in this project · not fully observed: 5 projects not summarized', link: { href: '#/run/feat-a/T-1', text: 'Review' }, badge: '1+' });

  // N may be 0: the strip is present and says what it did not observe.
  const none = model(body([], [], activityOf([counted(HERE, [], 0), counted(THERE, [], 0)], 5)));
  assert.deepEqual(none, { kind: 'partial', missing: [{ reason: 'not-shown', n: 5 }] });
  assert.deepEqual(words(none), { state: 'unknown', count: 'Gates on this machine not fully observed', where: '5 projects not summarized', link: { href: '#/layers', text: 'Details' }, badge: null });
  const broken = model(body([], [], activityOf([counted(HERE, [], 0, ['task-orchestration']), counted(THERE, [], 0)])));
  assert.deepEqual(broken, { kind: 'partial', missing: [{ reason: 'store-unreadable', n: 1 }] });
  assert.equal(words(broken).where, '1 project with an unreadable store');
  const both = model(body([], [], activityOf([counted(HERE, [gate('T-1')], 1, ['task-orchestration']), counted(THERE, [], 0)], 2)));
  assert.equal(words(both).count, 'At least 1 gate waiting for you');
  assert.match(words(both).where, /not fully observed: 2 projects not summarized, 1 project with an unreadable store$/);
  assert.deepEqual(model(body([], [], activityOf([counted(HERE, [], 0, ['worker-runs']), counted(THERE, [], 0, ['session-dirs'])]))), { kind: 'partial', missing: [{ reason: 'store-unreadable', n: 2 }] });
});

test('B-2: a record held after the stream stopped is never absent: it says not observed since its time and why, with zero gates too', () => {
  const words = attention.attentionWords;
  for (const [transport, error, reason, code] of [
    [{ state: 'retrying', code: null }, null, 'down', null],
    [{ state: 'closed', code: 'silent' }, null, 'down', 'silent'],
    [open, 'events-down', 'down', 'events-down'],
    [{ state: 'refused', code: 'retry-limit' }, null, 'refused', 'retry-limit'],
    [{ state: 'paused', code: null }, null, 'paused', null],
  ] as const) {
    const held = model(body([]), transport, error);
    assert.deepEqual(held, { kind: 'unobserved', reason, code, held: true }, JSON.stringify(transport));
    const said = words(held, '09:30');
    assert.notEqual(said, null, 'present');
    assert.equal(said.count, 'Waiting gates not observed since 09:30');
    assert.equal(said.state, 'unknown');
    assert.ok(said.where.startsWith(attention.UNOBSERVED_REASON[reason]), said.where);
  }
  assert.equal(words(model(body([]), { state: 'closed', code: null }), null).count, 'Waiting gates not observed', 'no time held: no since');
  // With gates held: the count as of its time, and why it is not observed since.
  const gates = words(model(body([gate('T-1')]), { state: 'closed', code: null }), '09:30');
  assert.equal(gates.where, 'on this machine, in this project · as of 09:30, not observed since: the stream from the Console is down');
});

test('B-3: with the project list unreadable a gate is on this machine only, and the link is the Layers page', () => {
  const words = attention.attentionWords;
  const unlisted = { v: 1, sections: { projects: { ok: false, code: 'projects-failed' }, activity: activityOf([counted(HERE, [gate('T-1')], 1)]) } };
  const waiting = model(unlisted);
  assert.deepEqual([waiting.kind, waiting.place, waiting.label, waiting.target], ['waiting', 'machine', null, '#/layers']);
  assert.deepEqual(words(waiting), { state: 'awaiting', count: '1 gate waiting for you', where: 'on this machine', link: { href: '#/layers', text: 'Review' }, badge: '1' });
  assert.doesNotMatch(JSON.stringify(words(waiting)), /another project|this project/);
});
