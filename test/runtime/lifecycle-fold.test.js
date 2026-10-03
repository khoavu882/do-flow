'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { foldEvents, applyEvent, newState, withDerivedDone } = require('../../src/runtime/lifecycle/fold');

let seq = 0;
/** An envelope at `at` (ISO), with a deterministic id. */
function ev(type, data, at, by = 'agent') {
  seq += 1;
  const stamp = new Date(at).toISOString().replace(/[-:.]/g, '');
  return { v: 1, id: `${stamp}-${String(seq).padStart(6, '0').replace(/0/g, 'a')}`, type, at: new Date(at).toISOString(), by, data };
}
const T = (n) => `2026-10-0${1 + Math.floor(n / 100)}T09:00:${String(n % 100).padStart(2, '0')}.000Z`;
const source = { kind: 'stage', feature: '046-lifecycle-loop', stage: 'review' };
const added = (id, at, extra = {}) => ev('followup.added', { id, statement: `item ${id}`, source, ...extra }, at);
const tracked = (slug, at) => ev('feature.tracked', { slug }, at);
const taken = (ids, feature, at) => ev('followup.taken', { ids, feature }, at);
const settled = (id, as, at, extra = {}) => ev('followup.settled', { id, as, ...extra }, at);

function itemOf(result, id) { return result.followups.find((i) => i.id === id); }

test('an added item is open with its source, date and history', () => {
  const r = foldEvents([added('FU-aaaaaa', T(1))]);
  const item = itemOf(r, 'FU-aaaaaa');
  assert.equal(item.state, 'open');
  assert.deepEqual(item.source, source);
  assert.equal(item.added, '2026-10-01');
  assert.equal(item.takenBy, null);
  assert.equal(item.intent, null);
  assert.equal(item.fix, null);
  assert.equal(item.body, null);
  assert.deepEqual(item.history.map((h) => [h.type, h.by]), [['followup.added', 'agent']]);
  assert.deepEqual(r.conflicts, []);
});

test('a second added for one id is a conflict and changes nothing', () => {
  const second = added('FU-aaaaaa', T(2), { statement: 'other' });
  const r = foldEvents([added('FU-aaaaaa', T(1)), second]);
  assert.equal(itemOf(r, 'FU-aaaaaa').statement, 'item FU-aaaaaa');
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual({ event: r.conflicts[0].event, type: r.conflicts[0].type }, { event: second.id, type: 'followup.added' });
  assert.match(r.conflicts[0].reason, /already added/);
});

test('take needs an open item and a tracked feature', () => {
  const ok = foldEvents([added('FU-aaaaaa', T(1)), tracked('f1', T(2)), taken(['FU-aaaaaa'], 'f1', T(3))]);
  assert.equal(itemOf(ok, 'FU-aaaaaa').state, 'taken');
  assert.equal(itemOf(ok, 'FU-aaaaaa').takenBy, 'f1');
  const untracked = foldEvents([added('FU-aaaaaa', T(1)), taken(['FU-aaaaaa'], 'f1', T(3))]);
  assert.equal(itemOf(untracked, 'FU-aaaaaa').state, 'open');
  assert.equal(untracked.conflicts[0].code, 'untracked-feature');
  const twice = foldEvents([added('FU-aaaaaa', T(1)), tracked('f1', T(2)), tracked('f2', T(2)), taken(['FU-aaaaaa'], 'f1', T(3)), taken(['FU-aaaaaa'], 'f2', T(4))]);
  assert.equal(itemOf(twice, 'FU-aaaaaa').takenBy, 'f1');
  assert.equal(twice.conflicts.length, 1);
  const unknown = foldEvents([tracked('f1', T(2)), taken(['FU-zzzzzz'], 'f1', T(3))]);
  assert.equal(unknown.conflicts[0].code, 'unknown-id');
});

test('one taken event with a good and a bad id applies the good one', () => {
  const r = foldEvents([added('FU-aaaaaa', T(1)), tracked('f1', T(2)), taken(['FU-aaaaaa', 'FU-bbbbbb'], 'f1', T(3))]);
  assert.equal(itemOf(r, 'FU-aaaaaa').state, 'taken');
  assert.equal(r.conflicts.length, 1);
});

