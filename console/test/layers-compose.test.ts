'use strict';

// Feature 161 IC-003 (DEC-019): the `layers` member keeps a gate's decider (`autopilot`, `manual` or null) as the
// core sent it; the retired `person` has no alias, so a core that sent it is a contract mismatch, never a decider.
// 162 IC-005, IC-006 (D15): the decider also reads `console` and `device.d-<12 hex>`, and an awaiting gate row, in `layers` and in
// the machine activity, carries the run revision the page sends back as the confirmation's `expect`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeLayers, composeMachine } = require('../src/layers-compose.ts');

const WK = 'a1b2c3d4e5f60718';
const gate = (by: unknown) => ({ runKey: `${WK}/run-1/main`, slug: '161-live', taskId: 'T-1', gateId: 'g-design', name: 'Design approval', state: 'approved', at: '2026-11-15T08:30:00.000Z', by });

const gatesOf = async (rows: unknown[]) => ((await composeLayers(WK, new Map([['gates', { exit: 0, json: rows }]]), async () => ({ ok: false }))) as any).body.sections.gates;

test('161 DEC-019: a gate decided manually keeps by manual, autopilot and null stay; by person is a contract mismatch', async () => {
  const kept = await gatesOf([gate('manual'), gate('autopilot'), gate(null)]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.map((g: any) => g.by), ['manual', 'autopilot', null]);
  assert.deepEqual(await gatesOf([gate('person')]), { ok: false, code: 'core-contract-mismatch' });
});

test('162 IC-005: a gate decided from the Console or a paired device keeps that decider; a label outside the grammar is still a contract mismatch', async () => {
  const kept = await gatesOf([gate('console'), gate('device.d-0a1b2c3d4e5f')]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.map((g: any) => g.by), ['console', 'device.d-0a1b2c3d4e5f']);
  for (const bad of ['device.d-XYZ', 'device.d-0A1B2C3D4E5F', 'device:d-0a1b2c3d4e5f', 'Console']) assert.deepEqual(await gatesOf([gate(bad)]), { ok: false, code: 'core-contract-mismatch' }, bad);
});

test('162 IC-006: a gate row carries the run revision: a number on the awaiting row, null when decided or when an older core sent none', async () => {
  const kept = await gatesOf([{ ...gate(null), state: 'awaiting', revision: 7 }, { ...gate('manual'), revision: null }, gate('autopilot')]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.map((g: any) => g.revision), [7, null, null]);
  for (const bad of [-1, 1.5, '7', true]) assert.deepEqual(await gatesOf([{ ...gate(null), state: 'awaiting', revision: bad }]), { ok: false, code: 'core-contract-mismatch' }, String(bad));
});

const activityItem = (gates: unknown[]) => ({ projectKey: WK + '', runs: { open: 1, awaiting: 1 }, gates, workers: { open: 0 }, sessions: { observed: 0, harnesses: [] }, unreadable: [] });
const activityOf = (gates: unknown[]) => (composeMachine(new Map([['activity', { exit: 0, json: { v: 1, limits: { projects: 1, notShown: 0, watched: 1, fingerprintOnly: 0 }, items: [activityItem(gates)] } }]])) as any).body.sections.activity;

test('162 IC-006: the machine activity gate carries the run revision, null when an older core sent none', () => {
  const awaiting = { slug: 'f', taskId: 'T-1', gateId: 'g-design', name: 'Design approval', recordAt: '2026-11-15T08:30:00.000Z' };
  const kept = activityOf([{ ...awaiting, revision: 3 }, awaiting]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.items[0].gates.map((g: any) => g.revision), [3, null]);
  assert.deepEqual(activityOf([{ ...awaiting, revision: -2 }]), { ok: false, code: 'core-contract-mismatch' });
});

