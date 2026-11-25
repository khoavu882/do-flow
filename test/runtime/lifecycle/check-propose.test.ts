'use strict';

// 181 G.2 (IC-014, FR-001, FR-002, NFR-004): `proposeChecks` turns a cluster of open follow-ups that the same-issue rule
// flags into one check proposal with the five-rung ladder and its offered rung, shows an earlier decline instead of a new
// proposal, records `check.proposed` once under `record`, and gives the same answer for the same store.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../../helper/scratch-env.ts');
const followup = require('../../../src/runtime/lifecycle/followup.ts');
const store = require('../../../src/runtime/lifecycle/event-store.ts');
const { proposeChecks, proposalIdFor, KINDS } = require('../../../src/runtime/lifecycle/check-proposal.ts');

const scratch = createScratch('doflow-check-propose-');
before(() => scratch.apply());
after(() => { scratch.restore(); scratch.remove(); });

let counter = 0;
function plainRoot() {
  counter += 1;
  const dir = path.join(scratch.dir, `root-${counter}`);
  fs.mkdirSync(dir);
  return dir;
}
/** Files one at a time so each follow-up has its own, later creation time. */
function add(root: string, statements: string[]): string[] {
  return statements.map((statement) => followup.addFollowups({ root, cwd: root, items: [{ statement }], defaults: { source: 'manual', batch: false } }).created[0].id);
}
const eventFiles = (root: string) => { try { return fs.readdirSync(path.join(root, store.EVENTS_REL)); } catch { return []; } };
const detect = (...roles: string[]) => ({ commands: Object.fromEntries(roles.map((role) => [role, { role, command: `run ${role}` }])) });

const UPLOAD = ['The upload client retry loop ignores the server timeout header', 'Upload client retry loop ignores a timeout header from the server proxy'];
const LEDGER = ['Ledger lock is never released after a crash', 'Ledger lock never released after a crash in the worker'];

test('a recurring correction yields one proposal with a kind and a one-sentence reason', () => {
  const root = plainRoot();
  const ids = add(root, UPLOAD);
  const out = proposeChecks({ root, detection: detect('lint', 'test') });
  assert.deepEqual([out.ok, out.status, out.exitCode], [true, 'proposed', 0]);
  assert.equal(out.proposals.length, 1);
  const [proposal] = out.proposals;
  assert.match(proposal.id, /^CP-[0-9a-f]{6}$/);
  assert.equal(proposal.id, proposalIdFor(ids));
  assert.deepEqual(proposal.members, [...ids].sort());
  assert.equal(proposal.correction, UPLOAD[1], 'the newest member states the correction');
  assert.deepEqual(proposal.ladder.map((rung: any) => rung.kind), KINDS);
  assert.deepEqual(proposal.ladder.map((rung: any) => rung.available), [false, true, true, true, true]);
  assert.equal(proposal.ladder[0].reason, 'no typecheck command detected');
  assert.equal(proposal.offered, 'static-check');
  assert.match(proposal.offeredReason, /^no typecheck command detected, so static-check is the cheapest kind left: /);
  assert.equal(proposal.offeredReason.split(/[.!?](\s|$)/).length, 1, 'one sentence');
  assert.equal(proposal.declinedBefore, null);
});

test('the offered rung follows what verify detection finds', () => {
  const root = plainRoot();
  add(root, UPLOAD);
  const offered = (...roles: string[]) => proposeChecks({ root, detection: detect(...roles) }).proposals[0].offered;
  assert.equal(offered('typecheck', 'lint', 'test'), 'type-or-api');
  assert.equal(offered('lint'), 'static-check');
  assert.equal(offered('testTargeted'), 'test');
  assert.equal(offered(), 'advisory-hook');
});

test('one entry, or entries about different things, answer no-recurrence', () => {
  const root = plainRoot();
  add(root, [UPLOAD[0]]);
  assert.deepEqual(proposeChecks({ root, detection: detect() }), { ok: true, action: 'propose', status: 'no-recurrence', proposals: [], events: [], exitCode: 0 });
  add(root, [LEDGER[0]]);
  assert.equal(proposeChecks({ root, detection: detect() }).status, 'no-recurrence');
});

test('two clusters give two proposals, ordered by id', () => {
  const root = plainRoot();
  add(root, [...UPLOAD, ...LEDGER]);
  const out = proposeChecks({ root, detection: detect('lint') });
  assert.equal(out.proposals.length, 2);
  assert.deepEqual(out.proposals.map((p: any) => p.id), out.proposals.map((p: any) => p.id).sort());
});