test('settle as kept: reason required, releases a taken item, reopens a dismissed one, records on an open one', () => {
  const base = [added('FU-aaaaaa', T(1)), tracked('f1', T(2))];
  const released = foldEvents([...base, taken(['FU-aaaaaa'], 'f1', T(3)), settled('FU-aaaaaa', 'kept', T(4), { reason: 'not this feature' })]);
  assert.equal(itemOf(released, 'FU-aaaaaa').state, 'open');
  assert.equal(itemOf(released, 'FU-aaaaaa').takenBy, null);
  const reopened = foldEvents([...base, settled('FU-aaaaaa', 'dismissed', T(3), { reason: 'noise' }), settled('FU-aaaaaa', 'kept', T(4), { reason: 'real after all' })]);
  assert.equal(itemOf(reopened, 'FU-aaaaaa').state, 'open');
  const recorded = foldEvents([...base, settled('FU-aaaaaa', 'kept', T(3), { reason: 'later' })]);
  assert.equal(itemOf(recorded, 'FU-aaaaaa').state, 'open');
  assert.equal(itemOf(recorded, 'FU-aaaaaa').history.at(-1).type, 'followup.settled');
  // IC-003: no reason needed on an open item; one is needed to release a taken item or reopen a dismissed one.
  const openNoReason = foldEvents([...base, settled('FU-aaaaaa', 'kept', T(3))]);
  assert.deepEqual(openNoReason.conflicts, []);
  assert.equal(itemOf(openNoReason, 'FU-aaaaaa').history.length, 2);
  const takenNoReason = foldEvents([...base, taken(['FU-aaaaaa'], 'f1', T(3)), settled('FU-aaaaaa', 'kept', T(4))]);
  assert.equal(takenNoReason.conflicts[0].code, 'reason-required');
  assert.equal(itemOf(takenNoReason, 'FU-aaaaaa').state, 'taken');
  const dismissedNoReason = foldEvents([...base, settled('FU-aaaaaa', 'dismissed', T(3), { reason: 'x' }), settled('FU-aaaaaa', 'kept', T(4))]);
  assert.equal(dismissedNoReason.conflicts[0].code, 'reason-required');
  assert.equal(itemOf(dismissedNoReason, 'FU-aaaaaa').state, 'dismissed');
});

test('settle as dismissed needs an open item and a reason', () => {
  const base = [added('FU-aaaaaa', T(1)), tracked('f1', T(2))];
  assert.equal(itemOf(foldEvents([...base, settled('FU-aaaaaa', 'dismissed', T(3), { reason: 'x' })]), 'FU-aaaaaa').state, 'dismissed');
  assert.equal(foldEvents([...base, settled('FU-aaaaaa', 'dismissed', T(3))]).conflicts[0].code, 'reason-required');
  const fromTaken = foldEvents([...base, taken(['FU-aaaaaa'], 'f1', T(3)), settled('FU-aaaaaa', 'dismissed', T(4), { reason: 'x' })]);
  assert.equal(fromTaken.conflicts[0].code, 'illegal-transition');
  assert.equal(itemOf(fromTaken, 'FU-aaaaaa').state, 'taken');
  const twice = foldEvents([...base, settled('FU-aaaaaa', 'dismissed', T(3), { reason: 'x' }), settled('FU-aaaaaa', 'dismissed', T(4), { reason: 'y' })]);
  assert.equal(twice.conflicts.length, 1);
});

test('settle as fix names the route and keeps the item open; as done needs evidence and is final', () => {
  const base = [added('FU-aaaaaa', T(1))];
  const fix = foldEvents([...base, settled('FU-aaaaaa', 'fix', T(2), { reason: 'bug run fix-cart' })]);
  assert.equal(itemOf(fix, 'FU-aaaaaa').state, 'open');
  assert.equal(itemOf(fix, 'FU-aaaaaa').fix, 'bug run fix-cart');
  assert.equal(foldEvents([...base, settled('FU-aaaaaa', 'fix', T(2))]).conflicts[0].code, 'reason-required');
  assert.equal(foldEvents([...base, settled('FU-aaaaaa', 'done', T(2))]).conflicts[0].code, 'evidence-required');
  const done = foldEvents([...base, settled('FU-aaaaaa', 'done', T(2), { evidence: 'commit abc' }), settled('FU-aaaaaa', 'kept', T(3), { reason: 'again' })]);
  assert.equal(itemOf(done, 'FU-aaaaaa').state, 'done');
  assert.equal(done.conflicts.length, 1);
  assert.match(done.conflicts[0].reason, /accepts no later event/);
});

test('promote sets the intent once and only from open', () => {
  const base = [added('FU-aaaaaa', T(1)), tracked('f1', T(2))];
  const ok = foldEvents([...base, ev('followup.promoted', { ids: ['FU-aaaaaa'], intent: 'agent-docs/intent/a.md' }, T(3))]);
  assert.equal(itemOf(ok, 'FU-aaaaaa').intent, 'agent-docs/intent/a.md');
  assert.equal(itemOf(ok, 'FU-aaaaaa').state, 'open');
  const again = foldEvents([...base, ev('followup.promoted', { ids: ['FU-aaaaaa'], intent: 'a' }, T(3)), ev('followup.promoted', { ids: ['FU-aaaaaa'], intent: 'b' }, T(4))]);
  assert.equal(again.conflicts[0].code, 'intent-exists');
  assert.equal(itemOf(again, 'FU-aaaaaa').intent, 'a');
  const fromTaken = foldEvents([...base, taken(['FU-aaaaaa'], 'f1', T(3)), ev('followup.promoted', { ids: ['FU-aaaaaa'], intent: 'a' }, T(4))]);
  assert.equal(fromTaken.conflicts[0].code, 'illegal-transition');
});

