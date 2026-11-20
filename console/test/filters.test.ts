'use strict';

// Saved filters (180 C5, design §3 IC-180-B2, FR-B2): filters.js keeps named filters for Now and Sessions in this browser's
// storage only (`doflow-console-filters`, at most 12 per view, names of 1-40 printable characters), read and written inside
// try/catch, so a browser that refuses storage still keeps them for the page load. The palette lists them as "Filter: <name>".

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
let copy: string;
let filters: any;
let palette: any;

/** A fake localStorage over a Map; `refuse` makes every call throw, as a private window does. */
const storage = { map: new Map<string, string>(), refuse: false };
function installStorage() {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => { if (storage.refuse) throw new Error('SecurityError'); return storage.map.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (storage.refuse) throw new Error('QuotaExceededError'); storage.map.set(k, v); },
    },
  });
}

before(async () => {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-filters-'));
  fs.cpSync(WEB_ROOT, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), '{"type":"module"}\n');
  filters = await import(pathToFileURL(path.join(copy, 'filters.js')).href);
  palette = await import(pathToFileURL(path.join(copy, 'palette.js')).href);
});
after(() => {
  fs.rmSync(copy, { recursive: true, force: true });
  delete (globalThis as any).localStorage;
});
beforeEach(() => {
  storage.map.clear();
  storage.refuse = false;
  installStorage();
  filters.resetFilters();
});

const stored = () => JSON.parse(storage.map.get('doflow-console-filters') ?? 'null');

test('save, list and delete, per view, under the one key', () => {
  assert.equal(filters.FILTERS_KEY, 'doflow-console-filters');
  assert.deepEqual(filters.saved('runs'), []);
  assert.equal(filters.save('runs', 'Waiting here', { chips: ['needs'], scope: 'this' }), 'saved');
  assert.equal(filters.save('sessions', 'Conflicts', { chips: ['conflicts'] }), 'saved');
  assert.deepEqual(filters.saved('runs'), [{ name: 'Waiting here', filter: { chips: ['needs'], scope: 'this' } }]);
  assert.deepEqual(filters.saved('sessions'), [{ name: 'Conflicts', filter: { chips: ['conflicts'] } }]);
  assert.deepEqual(stored(), {
    v: 1,
    views: { runs: [{ name: 'Waiting here', filter: { chips: ['needs'], scope: 'this' } }], sessions: [{ name: 'Conflicts', filter: { chips: ['conflicts'] } }] },
  });
  assert.equal(filters.save('runs', 'Waiting here', { chips: [], scope: 'every' }), 'replaced', 'the same name replaces in place');
  assert.deepEqual(filters.saved('runs'), [{ name: 'Waiting here', filter: { chips: [], scope: 'every' } }]);
  assert.equal(filters.remove('runs', 'Waiting here'), true);
  assert.equal(filters.remove('runs', 'Waiting here'), false);
  assert.deepEqual(filters.saved('runs'), []);
  assert.deepEqual(filters.saved('sessions').map((item: any) => item.name), ['Conflicts'], 'the other view keeps its own');
  assert.equal(filters.save('layers', 'x', { chips: [] }), 'view', 'only Now (runs) and Sessions keep filters');
});

test('at most 12 per view: the 13th is refused, and replacing one of the 12 is not', () => {
  for (let i = 1; i <= 12; i += 1) assert.equal(filters.save('runs', `F${i}`, { chips: [], scope: 'every' }), 'saved');
  assert.equal(filters.MAX_SAVED, 12);
  assert.equal(filters.save('runs', 'F13', { chips: [], scope: 'every' }), 'full');
  assert.equal(filters.saved('runs').length, 12);
  assert.equal(filters.save('runs', 'F5', { chips: ['running'], scope: 'every' }), 'replaced');
  assert.equal(filters.save('sessions', 'S1', { chips: [] }), 'saved', 'the cap is per view');
  // A store edited by hand to hold more is read as its first 12.
  storage.map.set('doflow-console-filters', JSON.stringify({ v: 1, views: { runs: Array.from({ length: 15 }, (_, i) => ({ name: `X${i}`, filter: { chips: [] } })) } }));
  assert.equal(filters.saved('runs').length, 12);
});

