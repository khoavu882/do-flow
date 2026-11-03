'use strict';

// `followup --action list` views (feature 137, IC-004, IC-008, IC-003): brief and paged by default, the full view
// as today's object, the `--ids` filter, refusals and usage errors, text paging, and compact JSON off a terminal.
// Runs the verb through the dispatcher in a scratch HOME, as the other verb-view tests do.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo } = require('../helper/lifecycle-git-fixtures.ts');
const { addFollowups, listFollowups, followupOrderKey } = require('../../src/runtime/lifecycle/followup.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const TOTAL = 200;

const scratch = createScratch('doflow-followup-view-');
before(() => scratch.apply());
after(() => { scratch.restore(); scratch.remove(); });

let fixture: any = null;
/** One repository holding 200 open follow-ups, built once for the file. */
function seeded() {
  if (fixture) return fixture;
  const repo = makeRepo(scratch, 'followup-view');
  const dir = fs.realpathSync(repo.dir);
  const items = Array.from({ length: TOTAL }, (_, i) => ({ statement: `Fixture follow-up ${String(i).padStart(3, '0')}` }));
  const added = addFollowups({ root: dir, cwd: dir, items, defaults: { source: 'manual', batch: true } });
  assert.equal(added.ok, true);
  fixture = { dir, ids: added.created.map((c: any) => c.id) };
  return fixture;
}

function run(args: string[], extra: Record<string, string> = {}) {
  const { dir } = seeded();
  const r = spawnSync(bashPath(), [RUN, 'followup', ...args], { cwd: dir, env: scratch.env({ DOFLOW_CLI: BIN, ...extra }), encoding: 'utf8' });
  let json: any = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const list = (...args: string[]) => run(['--action', 'list', ...args, '--json']);

/** The line of `next` starting with `label`, or undefined. */
const line = (answer: any, label: string) => (answer.next || []).find((n: string) => n.startsWith(`${label}:`));

test('the default list is brief: count 200, shown 10, no history, body or excerpt, page and full-view lines', () => {
  const r = list();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.view, 'brief');
  assert.equal(r.json.count, TOTAL);
  assert.equal(r.json.shown, 10);
  assert.equal(r.json.items.length, 10);
  for (const item of r.json.items) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'state', 'statement']);
    assert.equal(item.state, 'open');
  }
  assert.match(r.json.nextCursor, /^[0-9]{1,15}:[0-9]{8}T[0-9]{9}Z-[0-9a-hjkmnp-tv-z]{6}$/);
  assert.equal(line(r.json, 'Next page'), `Next page: doflow-run followup --action list --cursor ${r.json.nextCursor}`);
  assert.equal(line(r.json, 'Full view of this page'), 'Full view of this page: doflow-run followup --action list --limit 10 --view full --json');
  assert.equal(r.json.next.length, 2);
  assert.deepEqual(Object.keys(r.json).slice(0, 6), ['view', 'ok', 'action', 'state', 'count', 'shown']);
  assert.equal(JSON.stringify(r.json).includes('history'), false);
});

test('the Full view of this page line, run as written, prints the full payload of the same page', () => {
  const brief = list();
  const command = line(brief.json, 'Full view of this page').split(': ')[1].split(' ');
  assert.deepEqual(command.slice(0, 2), ['doflow-run', 'followup']);
  const full = run(command.slice(2));
  assert.equal(full.status, 0, full.stderr);
  assert.equal(full.json.view, 'full');
  assert.deepEqual(full.json.items.map((i: any) => i.id), brief.json.items.map((i: any) => i.id));
  assert.equal('history' in full.json.items[0], true, 'the full items carry their history');
});

