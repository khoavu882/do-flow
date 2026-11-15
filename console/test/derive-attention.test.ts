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

/** Copies of derive/attention.js and of what it imports (derive/layers.js, which reads derive/actions.js), as ES modules a CommonJS package can import. */
async function load(): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-attention-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const name of ['attention.js', 'layers.js', 'actions.js']) fs.writeFileSync(path.join(dir, 'derive', name), fs.readFileSync(path.join(DERIVE, name), 'utf8'));
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
  assert.deepEqual(model(null, { state: 'retrying', code: 'silent' }), { kind: 'unobserved', reason: 'down', code: 'silent' });
  assert.deepEqual(model(null, { state: 'refused', code: 'stream-limit' }), { kind: 'unobserved', reason: 'refused', code: 'stream-limit' });
  assert.deepEqual(model(null, { state: 'unsupported', code: 'no-eventsource' }), { kind: 'unobserved', reason: 'unsupported', code: 'no-eventsource' });
  assert.deepEqual(model(null, open, 'core-lacks-channel'), { kind: 'unobserved', reason: 'core-lacks-channel', code: 'core-lacks-channel' });
  assert.deepEqual(model(null, { state: 'connecting', code: null }), { kind: 'quiet' });
  assert.deepEqual(model(null, { state: 'paused', code: null }), { kind: 'quiet' });
  assert.deepEqual(model(null, null), { kind: 'quiet' });
});

test('a readable record with no awaiting gate is clear; an unreadable activity section is never read as clear', () => {
  assert.deepEqual(model(body([])), { kind: 'clear', held: false });
  assert.deepEqual(model(body([]), { state: 'retrying', code: null }), { kind: 'clear', held: true });
  assert.deepEqual(model(body([], [], { ok: false, code: 'activity-failed' })), { kind: 'unobserved', reason: 'unreadable', code: 'activity-failed' });
  const absent = body([]);
  delete (absent.sections as any).activity;
  assert.deepEqual(model(absent), { kind: 'quiet' }, 'the activity has not arrived: nothing is said');
  assert.deepEqual(model(absent, { state: 'closed', code: null }), { kind: 'unobserved', reason: 'down', code: null });
});

test('waiting gates are counted across the machine; the link opens the run for the one gate of this project, the project page for gates of one other project', () => {
  assert.deepEqual(model(body([gate('T-1')])), { kind: 'waiting', count: 1, projects: 1, place: 'here', label: null, target: '#/run/feat-a/T-1', held: false });
  assert.deepEqual(model(body([], [gate('T-9')])), { kind: 'waiting', count: 1, projects: 1, place: 'other', label: 'there', target: `#/layers/${THERE}`, held: false }, 'another project: its page, the run pages read this project only');
  assert.deepEqual(model(body([], [gate('T-8'), gate('T-9')])), { kind: 'waiting', count: 2, projects: 1, place: 'other', label: 'there', target: `#/layers/${THERE}`, held: false });
  assert.deepEqual(model(body([gate('T-1', null)])), { kind: 'waiting', count: 1, projects: 1, place: 'here', label: null, target: '#/layers', held: false }, 'no feature folder: no run page');
  assert.deepEqual(model(body([gate('T-1'), gate('T-2')], [gate('T-9')])), { kind: 'waiting', count: 3, projects: 2, place: 'several', label: null, target: '#/layers', held: false });
  assert.equal(model(body([gate('T-1')]), { state: 'paused', code: null }).held, true);
  assert.equal(model(body([gate('T-1')]), open, 'events-down').held, true);
});

test('the words: a count and where, a held record says as of when, not observed says why; quiet and clear show nothing', () => {
  const words = attention.attentionWords;
  assert.deepEqual(words(model(body([gate('T-1')])), '09:30'), { state: 'awaiting', count: '1 gate waiting for you', where: 'on this machine, in this project', link: { href: '#/run/feat-a/T-1', text: 'Review' }, badge: '1' });
  assert.equal(words(model(body([], [gate('T-9')]))).where, 'on this machine, in there', 'the strip counts the machine and names the other project');
  assert.deepEqual(words(model(body([gate('T-1'), gate('T-2')], [gate('T-9')]), { state: 'retrying', code: null }), '09:30'),
    { state: 'awaiting', count: '3 gates waiting for you', where: 'on this machine, in 2 projects · as of 09:30', link: { href: '#/layers', text: 'Review' }, badge: '3' });
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
