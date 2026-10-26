'use strict';

// The Fleet view's derivations (feature 093, plan task V.10; IC-019, IC-020, IC-022, IC-023, IC-025; design ui/V8.md
// 7b.4, 7b.5, 7b.10). Pure functions over the Fleet bodies: no DOM, no fetch, no clock. Control: attaching a node to a
// guessed parent (merging the "No parent in the records" group into the nearest main session) turns the no-merge case red.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SOURCE = fs.readFileSync(path.join(WEB_ROOT, 'derive', 'fleet.js'), 'utf8');

let scratch: string[] = [];
let fleet: any;

/** A copy of derive/fleet.js (optionally rewritten), as an ES module a CommonJS package can import. */
async function load(source: string = SOURCE): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-fleet-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'derive', 'fleet.js'), source);
  return import(pathToFileURL(path.join(dir, 'derive', 'fleet.js')).href);
}

before(async () => { fleet = await load(); });
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- bodies -------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const iso = (agoMin: number) => new Date(NOW - agoMin * 60_000).toISOString();
const key = (n: number) => n.toString(16).padStart(16, '0');
const hhmm = (text: string) => { const d = new Date(text); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const node = (n: number, extra: any = {}) => ({
  agentKey: key(n), kind: 'harness-subagent', harness: 'claude', model: null, modelBasis: null, label: null, depth: 1, worktreeKey: key(99),
  startedAt: null, lastRecordAt: null, liveness: 'not-checked', ended: null, transcript: { reader: 'claude-jsonl', linked: true, reason: null }, ...extra,
});
const main = (n: number, lastAgo: number | null, extra: any = {}) => node(n, { kind: 'main-session', depth: 0, lastRecordAt: lastAgo === null ? null : iso(lastAgo), startedAt: iso(120), ...extra });
const edge = (from: number, to: number) => ({ from: key(from), to: key(to), basis: 'harness-subagent-record' });
const keys = (items: any[]) => items.map((item) => item.key);

// ---- the tree -----------------------------------------------------------------------------------------

test('tree order: main sessions newest first, children in spawn order, nulls last, ties by key', () => {
  const tree = {
    nodes: [
      main(1, 30), main(2, 5), main(3, null),
      node(11, { startedAt: iso(50) }), node(12, { startedAt: iso(90) }), node(13, { startedAt: null }), node(14, { startedAt: null }),
    ],
    edges: [edge(1, 11), edge(1, 12), edge(1, 14), edge(1, 13)],
  };
  const layout = fleet.layoutTree(tree);
  assert.deepEqual(keys(layout.items), [key(2), key(1), key(12), key(11), key(13), key(14), key(3)]);
  assert.deepEqual(layout.roots, [key(2), key(1), key(3)], 'a main session with no last record sorts after those that have one');
  const levels = Object.fromEntries(layout.items.map((item: any) => [item.key, item.level]));
  assert.equal(levels[key(1)], 1);
  assert.equal(levels[key(12)], 2);
  const posOf = (k: string) => layout.items.find((item: any) => item.key === k);
  assert.equal(posOf(key(12)).pos, 1);
  assert.equal(posOf(key(14)).pos, 4);
  assert.equal(posOf(key(12)).setSize, 4);
});

test('a node with no parent in the records is drawn after the main sessions, as an orphan, never attached to a guessed parent', () => {
  const tree = {
    nodes: [main(1, 5), node(2, { kind: 'doflow-run', startedAt: iso(20) }), node(3, { kind: 'worker-run', startedAt: iso(10) }), node(4, { kind: 'child-worker-run' })],
    // key(3)'s only edge comes from a node the cap dropped; key(4) hangs under key(3).
    edges: [{ from: key(77), to: key(3), basis: 'worker-caller' }, { from: key(3), to: key(4), basis: 'worker-childOf' }],
  };
  const layout = fleet.layoutTree(tree);
  assert.deepEqual(layout.roots, [key(1), key(2), key(3)]);
  assert.deepEqual(layout.orphans, [key(2), key(3)]);
  assert.deepEqual(keys(layout.items), [key(1), key(2), key(3), key(4)]);
  assert.equal(layout.items.find((i: any) => i.key === key(2)).orphan, true);
  assert.equal(layout.items.find((i: any) => i.key === key(1)).orphan, false);
  assert.equal(layout.parent.get(key(2)), null, 'no guessed parent');
  assert.equal(layout.parent.get(key(4)), key(3));
});

test('nodes are never merged: two nodes of one harness and model stay two, and a node with two parents hangs under the first edge only', () => {
  const tree = {
    nodes: [main(1, 5), main(2, 6), node(3, { model: 'm-a' }), node(4, { model: 'm-a' })],
    edges: [edge(1, 3), edge(2, 3), edge(1, 4)],
  };
  const layout = fleet.layoutTree(tree);
  assert.equal(layout.items.length, 4);
  assert.equal(layout.parent.get(key(3)), key(1));
  assert.deepEqual(layout.children.get(key(1)), [key(3), key(4)]);
  assert.equal(layout.children.get(key(2)), undefined);
});

test('a cycle or a main session with an incoming edge cannot lose or loop a node', () => {
  const cyc = fleet.layoutTree({ nodes: [node(1), node(2)], edges: [edge(1, 2), edge(2, 1)] });
  assert.equal(cyc.items.length, 2);
  const upward = fleet.layoutTree({ nodes: [main(1, 5), main(2, 6)], edges: [edge(1, 2)] });
  assert.deepEqual(upward.roots, [key(1), key(2)], 'a main session is always top-level');
});

test('control: attaching an orphan to the nearest main session (a guessed parent) turns the no-merge case red', async () => {
  const guessed = SOURCE.replace("const orphans = nodes.filter((/** @type {any} */ n) => n.kind !== 'main-session' && !parent.has(n.agentKey))", "const orphans = nodes.filter((/** @type {any} */ n) => false)");
  assert.notEqual(guessed, SOURCE, 'the mutation applied');
  const mutated = await load(guessed);
  const tree = { nodes: [main(1, 5), node(2, { kind: 'doflow-run' })], edges: [] };
  assert.deepEqual(fleet.layoutTree(tree).orphans, [key(2)]);
  assert.notDeepEqual(mutated.layoutTree(tree).orphans, [key(2)]);
});

// ---- counts, models, traffic ----------------------------------------------------------------------------

test('counts by kind, processes seen, and models most frequent first (a null model is no chip)', () => {
  const tree = {
    nodes: [
      main(1, 1, { model: 'm-b', liveness: 'process-seen' }), node(2, { model: 'm-a' }), node(3, { model: 'm-a' }), node(4, { kind: 'doflow-run', model: null }),
      node(5, { kind: 'worker-run', model: 'm-c', liveness: 'process-seen' }), node(6, { kind: 'child-worker-run' }),
    ],
    edges: [],
  };
  assert.deepEqual(fleet.agentCounts(tree), { main: 1, subagents: 3, workers: 2, processSeen: 2, total: 6 });
  assert.deepEqual(fleet.modelsOf(tree), ['m-a', 'm-b', 'm-c']);
});

test('traffic aggregation keeps null apart from 0: a project with no reporting agent is null, a recorded 0 stays 0', () => {
  const a = (n: number, rate: number | null) => ({ agentKey: key(n), eventsPerMin: rate, toolCalls: null, toolErrors: null, toolDurationMs: null, tokens: null, model: null, harness: 'claude', lastRecordAt: null });
  assert.equal(fleet.projectRate({ agents: [] }), null);
  assert.equal(fleet.projectRate({ agents: [a(1, null), a(2, null)] }), null);
  assert.equal(fleet.projectRate({ agents: [a(1, 0)] }), 0);
  assert.equal(fleet.projectRate({ agents: [a(1, 8.2), a(2, null), a(3, 4.2)] }), 12.4);
  const rows = fleet.agentRows({ agents: [a(1, null), a(2, 3), a(3, 9.5), a(4, 0)] }, new Map([[key(2), { agentKey: key(2) }]]));
  assert.deepEqual(rows.map((r: any) => r.agentKey), [key(3), key(2), key(4), key(1)], 'events per minute descending, 0 before null, null last');
  assert.deepEqual(rows[1].node, { agentKey: key(2) });
  assert.equal(rows[0].node, null);
  assert.equal(fleet.barWidth(null, 10), 0);
  assert.equal(fleet.barWidth(5, 10), 50);
  assert.equal(fleet.barWidth(1, 3), 33.3);
  assert.equal(fleet.barWidth(5, 0), 0);
  assert.equal(fleet.maxOf(rows, 'eventsPerMin'), 9.5);
  assert.equal(fleet.tokenLine({ input: 12400, output: 3100 }), '12.4k in · 3,100 out', 'k from 10 000');
  assert.equal(fleet.tokenLine({ input: 900, output: null }), '900 in');
  assert.equal(fleet.tokenLine(null), null);
  assert.deepEqual(fleet.toolTime({ p50: 1200, max: 9800, n: 14 }), { line: 'p50 1.2 s · max 9.8 s', n: 'n=14' });
  assert.equal(fleet.toolTime(null), null);
});

test('per-model rows sort by events per minute descending, nulls last', () => {
  const rows = fleet.modelRows({ models: [{ model: 'b', eventsPerMin: null }, { model: 'a', eventsPerMin: 1 }, { model: 'c', eventsPerMin: 5 }] });
  assert.deepEqual(rows.map((r: any) => r.model), ['c', 'a', 'b']);
});

// ---- working together ---------------------------------------------------------------------------------

test('pair groups by basis: same task with its task id, overlap with both task ids, same model grouped by model', () => {
  const byKey = new Map([[key(1), { model: 'm-a' }], [key(2), { model: 'm-a' }], [key(3), { model: null }]]);
  const traffic = {
    agents: [{ agentKey: key(3), model: 'm-z' }],
    pairs: [
      { a: key(1), b: key(2), basis: 'same-task', task: 'B.2', tasks: null },
      { a: key(2), b: key(3), basis: 'same-task', task: 'B.2', tasks: null },
      { a: key(1), b: key(3), basis: 'overlap', task: null, tasks: ['A.4', 'A.6'] },
      { a: key(1), b: key(2), basis: 'same-model', task: null, tasks: null },
    ],
  };
  const groups = fleet.pairGroups(traffic, byKey);
  assert.deepEqual(groups.sameTask, [{ task: 'B.2', agents: [key(1), key(2), key(3)] }]);
  assert.deepEqual(groups.overlap, [{ a: key(1), b: key(3), tasks: ['A.4', 'A.6'] }]);
  assert.deepEqual(groups.sameModel, [{ model: 'm-a', agents: [key(1), key(2)] }]);
  assert.equal(groups.empty, false);
  assert.equal(fleet.pairGroups({ pairs: [] }, new Map()).empty, true);
  assert.deepEqual(fleet.overlapIds(traffic), [`${key(1)}+${key(3)}:A.4+A.6`]);
  const partners = fleet.partnersOf(traffic, key(1));
  assert.deepEqual([...partners.get(key(2))!].sort(), ['same-model', 'same-task']);
  assert.deepEqual([...partners.get(key(3))!], ['overlap']);
  assert.equal(partners.has(key(1)), false);
  assert.equal(fleet.partnersOf(traffic, null).size, 0);
});

// ---- accessible names -------------------------------------------------------------------------------

test('fleetNodeName: the parts of 7b.10 in order, from records only, never "active", "online" or "idle"', () => {
  const sub = node(2, { label: 'system-architect', model: 'm-a', modelBasis: 'harness-record', startedAt: iso(80), lastRecordAt: iso(5) });
  const name = fleet.fleetNodeName(sub, { eventsPerMin: 8, toolCalls: 14 }, { nowMs: NOW, tickAt: NOW });
  assert.equal(name, `system-architect. Subagent. claude, model m-a, from the harness record. Started ${hhmm(iso(80))}, last record ${hhmm(iso(5))}. Recorded, process not checked. Transcript available. 8 events per minute, 14 tool calls.`);
  const seen = fleet.fleetNodeName(main(1, 1, { liveness: 'process-seen', model: 'm-b', modelBasis: 'hook-observation', harness: 'codex' }), null, { nowMs: NOW, tickAt: NOW });
  assert.match(seen, /^Main session\. codex, model first seen in a hook record\./);
  assert.match(seen, new RegExp(`Process seen at ${hhmm(new Date(NOW).toISOString())}\\.`));
  const ended = fleet.fleetNodeName(node(3, { kind: 'worker-run', ended: { at: iso(2), result: 'failed' }, model: null }), null, { nowMs: NOW });
  assert.match(ended, /claude, model not recorded\./);
  assert.match(ended, new RegExp(`Ended at ${hhmm(iso(2))}, failed\\.`));
  const gone = fleet.fleetNodeName(node(4, { liveness: 'process-gone' }), null, { nowMs: NOW });
  assert.match(gone, /Process gone, no end record\./);
  const opencode = fleet.fleetNodeName(node(5, { harness: 'opencode', transcript: { reader: null, linked: false, reason: 'no-reader' } }), null, { nowMs: NOW, orphan: true });
  assert.match(opencode, /No transcript reader for opencode\./);
  assert.match(opencode, /No parent in the records\.$/);
  assert.match(fleet.fleetNodeName(node(6, { transcript: { reader: null, linked: false, reason: 'not-linked' }, harness: 'antigravity' }), null, { nowMs: NOW }), /Transcript not linked\./);
  assert.match(fleet.fleetNodeName(node(7, { transcript: { reader: 'claude-jsonl', linked: false, reason: 'not-found' } }), null, { nowMs: NOW }), /Transcript not found\./);
  assert.match(fleet.fleetNodeName(node(8), null, { nowMs: NOW, partner: new Set(['same-task']) }), /Same task as the selected agent\./);
  for (const text of [name, seen, ended, gone, opencode]) assert.doesNotMatch(text, /\b(active|online|idle|live|working|busy)\b/i);
});

test('titles come from labels only: "Lead" appears only when a record label says it', () => {
  assert.equal(fleet.nodeTitle(main(1, 1)), 'Main session');
  assert.equal(fleet.nodeTitle(node(2, { kind: 'doflow-run' })), 'DoFlow run');
  assert.equal(fleet.nodeTitle(node(3, { kind: 'worker-run' })), 'Worker run');
  assert.equal(fleet.nodeTitle(node(4, { kind: 'child-worker-run' })), 'Child worker run');
  assert.equal(fleet.nodeTitle(node(5, { depth: 0 })), 'Subagent', 'no tier is derived from depth');
  assert.equal(fleet.nodeTitle(node(6, { label: 'Lead' })), 'Lead');
  assert.equal(fleet.titleIsLabel(node(6, { label: 'Lead' })), true);
  assert.equal(fleet.titleIsLabel(node(7)), false);
});

test('a project description reads counts, models, traffic and the last record', () => {
  const project = {
    projectKey: key(1), label: 'example', current: true, checkouts: 2, lastRecordAt: iso(2),
    tree: { ok: true, data: { nodes: [main(1, 1, { model: 'm-a', liveness: 'process-seen' }), node(2, { model: 'm-b' })], edges: [] } },
    traffic: { ok: true, data: { agents: [{ agentKey: key(1), eventsPerMin: 12.4 }] } },
  };
  assert.equal(fleet.projectDescription(project, NOW), `example. This project. 2 checkouts. 1 main session, 1 subagent; 1 process seen. Models: m-a, m-b. 12.4 events per minute over the last 10 minutes. Last record ${hhmm(iso(2))}.`);
  const bare = { ...project, current: false, checkouts: 1, lastRecordAt: null, tree: { ok: false, code: 'core-error' }, traffic: { ok: true, data: { agents: [] } } };
  assert.equal(fleet.projectDescription(bare, NOW), 'example. 1 checkout. No linked transcript. No record time.');
});

// ---- the fleet body merge ---------------------------------------------------------------------------

test('a fleet delta replaces changed sections by key, removes the keys in gone, and takes the top-level fields', () => {
  const section = (n: number, current = false, ago: number | null = null, label = `p${n}`) => ({ projectKey: key(n), label, current, checkouts: 1, lastRecordAt: ago === null ? null : iso(ago), tree: { ok: true, data: {} }, traffic: { ok: true, data: {} } });
  const body = { v: 1, store: 'present', projects: [section(1, true, 9), section(2, false, 5), section(3, false, 7)], excluded: { missing: 1, temp: 0, notDoflow: 0, unreadable: 0 }, limits: { projectsShown: 3, projectsNotShown: 0, truncated: false } };
  const merged = fleet.mergeFleet(body, { v: 1, store: 'present', excluded: { missing: 2, temp: 0, notDoflow: 0, unreadable: 0 }, limits: body.limits, projects: [section(3, false, 1, 'renamed'), section(4, false, 3)], gone: [key(2)] });
  assert.deepEqual(merged.projects.map((p: any) => p.projectKey), [key(1), key(3), key(4)], 'current first, then the newest last record');
  assert.equal(merged.projects[1].label, 'renamed');
  assert.equal(merged.excluded.missing, 2);
  assert.equal(fleet.mergeFleet(null, { projects: [], gone: [] }), null, 'a delta before the snapshot is ignored');
  assert.equal(body.projects.length, 3, 'the held body is not changed');
});

// ---- the stream panel's events ------------------------------------------------------------------------

const ev = (n: number, extra: any = {}) => ({ seq: n, at: new Date(NOW + n * 1000).toISOString(), kind: 'reply', agentKey: key(1), model: null, tool: null, text: `reply ${n}`, args: null, cut: false, tokens: null, record: null, ...extra });

test('the 500-event bound: the oldest are dropped from the top and counted; reset starts over; a resume drops what is held', () => {
  const held = Array.from({ length: 498 }, (_, i) => ev(i));
  const more = fleet.appendEvents(held, [ev(498), ev(499), ev(500), ev(501)]);
  assert.equal(more.events.length, 500);
  assert.equal(more.dropped, 2);
  assert.equal(more.added, 4);
  assert.equal(more.events[0].seq, 2);
  assert.equal(more.events.at(-1).seq, 501);
  assert.equal(held.length, 498, 'the held list is not changed');
  const small = fleet.appendEvents([ev(0)], [ev(1)]);
  assert.equal(small.dropped, 0);
  const reset = fleet.appendEvents(held, [ev(900)], { reset: true });
  assert.deepEqual(reset.events.map((e: any) => e.seq), [900]);
  const resumed = fleet.appendEvents([ev(1), ev(2)], [ev(2), ev(3)], { dedupe: true });
  assert.deepEqual(resumed.events.map((e: any) => e.seq), [1, 2, 3], 'an event already held is not added twice');
  assert.equal(resumed.added, 1);
  const loose = fleet.appendEvents([ev(1)], [ev(1)]);
  assert.equal(loose.events.length, 2, 'without a resume the same event is kept (a repeated reply is not a duplicate)');
  function pushAll(count: number) { let list: any[] = []; for (let i = 0; i < count; i += 100) list = fleet.appendEvents(list, Array.from({ length: 100 }, (_, j) => ev(i + j))).events; return list; }
  assert.equal(pushAll(1200).length, 500);
});

test('record events are held once: the same record in three normal batches is added once, other kinds are kept', () => {
  const rec = (n: number, extra: any = {}) => ev(n, { kind: 'record', text: null, record: { type: 'attempt-end', task: 'T1', result: 'PASSED', ...extra } });
  const kiro = { ...rec(5), at: new Date(NOW + 5000).toISOString() };
  let held: any[] = [ev(1)];
  const counts: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const next = fleet.appendEvents(held, [{ ...kiro }, ev(10 + i)]);
    held = next.events;
    counts.push(next.added);
  }
  assert.equal(held.filter((e: any) => e.kind === 'record').length, 1, 'the same record is held once');
  assert.deepEqual(counts, [2, 1, 1]);
  assert.equal(held.filter((e: any) => e.kind === 'reply').length, 4, 'replies are never deduped without a resume');
  const other = fleet.appendEvents(held, [rec(5, { task: 'T2' }), { ...kiro, agentKey: key(2) }]);
  assert.equal(other.added, 2, 'another task or another agent is another record');
  const reset = fleet.appendEvents(held, [{ ...kiro }], { reset: true });
  assert.equal(reset.added, 1, 'a reset starts from nothing held');
});