test('the fold is ordered by at then id, whatever order the files are read in', () => {
  const a = added('FU-aaaaaa', T(1));
  const t = tracked('f1', T(2));
  const k = taken(['FU-aaaaaa'], 'f1', T(3));
  const forward = foldEvents([a, t, k]);
  const shuffled = foldEvents([k, a, t]);
  assert.deepEqual(shuffled, forward);
  assert.equal(itemOf(shuffled, 'FU-aaaaaa').state, 'taken');
  // Same instant: the id breaks the tie, so a tracked event with the smaller id applies first.
  const sameAt = T(5);
  const t2 = { ...tracked('f2', sameAt), id: '20261001T090005000Z-aaaaaa' };
  const k2 = { ...taken(['FU-aaaaaa'], 'f2', sameAt), id: '20261001T090005000Z-bbbbbb' };
  assert.equal(itemOf(foldEvents([k2, a, t2]), 'FU-aaaaaa').state, 'taken');
  const wrong = { ...k2, id: '20261001T090005000Z-000000' };
  assert.equal(foldEvents([wrong, a, t2]).conflicts[0].code, 'untracked-feature');
});

test('the earliest tracking event counts and a repeat is not a conflict', () => {
  const r = foldEvents([tracked('f1', T(5)), tracked('f1', T(2)), tracked('f1', T(9))]);
  assert.equal(r.features.length, 1);
  assert.equal(r.features[0].trackedAt, new Date(T(2)).toISOString());
  assert.deepEqual(r.conflicts, []);
});

test('an unknown event type is skipped without a conflict', () => {
  const r = foldEvents([ev('future.thing', { x: 1 }, T(1)), added('FU-aaaaaa', T(2))]);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.followups.length, 1);
});

test('a malformed event of a known type is a conflict, not an exception', () => {
  const r = foldEvents([ev('followup.added', {}, T(1)), ev('followup.taken', { ids: [] }, T(2)), ev('goal.added', { goal: 'g' }, T(3)), ev('feature.tracked', {}, T(4))]);
  assert.equal(r.conflicts.length, 4);
  assert.ok(r.conflicts.every((c) => c.code === 'malformed'));
});

test('goals: first goal.added wins, items, checks and done', () => {
  const g1 = ev('goal.added', { goal: 'api-v2', outcome: 'v2 works', items: [{ id: 'C1', text: 'one' }, { id: 'C2', text: 'two' }] }, T(1));
  const g2 = ev('goal.added', { goal: 'api-v2', outcome: 'other', items: [{ id: 'C1', text: 'x' }] }, T(2));
  const r = foldEvents([g1, g2,
    ev('goal.item-added', { goal: 'api-v2', item: { id: 'C3', text: 'three' } }, T(3)),
    ev('goal.item-added', { goal: 'api-v2', item: { id: 'C3', text: 'dup' } }, T(4)),
    ev('goal.checked', { goal: 'api-v2', item: 'C1', met: true, evidence: '047' }, T(5)),
    ev('goal.checked', { goal: 'api-v2', item: 'C1', met: false, evidence: 'regressed' }, T(6)),
    ev('goal.checked', { goal: 'api-v2', item: 'C2', met: true, evidence: 'tests' }, T(7)),
    ev('goal.checked', { goal: 'api-v2', item: 'C9', met: true, evidence: 'x' }, T(8)),
    ev('goal.checked', { goal: 'nope', item: 'C1', met: true, evidence: 'x' }, T(9)),
    ev('goal.done', { goal: 'api-v2', reason: 'closed by user' }, T(10)),
  ]);
  const goal = r.goals[0];
  assert.equal(goal.outcome, 'v2 works');
  assert.deepEqual(goal.items.map((i) => [i.id, i.met, i.evidence]), [['C1', false, 'regressed'], ['C2', true, 'tests'], ['C3', false, null]]);
  assert.equal(goal.status, 'done');
  assert.equal(goal.reason, 'closed by user');
  assert.deepEqual(r.conflicts.map((c) => c.code), ['goal-exists', 'illegal-transition', 'unknown-item', 'unknown-goal']);
});

