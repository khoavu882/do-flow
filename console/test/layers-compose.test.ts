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