test('in text mode the page lines carry no --json', () => {
  const r = run(['--action', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /next: Full view of this page: doflow-run followup --action list --limit 10 --view full\n/);
});

test('--view brief is the default answer, and the JSON printed off a terminal is one compact line', () => {
  const plain = list();
  const brief = list('--view', 'brief');
  assert.deepEqual(brief.json, plain.json);
  assert.equal(plain.stdout.trimEnd().includes('\n'), false, 'one line');
  assert.equal(plain.stdout, `${JSON.stringify(plain.json)}\n`);
});

test('--view full with no cursor and no limit is the service object field for field, with no envelope', () => {
  const { dir } = seeded();
  const r = list('--view', 'full');
  assert.equal(r.status, 0, r.stderr);
  const expected = JSON.parse(JSON.stringify(listFollowups({ root: dir })));
  assert.deepEqual(r.json, expected);
  assert.equal(r.json.items.length, TOTAL);
  for (const key of ['view', 'shown', 'nextCursor']) assert.equal(key in r.json, false, key);
  assert.ok(r.json.items[0].history.length >= 1, 'the full item keeps its history');
  assert.deepEqual(r.json.next, []);
});

test('a walk by nextCursor visits all 200 ids once, in the full view order, and ends on a null cursor', () => {
  const { ids } = seeded();
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r: any = list('--limit', '50', ...(cursor ? ['--cursor', cursor] : []));
    assert.equal(r.status, 0, r.stderr);
    seen.push(...r.json.items.map((i: any) => i.id));
    cursor = r.json.nextCursor;
    pages += 1;
    if (cursor) assert.equal(line(r.json, 'Next page'), `Next page: doflow-run followup --action list --cursor ${cursor} --limit 50`);
    else assert.equal(line(r.json, 'Next page'), undefined);
  } while (cursor && pages < 10);
  assert.equal(pages, 4);
  assert.deepEqual(seen, list('--view', 'full').json.items.map((i: any) => i.id));
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test('the full-view line carries the input cursor and --limit <shown>, and names the same page in the full view', () => {
  const first = list('--limit', '3');
  const cursor = first.json.nextCursor;
  const second = list('--cursor', cursor, '--limit', '3');
  assert.equal(line(second.json, 'Full view of this page'), `Full view of this page: doflow-run followup --action list --cursor ${cursor} --limit 3 --view full --json`);
  const page = list('--cursor', cursor, '--limit', '3', '--view', 'full');
  assert.equal(page.status, 0, page.stderr);
  assert.deepEqual(page.json.items.map((i: any) => i.id), second.json.items.map((i: any) => i.id));
  assert.ok(page.json.items.every((i: any) => Array.isArray(i.history)), 'items in their full form');
});

test('a paged full-view call adds view, shown and nextCursor to today object, and its next page stays in the full view', () => {
  const r = list('--view', 'full', '--limit', '5');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.view, 'full');
  assert.equal(r.json.shown, 5);
  assert.equal(r.json.count, TOTAL);
  assert.equal(r.json.items.length, 5);
  assert.deepEqual(Object.keys(r.json).slice(0, 6), ['view', 'ok', 'action', 'state', 'count', 'shown']);
  assert.deepEqual(r.json.next, [`Next page: doflow-run followup --action list --cursor ${r.json.nextCursor} --limit 5 --view full`]);
  const last = list('--view', 'full', '--cursor', list('--limit', '100').json.nextCursor, '--limit', '100');
  assert.equal(last.json.shown, 100);
  assert.equal(last.json.nextCursor, null);
  assert.deepEqual(last.json.next, []);
});

test('--limit above 100 returns at most 100; a limit that is not a whole number of 1 or more is usage, exit 2', () => {
  const big = list('--limit', '500');
  assert.equal(big.json.shown, 100);
  assert.notEqual(big.json.nextCursor, null);
  for (const bad of ['0', '1.5', 'ten', '1e2']) {
    const r = list('--limit', bad);
    assert.equal(r.status, 2, `limit '${bad}'`);
    assert.match(r.stdout + r.stderr, /--limit must be a whole number of 1 or more \(at most 100 are returned\)/);
  }
});

test('a cursor that does not decode, or a view other than brief or full, is usage, exit 2', () => {
  const cursor = list('--cursor', 'not-a-cursor');
  assert.equal(cursor.status, 2);
  assert.match(cursor.stdout + cursor.stderr, /--cursor must be the nextCursor of an earlier list/);
  const view = list('--view', 'compact');
  assert.equal(view.status, 2);
  assert.match(view.stdout + view.stderr, /--view must be brief or full \(got 'compact'\)/);
});

test('--view, --cursor and --limit on another followup action are usage, exit 2, before anything is written', () => {
  const { ids } = seeded();
  for (const flag of [['--view', 'full'], ['--cursor', '1:20261102T152312345Z-wq105h'], ['--limit', '5']]) {
    const r = run(['--action', 'take', '--ids', ids[0], '--slug', 'x-feature', ...flag, '--json']);
    assert.equal(r.status, 2, flag[0]);
    assert.match(r.stdout + r.stderr, new RegExp(`${flag[0]} applies to --action list only`));
  }
  assert.equal(list('--state', 'taken').json.count, 0, 'nothing was taken');
});

test('--ids lists the named items in every state and pages them; an unknown id is the unknown-id refusal, exit 1', () => {
  const { ids } = seeded();
  const some = [ids[7], ids[3]];
  const r = list('--ids', some.join(','));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'all');
  assert.equal(r.json.count, 2);
  assert.deepEqual(r.json.items.map((i: any) => i.id).sort(), [...some].sort());
  assert.equal(line(r.json, 'Full view of this page'), `Full view of this page: doflow-run followup --action list --ids ${some.join(',')} --limit 2 --view full --json`);
  const full = list('--ids', ids[5], '--view', 'full');
  assert.equal(full.json.items.length, 1);
  assert.equal(full.json.view, undefined);
  const unknown = list('--ids', `${ids[0]},FU-zzzzzz`);
  assert.equal(unknown.status, 1);
  assert.deepEqual([unknown.json.ok, unknown.json.action, unknown.json.finding], [false, 'list', 'unknown-id']);
  assert.match(unknown.json.message, /FU-zzzzzz/);
  assert.equal(list('--ids', 'nope').status, 2);
});

