'use strict';

// The shared verb view helper (feature 137, IC-002, IC-003, IC-007, IC-008): view resolution, keep-path
// projection, cursor paging, next-line building, the envelope and compact-or-indented serialization.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ViewUsageError, resolveView, projectBrief, pageItems, encodeCursor, decodeCursor,
  commandLine, viewLines, withEnvelope, serializeJson, emitJson,
} = require('../../src/runtime/verb-view.ts');

const SPEC = { verb: 'followup', action: 'list', keep: [], carry: ['state', 'ids', 'limit'] };

// ------------------------------------------------------------------------------------------------- view

test('resolveView: absent takes the default, brief and full pass, anything else is a usage error', () => {
  assert.equal(resolveView(undefined, 'brief'), 'brief');
  assert.equal(resolveView(undefined, 'full'), 'full');
  assert.equal(resolveView('full', 'brief'), 'full');
  assert.equal(resolveView('brief', 'full'), 'brief');
  for (const bad of ['', 'Brief', 'compact', 7]) {
    assert.throws(() => resolveView(bad, 'full'), (error: any) => error instanceof ViewUsageError
      && error.message === `--view must be brief or full (got '${bad}')`);
  }
});

// -------------------------------------------------------------------------------------------- projection

const FULL = {
  outcome: 'ACCEPTED', proposedBy: 'x', fit: { state: 'OK', reason: null, extra: 1 }, secondOpinion: null,
  workflow: { name: 'Feature', stages: [{ id: 'a', purpose: 'p', skill: 's' }, { id: 'b', purpose: 'q' }] },
};

test('projectBrief keeps listed paths, maps arrays, keeps null, skips absent, follows full key order', () => {
  const brief = projectBrief(FULL, ['$.workflow.stages[].skill', '$.fit.state', '$.secondOpinion', '$.outcome', '$.nope.deep']);
  assert.deepEqual(brief, {
    outcome: 'ACCEPTED', fit: { state: 'OK' }, secondOpinion: null,
    workflow: { stages: [{ skill: 's' }, {}] },
  });
  assert.deepEqual(Object.keys(brief), ['outcome', 'fit', 'secondOpinion', 'workflow']);
});

test('projectBrief: a whole-value path wins, a null parent is skipped, an array keeps length', () => {
  assert.deepEqual(projectBrief(FULL, ['$.workflow.stages']), { workflow: { stages: FULL.workflow.stages } });
  assert.deepEqual(projectBrief({ workflow: null, a: 1 }, ['$.workflow.name', '$.a']), { a: 1 });
  assert.deepEqual(projectBrief({ items: [{ id: 1, h: 2 }, { id: 3, h: 4 }] }, ['$.items[].id']), { items: [{ id: 1 }, { id: 3 }] });
});

test('projectBrief throws on a malformed path and on a name used as array and single value', () => {
  for (const bad of ['', '$', 'a.b', '$.a..b', '$.a[0]', '$.a.[]', '$.1a']) {
    assert.throws(() => projectBrief({}, [bad]), /malformed keep path/, bad);
  }
  assert.throws(() => projectBrief({}, ['$.a[].x', '$.a.y']), /both as an array/);
});

// ------------------------------------------------------------------------------------------------ cursor

const EV = (n: number) => `20261102T1523${String(n).padStart(2, '0')}000Z-wq105h`;
const ITEMS = Array.from({ length: 25 }, (_, i) => ({ id: i, key: { atMs: 1000 + Math.floor(i / 2), event: EV(i) } }));
const KEY = (item: any) => item.key;

test('cursor encodes and decodes the documented shape; other text does not decode', () => {
  const key = { atMs: 1793632812345, event: '20261102T152312345Z-wq105h' };
  assert.equal(encodeCursor(key), '1793632812345:20261102T152312345Z-wq105h');
  assert.deepEqual(decodeCursor('1793632812345:20261102T152312345Z-wq105h'), key);
  for (const bad of ['', 'abc', '12:nope', '1234567890123456:20261102T152312345Z-wq105h', '1:20261102T152312345Z-WQ105H',
    '1:20261102T152312345Z-wq105h:FU-abc123', undefined, 5]) {
    assert.equal(decodeCursor(bad), null, String(bad));
  }
  assert.throws(() => encodeCursor({ atMs: NaN, event: key.event }), TypeError);
});