test('names: 1 to 40 printable characters after trimming; control and line characters are refused', () => {
  assert.equal(filters.validName('  Mine  '), 'Mine');
  assert.equal(filters.validName('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(filters.validName('é'.repeat(40)), 'é'.repeat(40), 'characters, not bytes');
  for (const bad of ['', '   ', 'x'.repeat(41), 'a\u0000b', 'a\nb', 'a\tb', 'a‎b', 'a b', 42, null]) {
    assert.equal(filters.validName(bad), null, JSON.stringify(bad));
  }
  assert.equal(filters.save('runs', 'a\nb', { chips: [] }), 'name');
  assert.equal(filters.save('runs', 'x'.repeat(41), { chips: [] }), 'name');
  assert.deepEqual(filters.saved('runs'), []);
  assert.equal(filters.save('runs', '  Trimmed ', { chips: [] }), 'saved');
  assert.deepEqual(filters.saved('runs').map((item: any) => item.name), ['Trimmed']);
});

test('a stored value of the wrong shape reads as none, and bad entries are dropped one by one', () => {
  storage.map.set('doflow-console-filters', '{not json');
  assert.deepEqual(filters.saved('runs'), []);
  storage.map.set('doflow-console-filters', JSON.stringify({ v: 2, views: { runs: [{ name: 'a', filter: { chips: [] } }] } }));
  assert.deepEqual(filters.saved('runs'), [], 'another version is not read');
  storage.map.set('doflow-console-filters', JSON.stringify({ v: 1, views: { runs: [
    { name: 'ok', filter: { chips: ['needs'], scope: 'this' } },
    { name: 'a\nb', filter: { chips: [] } },
    { name: 'no chips', filter: {} },
    { name: 'bad scope', filter: { chips: [], scope: 'all' } },
    { name: 'bad chip', filter: { chips: [3] } },
    'text',
  ] } }));
  assert.deepEqual(filters.saved('runs'), [{ name: 'ok', filter: { chips: ['needs'], scope: 'this' } }]);
});

test('a missing store works for the page load: saving, listing and deleting hold in memory, and nothing throws', () => {
  storage.refuse = true;
  assert.deepEqual(filters.saved('runs'), []);
  assert.equal(filters.save('runs', 'Here only', { chips: ['needs'], scope: 'this' }), 'saved');
  assert.deepEqual(filters.saved('runs'), [{ name: 'Here only', filter: { chips: ['needs'], scope: 'this' } }]);
  assert.equal(filters.remove('runs', 'Here only'), true);
  assert.deepEqual(filters.saved('runs'), []);
  delete (globalThis as any).localStorage;
  assert.equal(filters.save('sessions', 'No storage at all', { chips: [] }), 'saved');
  assert.deepEqual(filters.saved('sessions').map((item: any) => item.name), ['No storage at all']);
});

test('apply: a request reaches the mounted view at once, or waits for the view to take it when it mounts', () => {
  const calls: string[] = [];
  filters.request('runs', { chips: ['running'], scope: 'every' });
  assert.deepEqual(filters.take('runs'), { chips: ['running'], scope: 'every' }, 'no view mounted: it waits');
  assert.equal(filters.take('runs'), null, 'taken once');
  filters.follow('runs', () => { calls.push('runs'); });
  filters.request('runs', { chips: [], scope: 'this' });
  assert.deepEqual(calls, ['runs'], 'a mounted view is told');
  assert.deepEqual(filters.take('runs'), { chips: [], scope: 'this' });
  filters.request('sessions', { chips: ['conflicts'] });
  assert.deepEqual(calls, ['runs'], 'another view is not told');
});

test('the palette lists each saved filter as "Filter: <name>", after the screens and actions, matched by part of the name', () => {
  filters.save('runs', 'Waiting here', { chips: ['needs'], scope: 'this' });
  filters.save('sessions', 'Conflicts', { chips: ['conflicts'] });
  const targets = filters.filterTargets();
  assert.deepEqual(targets.map((t: any) => [t.kind, t.label, t.hint, t.hash]), [
    ['filter', 'Filter: Waiting here', 'Saved filter · Now', '#/'],
    ['filter', 'Filter: Conflicts', 'Saved filter · Sessions', '#/sessions'],
  ]);
  const screen = { kind: 'screen', label: 'Now', hint: 'Screen', hash: '#/' };
  const run = { kind: 'run', label: 'feat / waiting', hint: 'Run', hash: '#/run/feat/waiting' };
  assert.deepEqual(palette.matchTargets([run, ...targets, screen], 'wait').map((t: any) => t.label), ['Filter: Waiting here', 'feat / waiting']);
  assert.deepEqual(palette.matchTargets([run, ...targets, screen], 'filter').map((t: any) => t.label), ['Filter: Waiting here', 'Filter: Conflicts']);
  assert.deepEqual(palette.matchTargets([run, ...targets, screen], '').map((t: any) => t.label), ['Now', 'feat / waiting'], 'an empty query still lists the screens and runs only');
  targets[0].apply();
  assert.deepEqual(filters.take('runs'), { chips: ['needs'], scope: 'this' }, 'choosing one requests it for its view');
});
