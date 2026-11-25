'use strict';

// 181 G.1 (IC-016, data-model section 3): the check.* events fold into a `checks` map keyed by proposal id, and the four
// moves the lifecycle forbids are refused by the store with `illegal-transition`, writing nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { foldEvents } = require('../../../src/runtime/lifecycle/fold.ts');
const { appendEvents, EVENTS_REL } = require('../../../src/runtime/lifecycle/event-store.ts');

const ID = 'CP-a1b2c3';
const LADDER = [{ kind: 'type-or-api', available: false, reason: 'no typecheck command detected' }, { kind: 'static-check', available: true, reason: '' }];
const proposed = { proposal: ID, members: ['FU-aaaaaa', 'FU-bbbbbb'], correction: 'Do not call fetch directly', offered: 'static-check', ladder: LADDER };
const accepted = { proposal: ID, kind: 'static-check', alternative: 'the http client', message: 'Do not call fetch directly. Use the http client instead.' };
const draft = (type: string, data: any) => ({ type, by: 'agent', data });
const MOVES: Record<string, any> = {
  proposed: draft('check.proposed', proposed),
  accepted: draft('check.accepted', accepted),
  declined: draft('check.declined', { proposal: ID, reason: 'the team prefers review' }),
  built: draft('check.built', { proposal: ID, path: 'eslint/no-fetch.js' }),
};

let seq = 0;
/** Envelopes for the given moves, one second apart. */
function envelopes(...names: string[]) {
  return names.map((name) => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 10, 25, 9, 0, seq)).toISOString();
    return { v: 1, id: `${at.replace(/[-:.]/g, '')}-aaaaa${seq % 10}`, at, by: 'agent', type: MOVES[name].type, data: MOVES[name].data };
  });
}

test('legal moves fold: proposed, then accepted, then built', () => {
  const proposedOnly = foldEvents(envelopes('proposed'));
  assert.deepEqual(proposedOnly.conflicts, []);
  assert.equal(proposedOnly.checks[ID].state, 'proposed');
  assert.deepEqual(proposedOnly.checks[ID].members, ['FU-aaaaaa', 'FU-bbbbbb']);
  assert.equal(proposedOnly.checks[ID].offered, 'static-check');

  const acc = foldEvents(envelopes('proposed', 'accepted')).checks[ID];
  assert.equal(acc.state, 'accepted');
  assert.deepEqual([acc.kind, acc.alternative, acc.message, acc.reason], ['static-check', 'the http client', accepted.message, null]);

  const built = foldEvents(envelopes('proposed', 'accepted', 'built'));
  assert.deepEqual(built.conflicts, []);
  assert.equal(built.checks[ID].state, 'built');
  assert.equal(built.checks[ID].checkPath, 'eslint/no-fetch.js');
  assert.deepEqual(built.checks[ID].history.map((h: any) => h.type), ['check.proposed', 'check.accepted', 'check.built']);
});

test('a below-offered accept keeps its reason; a decline keeps its reason', () => {
  const below = { ...accepted, kind: 'test', reason: 'no lint rule can see this' };
  seq += 1;
  const events = [...envelopes('proposed'), { ...envelopes('accepted')[0], data: below }];
  assert.equal(foldEvents(events).checks[ID].reason, 'no lint rule can see this');
  const declined = foldEvents(envelopes('proposed', 'declined')).checks[ID];
  assert.deepEqual([declined.state, declined.reason], ['declined', 'the team prefers review']);
});

test('the four forbidden moves are conflicts and leave the state unchanged', () => {
  const cases: Array<[string, string[], string]> = [
    ['proposed to built', ['proposed', 'built'], 'proposed'],
    ['declined to accepted', ['proposed', 'declined', 'accepted'], 'declined'],
    ['built to anything', ['proposed', 'accepted', 'built', 'declined'], 'built'],
    ['accepted to declined', ['proposed', 'accepted', 'declined'], 'accepted'],
  ];
  for (const [label, moves, finalState] of cases) {
    const result = foldEvents(envelopes(...moves));
    assert.equal(result.conflicts.length, 1, label);
    assert.equal(result.conflicts[0].code, 'illegal-transition', label);
    assert.equal(result.checks[ID].state, finalState, label);
  }
  assert.equal(foldEvents(envelopes('proposed', 'accepted', 'built', 'accepted')).conflicts[0].code, 'illegal-transition');
  assert.equal(foldEvents(envelopes('proposed', 'proposed')).conflicts[0].code, 'illegal-transition');
});

test('an event for an unknown proposal is a conflict and creates nothing', () => {
  const result = foldEvents(envelopes('accepted'));
  assert.equal(result.conflicts[0].code, 'unknown-id');
  assert.deepEqual(result.checks, {});
});

test('the store refuses an illegal move with illegal-transition and writes nothing', (t: any) => {
  const root = tempDir(t, 'doflow-check-events-');
  const files = () => { try { return fs.readdirSync(path.join(root, EVENTS_REL)); } catch { return []; } };
  assert.equal(appendEvents(root, [MOVES.proposed]).ok, true);
  const before = files();
  assert.equal(before.length, 1);

  const refused = appendEvents(root, [MOVES.built]);
  assert.equal(refused.ok, false);
  assert.equal(refused.finding, 'illegal-transition');
  assert.deepEqual(files(), before);

  assert.equal(appendEvents(root, [MOVES.accepted]).ok, true);
  const afterAccept = files();
  const declined = appendEvents(root, [MOVES.declined]);
  assert.equal(declined.finding, 'illegal-transition');
  assert.deepEqual(files(), afterAccept);

  // One legal and one illegal draft in one call: all or nothing.
  const mixed = appendEvents(root, [MOVES.built, MOVES.declined]);
  assert.equal(mixed.finding, 'illegal-transition');
  assert.deepEqual(files(), afterAccept);
});