test('panel rows: a tool result attaches to its call by callKey and is no row of its own; one without its call is a row', () => {
  const call = (n: number, k: string) => ev(n, { kind: 'tool-call', text: null, args: 'x', tool: { name: 'Read', callKey: k, status: null, bytes: null, durationMs: null } });
  const result = (n: number, k: string, status: string) => ev(n, { kind: 'tool-result', text: null, tool: { name: 'Read', callKey: k, status, bytes: 2400, durationMs: 1200 } });
  const rows = fleet.panelRows([call(1, 'k1'), call(2, 'k2'), result(3, 'k1', 'ok'), result(4, 'k9', 'error'), ev(5)]);
  assert.deepEqual(rows.map((r: any) => [r.event.seq, r.result ? r.result.seq : null, r.orphanResult]), [[1, 3, false], [2, null, false], [4, null, true], [5, null, false]]);
  assert.deepEqual(fleet.resultBits({ bytes: 2400, durationMs: 1200 }), ['2.3 KB', '1.2 s']);
  assert.deepEqual(fleet.resultBits({ bytes: null, durationMs: null }), []);
});

test('masked tokens split on exactly <masked>, <email> and <ip>; any other angle text stays text', () => {
  assert.deepEqual(fleet.splitMasked('a <masked> b <email> c <ip>'), [{ text: 'a ' }, { mask: 'masked' }, { text: ' b ' }, { mask: 'email' }, { text: ' c ' }, { mask: 'ip' }]);
  assert.deepEqual(fleet.splitMasked('<script>alert(1)</script>'), [{ text: '<script>alert(1)</script>' }]);
  assert.deepEqual(fleet.splitMasked('<MASKED><masked >'), [{ text: '<MASKED><masked >' }]);
  assert.deepEqual(fleet.splitMasked(null), []);
});