test('180 C2 IC-180-A: the machine activity item carries openRuns (at most 8, the seven row keys); an older core that sent none reads null; a bad row is a contract mismatch', () => {
  const run = (n: number, extra: Record<string, unknown> = {}) => ({ slug: n === 0 ? null : 'feat-a', taskId: `t${n}`, state: n % 2 ? 'AWAITING_GATE' : 'RUNNING', workflowName: 'Feature Delivery',
    step: { done: n, total: 9 }, updatedAt: '2026-11-15T10:00:00.000Z', gateName: n % 2 ? 'Approve design' : null, prompt: 'planted prompt', ...extra });
  const itemOf = (extra: Record<string, unknown>) => (composeMachine(new Map([['activity', { exit: 0, json: { v: 1, limits: { projects: 1, notShown: 0, watched: 1, fingerprintOnly: 0 },
    items: [{ ...activityItem([]), ...extra }] } }]])) as any).body.sections.activity;
  const kept = itemOf({ openRuns: [run(0), run(1)] });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  const rows = kept.data.items[0].openRuns;
  assert.deepEqual(Object.keys(rows[0]).sort(), ['gateName', 'slug', 'state', 'step', 'taskId', 'updatedAt', 'workflowName']);
  assert.deepEqual(rows.map((r: any) => [r.slug, r.taskId, r.state, r.gateName]), [[null, 't0', 'RUNNING', null], ['feat-a', 't1', 'AWAITING_GATE', 'Approve design']]);
  assert.equal(JSON.stringify(rows).includes('planted'), false);
  assert.equal(itemOf({}).data.items[0].openRuns, null, 'an older core sends none: null, never an empty list');
  assert.deepEqual(itemOf({ openRuns: [] }).data.items[0].openRuns, []);
  assert.equal(itemOf({ openRuns: Array.from({ length: 8 }, (_, n) => run(n)) }).ok, true);
  for (const bad of [{ openRuns: Array.from({ length: 9 }, (_, n) => run(n)) }, { openRuns: [run(0, { state: 'COMPLETED' })] }, { openRuns: [run(0, { step: { done: -1, total: 2 } })] },
    { openRuns: [run(0, { taskId: '../x' })] }, { openRuns: [run(0, { updatedAt: 'yesterday' })] }, { openRuns: 'none' }]) {
    assert.deepEqual(itemOf(bad), { ok: false, code: 'core-contract-mismatch' }, JSON.stringify(bad).slice(0, 80));
  }
});

test('165 F1: the machine activity item carries the started sessions (at most 8, the seven item keys) and their count; an older core that sent none reads null, never zero', () => {
  const started = (n: number) => ({ runId: `w-00000000000${n}`, harness: 'claude', model: n === 0 ? null : 'claude-opus-5-5', phase: 'running', startedBy: n === 1 ? 'device.d-0123456789ab' : 'console',
    worktreeKey: WK, createdAt: '2026-11-15T10:00:00.000Z', prompt: 'planted prompt', pid: 4242 });
  const itemOf = (extra: Record<string, unknown>) => (composeMachine(new Map([['activity', { exit: 0, json: { v: 1, limits: { projects: 1, notShown: 0, watched: 1, fingerprintOnly: 0 },
    items: [{ ...activityItem([]), ...extra }] } }]])) as any).body.sections.activity;
  const kept = itemOf({ started: [started(0), started(1)], startedCount: 11 });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  const item = kept.data.items[0];
  assert.equal(item.startedCount, 11);
  assert.deepEqual(Object.keys(item.started[0]).sort(), ['createdAt', 'end', 'harness', 'model', 'phase', 'runId', 'startedBy', 'worktreeKey']);
  assert.equal(item.started[0].end, null, 'a core before 165 review B-4 sends no end: null');
  assert.deepEqual(item.started.map((s: any) => [s.runId, s.model, s.startedBy]), [['w-000000000000', null, 'console'], ['w-000000000001', 'claude-opus-5-5', 'device.d-0123456789ab']]);
  assert.equal(JSON.stringify(item).includes('planted'), false);
  assert.deepEqual([itemOf({}).data.items[0].started, itemOf({}).data.items[0].startedCount], [null, null]);
  assert.equal(itemOf({ started: Array.from({ length: 8 }, (_, n) => started(n)), startedCount: 8 }).ok, true);
  for (const bad of [{ started: Array.from({ length: 9 }, (_, n) => started(n)), startedCount: 9 }, { started: [{ ...started(0), phase: 'paused' }], startedCount: 1 }, { started: [{ ...started(0), runId: 'x' }], startedCount: 1 },
    { started: [started(0)], startedCount: -1 }, { started: [started(0)], startedCount: 1.5 }]) {
    assert.deepEqual(itemOf(bad), { ok: false, code: 'core-contract-mismatch' }, JSON.stringify(bad).slice(0, 80));
  }
});