test('two runs without record are byte-identical and write nothing', () => {
  const root = plainRoot();
  add(root, [...UPLOAD, ...LEDGER]);
  const before = eventFiles(root);
  const first = JSON.stringify(proposeChecks({ root, detection: detect('lint') }));
  const second = JSON.stringify(proposeChecks({ root, detection: detect('lint') }));
  assert.equal(first, second);
  assert.deepEqual(eventFiles(root), before);
});

test('record appends check.proposed once and answers already-proposed after', () => {
  const root = plainRoot();
  add(root, UPLOAD);
  const first = proposeChecks({ root, record: true, detection: detect('lint') });
  assert.equal(first.events.length, 1);
  const files = eventFiles(root);
  const event = JSON.parse(fs.readFileSync(path.join(root, first.events[0]), 'utf8'));
  assert.equal(event.type, 'check.proposed');
  assert.deepEqual(Object.keys(event.data).sort(), ['correction', 'ladder', 'members', 'offered', 'proposal']);
  assert.equal(event.data.proposal, first.proposals[0].id);

  const again = proposeChecks({ root, record: true, detection: detect('lint') });
  assert.equal(again.status, 'already-proposed');
  assert.equal(again.proposals[0].status, 'already-proposed');
  assert.equal(again.proposals[0].recorded.state, 'proposed');
  assert.deepEqual(again.events, []);
  assert.deepEqual(eventFiles(root), files, 'no second event');
});

test('a declined cluster shows the decline and its date, and is not proposed or recorded again', () => {
  const root = plainRoot();
  const ids = add(root, UPLOAD);
  const first = proposeChecks({ root, record: true, detection: detect('lint') });
  const id = first.proposals[0].id;
  const declined = store.appendEvents(root, [{ type: 'check.declined', by: 'user', data: { proposal: id, reason: 'review catches it' } }]);
  assert.equal(declined.ok, true);
  const files = eventFiles(root);

  const out = proposeChecks({ root, record: true, detection: detect('lint') });
  assert.equal(out.proposals.length, 1);
  assert.deepEqual(out.proposals[0].declinedBefore, { id, at: declined.written[0].event.at, reason: 'review catches it' });
  assert.equal(out.proposals[0].offered, null);
  assert.equal(out.proposals[0].status, 'declined-before');
  assert.deepEqual(eventFiles(root), files, 'a declined cluster is not recorded again');

  // A third report of the same thing joins the cluster: the members changed, the decline still shows.
  add(root, ['Upload client retry loop ignores the timeout header sent by the server']);
  const filed = eventFiles(root);
  const grown = proposeChecks({ root, record: true, detection: detect('lint') });
  assert.equal(grown.proposals[0].members.length, 3);
  assert.equal(grown.proposals[0].declinedBefore.id, id);
  assert.equal(grown.proposals[0].id === id, false);
  assert.ok(ids.every((member) => grown.proposals[0].members.includes(member)));
  assert.deepEqual(eventFiles(root), filed, 'the grown cluster is not recorded either');
});

test('--ids: exactly those items form the cluster; no flagged pair, a closed item and an unknown id are refused', () => {
  const root = plainRoot();
  const [a, b] = add(root, UPLOAD);
  const [c] = add(root, [LEDGER[0]]);
  const ok = proposeChecks({ root, ids: [a, b], detection: detect() });
  assert.deepEqual(ok.proposals[0].members, [a, b].sort());

  const unflagged = proposeChecks({ root, ids: [a, c], detection: detect() });
  assert.deepEqual([unflagged.ok, unflagged.finding, unflagged.exitCode], [false, 'no-flagged-pair', 1]);
  assert.equal(proposeChecks({ root, ids: [c], detection: detect() }).finding, 'no-flagged-pair');
  assert.equal(proposeChecks({ root, ids: [a, 'FU-zzzzzz'], detection: detect() }).finding, 'unknown-id');

  followup.settleFollowups({ root, ids: [b], as: 'dismissed', reason: 'duplicate' });
  const closed = proposeChecks({ root, ids: [a, b], detection: detect() });
  assert.deepEqual([closed.ok, closed.finding], [false, 'not-open']);
  assert.throws(() => proposeChecks({ root, ids: ['nope'] }), followup.FollowupUsageError);
});