test('--state is carried into the next lines and still filters', () => {
  const r = list('--state', 'open', '--limit', '4');
  assert.equal(r.json.state, 'open');
  assert.equal(line(r.json, 'Next page'), `Next page: doflow-run followup --action list --state open --cursor ${r.json.nextCursor} --limit 4`);
  const done = list('--state', 'done');
  assert.deepEqual([done.json.count, done.json.shown, done.json.nextCursor, done.json.items], [0, 0, null, []]);
  assert.deepEqual(done.json.next, []);
});

test('text mode pages the same way and keeps the line format; every item shown gives no next lines', () => {
  const brief = run(['--action', 'list']);
  assert.equal(brief.status, 0, brief.stderr);
  const lines = brief.stdout.trimEnd().split('\n');
  assert.equal(lines.filter((l: string) => /^FU-/.test(l)).length, 10);
  assert.match(lines[0], /^FU-[0-9a-hjkmnp-tv-z]{6} {2}open {2}\(manual, .*\) {2}Fixture follow-up /);
  assert.equal(lines.filter((l: string) => l.startsWith('next: ')).length, 2);
  assert.ok(lines.some((l: string) => l.startsWith('next: Next page: doflow-run followup --action list --cursor ')));
  const full = run(['--action', 'list', '--view', 'full']);
  const fullLines = full.stdout.trimEnd().split('\n');
  assert.equal(fullLines.length, TOTAL);
  assert.equal(fullLines.some((l: string) => l.startsWith('next:')), false);
  const two = run(['--action', 'list', '--ids', seeded().ids.slice(0, 2).join(',')]);
  assert.equal(two.stdout.trimEnd().split('\n').length, 2, 'two items, all shown, today text');
});

test('followupOrderKey is the creating event time in ms and its event id', () => {
  const item = { history: [{ event: '20261102T152312345Z-wq105h', at: '2026-11-02T15:23:12.345Z' }, { event: '20261103T000000000Z-aaaaaa', at: '2026-11-03T00:00:00.000Z' }] };
  assert.deepEqual(followupOrderKey(item), { atMs: Date.parse('2026-11-02T15:23:12.345Z'), event: '20261102T152312345Z-wq105h' });
});