test('165 review B-4: a started session of the machine list carries its end, { state, at } of the closed end states, null while open', () => {
  const started = (over: Record<string, unknown>) => ({ runId: 'w-000000000001', harness: 'codex', model: null, phase: 'ended', startedBy: 'manual', worktreeKey: WK, createdAt: '2026-11-15T10:00:00.000Z', ...over });
  const itemOf = (list: unknown[]) => (composeMachine(new Map([['activity', { exit: 0, json: { v: 1, limits: { projects: 1, notShown: 0, watched: 1, fingerprintOnly: 0 },
    items: [{ ...activityItem([]), started: list, startedCount: list.length }] } }]])) as any).body.sections.activity;
  const kept = itemOf([started({ end: { state: 'cancelled', at: '2026-11-15T10:05:00.000Z', reason: 'planted' } }), started({ runId: 'w-000000000002', phase: 'running', end: null })]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.items[0].started.map((s: any) => s.end), [{ state: 'cancelled', at: '2026-11-15T10:05:00.000Z' }, null]);
  for (const end of [{ state: 'paused', at: null }, { state: 'exited', at: 'yesterday' }, 'exited']) {
    assert.deepEqual(itemOf([started({ end })]), { ok: false, code: 'core-contract-mismatch' }, JSON.stringify(end));
  }
});

const reviewsOf = async (rows: unknown[]) => ((await composeLayers(WK, new Map([['reviews', { exit: 0, json: rows }]]), async () => ({ ok: false }))) as any).body.sections.reviews;

test('161 review C: an unreadable review keeps the core\'s reason (too-large); other rows carry none', async () => {
  const row = (over: any) => ({ worktreeKey: WK, feature: '161-live', ...over });
  const kept = await reviewsOf([row({ state: 'unreadable', reason: 'too-large' }), row({ feature: 'f2', state: 'unreadable' }), row({ feature: 'f3', state: 'absent' })]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.map((r: any) => r.reason ?? null), ['too-large', null, null]);
  assert.equal('reason' in kept.data[1], false, 'no reason key when the core sent none');
  assert.deepEqual(await reviewsOf([row({ state: 'unreadable', reason: 'not an id!' })]), { ok: false, code: 'core-contract-mismatch' });
});

// ---- 173 O-3: the handoff-prompt artifact kind ----

const artifactsOf = async (json: unknown) => ((await composeLayers(WK, new Map([['artifacts', { exit: 0, json }]]), async () => ({ ok: false }))) as any).body.sections.artifacts;

test('173 O-3: an artifact of kind handoff-prompt passes the closed kind set beside handoff; a kind outside it is still a contract mismatch', async () => {
  const item = (kind: string, fileKey: string) => ({ fileKey, kind, worktreeKey: WK, feature: null, dispatchId: 'd-0123456789ab', bytes: 2, at: '2026-11-15T09:00:00.000Z' });
  const kept = await artifactsOf([item('handoff-prompt', '2222222222222222'), item('handoff', '1111111111111111')]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.map((a: any) => [a.kind, a.dispatchId]), [['handoff-prompt', 'd-0123456789ab'], ['handoff', 'd-0123456789ab']]);
  assert.deepEqual(await artifactsOf([item('handoff-brief', '2222222222222222')]), { ok: false, code: 'core-contract-mismatch' });
});

// ---- 170 IC-004: the `channels` section ----

const channelItem = (over: Record<string, unknown> = {}) => ({
  runId: 'w-0123456789ab', agentKey: 'f1e2d3c4b5a69788', harness: 'pi', channel: 'open', reason: null, words: null,
  turn: { observed: true, state: 'working', since: '2026-11-17T09:00:00.000Z', seq: 4 }, sent: { count: 2, lastAt: '2026-11-17T09:01:00.000Z' },
  recent: [{ seq: 3, kind: 'follow-up', by: 'console', at: '2026-11-17T09:01:00.000Z', bytes: 41, outcome: 'written', answer: 'accepted' },
    { seq: 2, kind: 'steer', by: 'device.d-0a1b2c3d4e5f', at: '2026-11-17T09:00:30.000Z', bytes: 12, outcome: 'refused', answer: null }],
  ...over,
});
const channelsOf = async (json: unknown) => ((await composeLayers(WK, new Map([['channels', { exit: 0, json }]]), async () => ({ ok: false }))) as any).body.sections.channels;