test('pageItems: first page, next pages by cursor visit every item once, the last page has no cursor', () => {
  const seen: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = pageItems(ITEMS, { cursor, limit: undefined, defaultLimit: 10, maxLimit: 100, key: KEY });
    seen.push(...page.items.map((item: any) => item.id));
    pages += 1;
    assert.equal(page.shown, page.items.length);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, ITEMS.map((item) => item.id));
});

test('pageItems: ties on time order by event id, so a cursor between equal-time items resumes correctly', () => {
  const page = pageItems(ITEMS, { limit: 1, defaultLimit: 10, maxLimit: 100, key: KEY });
  assert.equal(page.items[0].id, 0);
  const second = pageItems(ITEMS, { cursor: page.nextCursor as string, limit: 1, defaultLimit: 10, maxLimit: 100, key: KEY });
  assert.equal(second.items[0].id, 1, 'items 0 and 1 share a time; the event id decides');
});

test('pageItems: no default limit returns everything; a limit clamps to maxLimit; a full page with nothing after has no cursor', () => {
  const all = pageItems(ITEMS, { defaultLimit: null, maxLimit: 100, key: KEY });
  assert.deepEqual([all.shown, all.nextCursor], [25, null]);
  const clamped = pageItems(ITEMS, { limit: '500', defaultLimit: null, maxLimit: 20, key: KEY });
  assert.equal(clamped.shown, 20);
  assert.notEqual(clamped.nextCursor, null);
  const exact = pageItems(ITEMS, { limit: 25, defaultLimit: 10, maxLimit: 100, key: KEY });
  assert.deepEqual([exact.shown, exact.nextCursor], [25, null]);
  assert.deepEqual(pageItems([], { defaultLimit: 10, maxLimit: 100, key: KEY }), { items: [], shown: 0, nextCursor: null });
});

test('pageItems: a bad limit or cursor is a usage error with the contract message, never a silent first page', () => {
  for (const limit of ['0', '-1', '1.5', 'x', '', 0]) {
    assert.throws(() => pageItems(ITEMS, { limit, defaultLimit: 10, maxLimit: 100, key: KEY }),
      (error: any) => error instanceof ViewUsageError
        && error.message === '--limit must be a whole number of 1 or more (at most 100 are returned)', String(limit));
  }
  for (const cursor of ['', 'garbage', '1:2']) {
    assert.throws(() => pageItems(ITEMS, { cursor, defaultLimit: 10, maxLimit: 100, key: KEY }),
      (error: any) => error instanceof ViewUsageError && error.message === '--cursor must be the nextCursor of an earlier list', cursor);
  }
});

// ------------------------------------------------------------------------------------------- next lines

test('commandLine renders safe values, bare flags and kebab-cased names; free text becomes a placeholder', () => {
  assert.equal(commandLine('followup', 'list', {}), 'doflow-run followup --action list');
  assert.equal(commandLine('classify', undefined, { taskClass: 'feature', callingSkill: 'do-design', view: 'full' }),
    'doflow-run classify --task-class feature --calling-skill do-design --view full');
  assert.equal(commandLine('lifecycle', 'overview', { maintain: true, since: '2026-11-02T10:00:00.000Z', skipped: false, none: undefined }),
    'doflow-run lifecycle --action overview --maintain --since 2026-11-02T10:00:00.000Z');
  assert.equal(commandLine('followup', 'list', { limit: 5, ids: 'FU-aaa111,FU-bbb222' }),
    'doflow-run followup --action list --limit 5 --ids FU-aaa111,FU-bbb222');
  assert.equal(commandLine('classify', undefined, { request: 'fix the bug; rm -rf /', taskClass: 'a b', callingSkill: 'x'.repeat(201) }),
    'doflow-run classify --request <request> --task-class <task-class> --calling-skill <calling-skill>');
});

const CURSOR_A = '1793632812345:20261102T152312345Z-wq105h';

test('viewLines page: carries the spec options then --cursor; --limit only when given; none without a nextCursor', () => {
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: { state: 'open' }, nextCursor: CURSOR_A }),
    [`Next page: doflow-run followup --action list --state open --cursor ${CURSOR_A}`]);
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: { state: 'open', ids: 'FU-aaa111', limit: '20', other: 'x' }, nextCursor: CURSOR_A }),
    [`Next page: doflow-run followup --action list --state open --ids FU-aaa111 --cursor ${CURSOR_A} --limit 20`]);
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: {}, nextCursor: null }), []);
});