test('goal links: tracked feature only, one goal at most, replace replaces', () => {
  const goals = [ev('goal.added', { goal: 'g1', outcome: 'o', items: [{ id: 'C1', text: 't' }] }, T(1)), ev('goal.added', { goal: 'g2', outcome: 'o', items: [{ id: 'C1', text: 't' }] }, T(2))];
  const link = (goal, slug, replace, at) => ev('goal.linked', { goal, slug, replace }, at);
  const r = foldEvents([...goals, link('g1', 'f1', false, T(3)), tracked('f1', T(4)), link('g1', 'f1', false, T(5)), link('g2', 'f1', false, T(6)), link('g2', 'f1', true, T(7)), link('nope', 'f1', false, T(8))]);
  assert.deepEqual(r.conflicts.map((c) => c.code), ['untracked-feature', 'goal-already-linked', 'unknown-goal']);
  assert.equal(r.features[0].goal, 'g2');
  // Linking the same goal again is not a conflict.
  const same = foldEvents([...goals, tracked('f1', T(3)), link('g1', 'f1', false, T(4)), link('g1', 'f1', false, T(5))]);
  assert.deepEqual(same.conflicts, []);
});

test('release records: union per tag, excluded wins, entries kept once', () => {
  const rec = (features, excluded, at, commit = 'abc') => ev('release.recorded', { tag: 'v1.14.0', commit, features, excluded }, at);
  const r = foldEvents([
    rec([{ slug: 'a', evidence: 'branch', ref: 'feat/a' }, { slug: 'b', evidence: 'merge-subject', ref: 'x1' }], [], T(1)),
    rec([{ slug: 'c', evidence: 'confirmed', ref: null }, { slug: 'a', evidence: 'other', ref: 'dup' }], ['b'], T(2), 'def'),
    ev('release.recorded', { tag: 'v1.15.0', commit: 'z', features: [{ slug: 'd', evidence: 'branch', ref: 'r' }], excluded: [] }, T(3)),
  ]);
  assert.equal(r.releases.length, 2);
  const first = r.releases.find((x) => x.tag === 'v1.14.0');
  assert.deepEqual(first.features.map((f) => f.slug), ['a', 'c']);
  assert.equal(first.features[0].ref, 'feat/a');
  assert.deepEqual(first.excluded, ['b']);
  assert.equal(first.commit, 'def');
  assert.deepEqual(r.conflicts, []);
});

test('merged confirmations are folded by slug, first one wins', () => {
  const r = foldEvents([ev('feature.merged', { slug: 'a', reason: 'fast-forwarded' }, T(1)), ev('feature.merged', { slug: 'a', reason: 'again' }, T(2))]);
  assert.deepEqual(r.merged.map((m) => [m.slug, m.reason]), [['a', 'fast-forwarded']]);
});

test('report items show whether the body is on this machine', () => {
  const report = added('FU-rrrrrr', T(1), { source: { kind: 'report', release: 'v1' }, excerpt: 'x', bodyRef: 'local:FU-rrrrrr', bodyBytes: 12 });
  const away = foldEvents([report]);
  assert.equal(itemOf(away, 'FU-rrrrrr').body, 'not-on-this-machine');
  assert.equal(itemOf(away, 'FU-rrrrrr').excerpt, 'x');
  const here = foldEvents([report], { hasBody: (item) => item.bodyRef === 'local:FU-rrrrrr' });
  assert.equal(itemOf(here, 'FU-rrrrrr').body, 'on-this-machine');
});

test('withDerivedDone shows a taken item done only while its feature derives finished', () => {
  const r = foldEvents([added('FU-aaaaaa', T(1)), added('FU-bbbbbb', T(1)), tracked('f1', T(2)), tracked('f2', T(2)), taken(['FU-aaaaaa'], 'f1', T(3)), taken(['FU-bbbbbb'], 'f2', T(3))]);
  const done = withDerivedDone(r.followups, { f1: 'finished', f2: 'in-progress' });
  assert.deepEqual(done.map((i) => i.state), ['done', 'taken']);
  assert.equal(done[0].derived, true);
  assert.deepEqual(withDerivedDone(r.followups, new Map([['f1', 'awaiting-release']])).map((i) => i.state), ['taken', 'taken']);
  assert.equal(r.followups[0].state, 'taken', 'the fold result is not mutated');
});

test('applyEvent reports what a write would conflict on, so a writer can refuse first', () => {
  const state = newState();
  assert.deepEqual(applyEvent(state, added('FU-aaaaaa', T(1))), []);
  const raised = applyEvent(state, taken(['FU-aaaaaa'], 'f1', T(2)));
  assert.equal(raised[0].code, 'untracked-feature');
  assert.equal(state.items.get('FU-aaaaaa').state, 'open');
});