test('usage and record words: a null field is left out, a recorded 0 is shown', () => {
  assert.equal(fleet.usageLine({ input: 1204, output: 312, cacheRead: 18000, cacheWrite: 0, reasoning: null }), 'Tokens: 1,204 in · 312 out · 18,000 cache read · 0 cache write');
  assert.equal(fleet.usageLine({ input: null, output: null }), 'Tokens: not recorded');
  assert.equal(fleet.recordWords({ type: 'attempt-claim', task: 'B.2', result: null }), 'attempt claimed for B.2');
  assert.equal(fleet.recordWords({ type: 'attempt-end', task: 'B.2', result: 'PASSED' }), 'attempt finished, passed');
  assert.equal(fleet.recordWords({ type: 'attempt-end', task: null, result: null }), 'attempt released');
  assert.equal(fleet.recordWords({ type: 'worker-run-end', task: null, result: 'FAILED' }), 'worker run ended, failed');
  assert.equal(fleet.recordWords({ type: 'hook-record', task: null, result: null }), 'hook record');
  assert.equal(fleet.recordWords({ type: 'worker-run-start', task: null, result: null }), 'worker run started');
});

test('stamps: HH:MM today, a short date for an older day, a dash for none', () => {
  assert.equal(fleet.stamp(iso(1), NOW), hhmm(iso(1)));
  assert.match(fleet.stamp(new Date(NOW - 3 * 86_400_000).toISOString(), NOW), /^[A-Z][a-z]{2} \d{1,2} \d\d:\d\d$/);
  assert.equal(fleet.stamp(null, NOW), '–');
  assert.equal(fleet.stamp('nonsense', NOW), '–');
  assert.equal(fleet.secondsStamp(null), null);
});