test('viewLines page: names --view full after --cursor and --limit only when the caller is in the full view', () => {
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: { state: 'open', limit: '5' }, nextCursor: CURSOR_A, view: 'full' }),
    [`Next page: doflow-run followup --action list --state open --cursor ${CURSOR_A} --limit 5 --view full`]);
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: {}, nextCursor: CURSOR_A, view: 'full' }),
    [`Next page: doflow-run followup --action list --cursor ${CURSOR_A} --view full`]);
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: {}, nextCursor: CURSOR_A, view: 'brief' }),
    [`Next page: doflow-run followup --action list --cursor ${CURSOR_A}`]);
  assert.deepEqual(viewLines('page', { spec: SPEC, carried: {}, nextCursor: null, view: 'full' }), []);
});

test('viewLines page-full: carries the input cursor, --limit <shown> and --view full; none when nothing shown', () => {
  assert.deepEqual(viewLines('page-full', { spec: SPEC, carried: {}, shown: 10 }),
    ['Full view of this page: doflow-run followup --action list --limit 10 --view full']);
  assert.deepEqual(viewLines('page-full', { spec: SPEC, carried: { state: 'all', limit: '3' }, cursor: CURSOR_A, shown: 3 }),
    [`Full view of this page: doflow-run followup --action list --state all --cursor ${CURSOR_A} --limit 3 --view full`]);
  assert.deepEqual(viewLines('page-full', { spec: SPEC, carried: {}, shown: 0 }), []);
});

test('viewLines full: the whole answer in the full view, free text never carried', () => {
  const spec = { verb: 'classify', keep: [], carry: ['taskClass', 'callingSkill'] };
  assert.deepEqual(viewLines('full', { spec, carried: { taskClass: 'feature', callingSkill: 'do-design', request: 'free text' } }),
    ['Full view: doflow-run classify --task-class feature --calling-skill do-design --view full']);
  const overview = { verb: 'lifecycle', action: 'overview', keep: [], carry: ['maintain', 'since'] };
  assert.deepEqual(viewLines('full', { spec: overview, carried: { maintain: true, since: undefined } }),
    ['Full view: doflow-run lifecycle --action overview --maintain --view full']);
});

// ----------------------------------------------------------------------------------------------- envelope

test('withEnvelope: view first, shown and nextCursor after count, next last (replacing the body next)', () => {
  const body = { ok: true, action: 'list', state: 'open', count: 200, items: [], next: ['old'] };
  const out = withEnvelope(body, { view: 'brief', shown: 10, nextCursor: CURSOR_A, next: ['a', 'b'] });
  assert.deepEqual(Object.keys(out), ['view', 'ok', 'action', 'state', 'count', 'shown', 'nextCursor', 'items', 'next']);
  assert.deepEqual(out.next, ['a', 'b']);
  assert.equal(out.view, 'brief');
});

test('withEnvelope: without count the paging keys follow view; a body next is kept last when none is given', () => {
  const out = withEnvelope({ outcome: 'ACCEPTED', next: ['kept'] }, { view: 'brief', shown: 2, nextCursor: null });
  assert.deepEqual(Object.keys(out), ['view', 'shown', 'nextCursor', 'outcome', 'next']);
  assert.equal(out.nextCursor, null);
  assert.deepEqual(Object.keys(withEnvelope({ a: 1 }, { view: 'full' })), ['view', 'a']);
});

// ------------------------------------------------------------------------------------------ serialization

test('serializeJson: compact off a terminal, indented on one, deep-equal either way', () => {
  const value = { a: [1, { b: 'x' }], c: null };
  assert.equal(serializeJson(value, { isTTY: false }), '{"a":[1,{"b":"x"}],"c":null}');
  assert.equal(serializeJson(value, { isTTY: true }), JSON.stringify(value, null, 2));
  assert.deepEqual(JSON.parse(serializeJson(value, { isTTY: false })), JSON.parse(serializeJson(value, { isTTY: true })));
  assert.equal(serializeJson(value), serializeJson(value, { isTTY: process.stdout.isTTY === true }));
});

test('emitJson prints the serialization with one trailing newline', (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  emitJson({ a: 1 }, { isTTY: false });
  emitJson({ a: 1 }, { isTTY: true });
  assert.deepEqual(lines, ['{"a":1}', '{\n  "a": 1\n}']);
});

test('the module requires nothing at load, so any handler can require it without a cycle', () => {
  const source = require('node:fs').readFileSync(require.resolve('../../src/runtime/verb-view.ts'), 'utf8');
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /\brequire\s*\(/);
});