test('170 IC-004: the layers member lists channels last; one that the core did not send is section-missing, and the others are unchanged', async () => {
  const member = (await composeLayers(WK, new Map(), async () => ({ ok: false }))) as any;
  assert.deepEqual(Object.keys(member.body.sections), ['checkouts', 'tree', 'runs', 'gates', 'artifacts', 'reviews', 'sessions', 'traffic', 'coverage', 'channels']);
  assert.deepEqual(member.body.sections.channels, { ok: false, code: 'section-missing' });
});

test('170 IC-004: a channels item keeps its closed fields; a field the core adds (a text, a pid) does not leave', async () => {
  const kept = await channelsOf({ v: 1, items: [channelItem({ text: 'planted text', pid: 4242 })] });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data, { v: 1, items: [channelItem()] });
  const planted = await channelsOf({ v: 1, items: [channelItem({ recent: [{ ...channelItem().recent[0], text: 'planted text' }] })] });
  assert.equal(JSON.stringify(planted).includes('planted text'), false);
  assert.deepEqual(Object.keys(planted.data.items[0].recent[0]).sort(), ['answer', 'at', 'by', 'bytes', 'kind', 'outcome', 'seq']);
});

test('170 IC-004: a channel without one keeps its reason and the descriptor sentence; a not-observed turn keeps its reason', async () => {
  const none = await channelsOf({ v: 1, items: [channelItem({ channel: 'none', reason: 'no-channel', words: 'no recorded capture shows an input mode', turn: { observed: false, reason: 'no-channel', since: null }, sent: { count: 0, lastAt: null }, recent: [] })] });
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.deepEqual([none.data.items[0].channel, none.data.items[0].reason, none.data.items[0].words, none.data.items[0].turn], ['none', 'no-channel', 'no recorded capture shows an input mode', { observed: false, reason: 'no-channel', since: null }]);
});

test('170 IC-004: a value outside the closed shape is a contract mismatch: a state, a kind, an answer, a turn, a run id, more than 16 items or 8 recent', async () => {
  const mismatch = { ok: false, code: 'core-contract-mismatch' };
  const recent = channelItem().recent[0];
  for (const bad of [
    channelItem({ channel: 'opening' }), channelItem({ runId: 'x' }), channelItem({ agentKey: 'nope' }), channelItem({ turn: { observed: true, state: 'idle', since: '2026-11-17T09:00:00.000Z', seq: 1 } }),
    channelItem({ turn: { observed: false, since: null } }), channelItem({ sent: { count: -1, lastAt: null } }), channelItem({ recent: [{ ...recent, kind: 'abort' }] }),
    channelItem({ recent: [{ ...recent, answer: 'ok' }] }), channelItem({ recent: [{ ...recent, at: 'yesterday' }] }), channelItem({ recent: Array.from({ length: 9 }, () => recent) }),
  ]) assert.deepEqual(await channelsOf({ v: 1, items: [bad] }), mismatch, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(await channelsOf({ v: 1, items: Array.from({ length: 17 }, () => channelItem()) }), mismatch);
  assert.deepEqual(await channelsOf({ v: 2, items: [] }), mismatch);
  assert.equal((await channelsOf({ v: 1, items: Array.from({ length: 16 }, () => channelItem()) })).ok, true);
});

test('170 IC-004: the sentence and the labels are masked, and an actor label that could be a place is withheld', async () => {
  const kept = await channelsOf({ v: 1, items: [channelItem({ channel: 'none', reason: 'no-channel', words: 'contact planted.person@example.com', recent: [{ ...channelItem().recent[0], by: '/work/planted' }] })] });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(JSON.stringify(kept).includes('planted.person@example.com'), false);
  assert.ok(JSON.stringify(kept).includes('<email>') || JSON.stringify(kept).includes('<masked>'));
  assert.equal(kept.data.items[0].recent[0].by, '(withheld)');
});
